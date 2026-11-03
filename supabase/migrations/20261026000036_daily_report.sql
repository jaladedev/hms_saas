-- 036 Daily money and revenue report.
--
-- daily_report(property, from, to) answers two questions for each day of a property, in the property's own timezone:
--   MONEY IN AND OUT, by the day it happened:
--     received  payments (succeeded) by received_at, plus folio payments (succeeded), split by how it arrived:
--               online (a provider such as Paystack), cash, bank_transfer, pos, other (desk payments, folio ones included)
--     refunded  refunds that have been paid out (succeeded), by completed_at
--     net       received minus refunded
--   WHAT WAS EARNED, by the night or day it belongs to:
--     room revenue and its tax   the nights of bookings that are confirmed, checked in or checked out, by night_date.
--                                 Future nights count as booked, not yet earned. Pending holds, cancelled, expired and
--                                 no_show bookings add nothing here.
--     extras and their tax       posted folio charges (not voided), by charge_date
--     cancellation charges       the charge of a cancelled booking, by the day it was cancelled (tax is inside the charge)
--
-- A payment that was later reversed is not counted at all (only succeeded payments are). The report sums amounts as they
-- are stored, one currency per property. Reading needs report.view at the property (owner and accountant); anyone else,
-- and another hotel's people, get NOT_FOUND. A range is at most 92 days.
--
-- Errors: NOT_FOUND, POLICY_VIOLATION: range (missing dates, to before from, or more than 92 days).

create function daily_report(p_property_id uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tz text; v_cur text; v_days jsonb; v_totals jsonb;
begin
  if p_property_id is null or not has_permission(p_property_id, 'report.view') then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 91 then
    raise exception 'POLICY_VIOLATION: range' using errcode = 'P0001';
  end if;
  select timezone, currency into v_tz, v_cur from properties where id = p_property_id;

  with d as (select g::date as day from generate_series(p_from, p_to, interval '1 day') g),
  pay as (
    select (received_at at time zone v_tz)::date as day,
           case when payment_provider <> 'manual' then 'online' when payment_method in ('cash', 'bank_transfer', 'pos') then payment_method else 'other' end as ch,
           amount_minor
      from payments where property_id = p_property_id and payment_status = 'succeeded'
       and (received_at at time zone v_tz)::date between p_from and p_to
    union all
    select (received_at at time zone v_tz)::date,
           case when payment_method in ('cash', 'bank_transfer', 'pos') then payment_method else 'other' end,
           amount_minor
      from folio_payments where property_id = p_property_id and payment_status = 'succeeded'
       and (received_at at time zone v_tz)::date between p_from and p_to
  ),
  pay_d as (
    select day,
           coalesce(sum(amount_minor) filter (where ch = 'online'), 0) as online,
           coalesce(sum(amount_minor) filter (where ch = 'cash'), 0) as cash,
           coalesce(sum(amount_minor) filter (where ch = 'bank_transfer'), 0) as bank_transfer,
           coalesce(sum(amount_minor) filter (where ch = 'pos'), 0) as pos,
           coalesce(sum(amount_minor) filter (where ch = 'other'), 0) as other
      from pay group by day
  ),
  ref_d as (
    select (completed_at at time zone v_tz)::date as day, sum(amount_minor) as refunded
      from refunds where property_id = p_property_id and refund_status = 'succeeded' and completed_at is not null
       and (completed_at at time zone v_tz)::date between p_from and p_to
     group by 1
  ),
  room_d as (
    select n.night_date as day, sum(n.rate_minor) as room, sum(n.tax_minor) as room_tax
      from reservation_nights n
      join reservation_rooms rr on rr.id = n.reservation_room_id
      join reservations r on r.id = rr.reservation_id
     where r.property_id = p_property_id and r.reservation_status in ('confirmed', 'checked_in', 'checked_out')
       and n.night_date between p_from and p_to
     group by 1
  ),
  extra_d as (
    select charge_date as day, sum(total_minor - tax_minor) as extras, sum(tax_minor) as extras_tax
      from folio_charges where property_id = p_property_id and status = 'posted' and charge_date between p_from and p_to
     group by 1
  ),
  canc_d as (
    select (cancelled_at at time zone v_tz)::date as day, sum(cancellation_charge_minor) as cancellation
      from reservations where property_id = p_property_id and reservation_status = 'cancelled' and cancellation_charge_minor > 0
       and (cancelled_at at time zone v_tz)::date between p_from and p_to
     group by 1
  ),
  rows_ as (
    select d.day,
           coalesce(p.online, 0) as online, coalesce(p.cash, 0) as cash, coalesce(p.bank_transfer, 0) as bank_transfer,
           coalesce(p.pos, 0) as pos, coalesce(p.other, 0) as other,
           coalesce(p.online + p.cash + p.bank_transfer + p.pos + p.other, 0) as received,
           coalesce(f.refunded, 0) as refunded,
           coalesce(p.online + p.cash + p.bank_transfer + p.pos + p.other, 0) - coalesce(f.refunded, 0) as net,
           coalesce(rm.room, 0) as room, coalesce(rm.room_tax, 0) as room_tax,
           coalesce(x.extras, 0) as extras, coalesce(x.extras_tax, 0) as extras_tax,
           coalesce(c.cancellation, 0) as cancellation
      from d
      left join pay_d p on p.day = d.day left join ref_d f on f.day = d.day left join room_d rm on rm.day = d.day
      left join extra_d x on x.day = d.day left join canc_d c on c.day = d.day
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', day, 'online_minor', online, 'cash_minor', cash, 'bank_transfer_minor', bank_transfer, 'pos_minor', pos, 'other_minor', other,
           'received_minor', received, 'refunded_minor', refunded, 'net_minor', net,
           'room_revenue_minor', room, 'room_tax_minor', room_tax, 'extras_minor', extras, 'extras_tax_minor', extras_tax,
           'cancellation_charges_minor', cancellation) order by day), '[]'::jsonb),
         jsonb_build_object(
           'online_minor', coalesce(sum(online), 0), 'cash_minor', coalesce(sum(cash), 0), 'bank_transfer_minor', coalesce(sum(bank_transfer), 0),
           'pos_minor', coalesce(sum(pos), 0), 'other_minor', coalesce(sum(other), 0),
           'received_minor', coalesce(sum(received), 0), 'refunded_minor', coalesce(sum(refunded), 0), 'net_minor', coalesce(sum(net), 0),
           'room_revenue_minor', coalesce(sum(room), 0), 'room_tax_minor', coalesce(sum(room_tax), 0),
           'extras_minor', coalesce(sum(extras), 0), 'extras_tax_minor', coalesce(sum(extras_tax), 0),
           'cancellation_charges_minor', coalesce(sum(cancellation), 0))
    into v_days, v_totals
    from rows_;

  return jsonb_build_object('property_id', p_property_id, 'currency', v_cur, 'timezone', v_tz, 'from', p_from, 'to', p_to,
                            'days', v_days, 'totals', v_totals);
end $$;

revoke all on function daily_report(uuid, date, date) from public, anon;
grant execute on function daily_report(uuid, date, date) to authenticated;
