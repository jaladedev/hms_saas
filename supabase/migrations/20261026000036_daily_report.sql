-- 036 daily_report: one row per day for a property, for the reports screen.
--
-- Two views of money, kept apart because the hotel has not chosen which comes first (TODO, decisions):
--   earned  room_revenue_minor (nights sold, before tax) + extras_minor (posted folio charges, before tax)
--   cash    cash_in_minor (manual and provider payments plus folio payments, not reversed) less refunds_paid_minor
-- Nights count only on stays that are confirmed, checked in or checked out, on rooms not cancelled. Pending holds,
-- cancelled, expired and no-show stays are left out (no-show settlement is still undecided). Dates are the hotel's
-- own: a payment received at 23:30 in Ibadan counts on that day. One currency is assumed (NGN); rows in another
-- currency are left out rather than added to naira.
-- Needs report.view at the property; anyone else gets NOT_FOUND, as for a property they cannot see.
create function daily_report(p_property uuid, p_from date, p_to date)
returns table (
  day date, rooms_available integer, rooms_sold integer,
  room_revenue_minor bigint, room_tax_minor bigint, extras_minor bigint, extras_tax_minor bigint,
  cash_in_minor bigint, refunds_paid_minor bigint
) language plpgsql stable security definer set search_path = public as $$
declare v_tz text; v_avail integer;
begin
  perform require_permission(p_property, 'report.view', 'NOT_FOUND');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'POLICY_VIOLATION: report range' using errcode = 'P0001';
  end if;
  select timezone into v_tz from properties where id = p_property;
  select count(*) into v_avail from rooms where property_id = p_property and operational_status = 'active';

  return query
  with days as (select d::date as d from generate_series(p_from, p_to, interval '1 day') d),
  nights as (
    select n.night_date as d, count(*)::integer as sold, sum(n.rate_minor)::bigint as rate, sum(n.tax_minor)::bigint as tax
      from reservation_nights n
      join reservation_rooms rr on rr.id = n.reservation_room_id
      join reservations r on r.id = rr.reservation_id
     where r.property_id = p_property and r.currency = 'NGN'
       and r.reservation_status in ('confirmed', 'checked_in', 'checked_out') and rr.room_status <> 'cancelled'
       and n.night_date between p_from and p_to
     group by n.night_date),
  extras as (
    select c.charge_date as d, sum(c.total_minor - c.tax_minor)::bigint as net, sum(c.tax_minor)::bigint as tax
      from folio_charges c
     where c.property_id = p_property and c.status = 'posted' and c.currency = 'NGN' and c.charge_date between p_from and p_to
     group by c.charge_date),
  received as (
    select (x.at at time zone v_tz)::date as d, sum(x.amt)::bigint as amt
      from (select received_at as at, amount_minor as amt from payments
             where property_id = p_property and payment_status = 'succeeded' and currency = 'NGN'
            union all
            select received_at, amount_minor from folio_payments
             where property_id = p_property and payment_status = 'succeeded' and currency = 'NGN') x
     where (x.at at time zone v_tz)::date between p_from and p_to
     group by 1),
  paid_out as (
    select (f.completed_at at time zone v_tz)::date as d, sum(f.amount_minor)::bigint as amt
      from refunds f
     where f.property_id = p_property and f.refund_status = 'succeeded' and f.currency = 'NGN' and f.completed_at is not null
       and (f.completed_at at time zone v_tz)::date between p_from and p_to
     group by 1)
  select days.d, v_avail, coalesce(nights.sold, 0), coalesce(nights.rate, 0), coalesce(nights.tax, 0),
         coalesce(extras.net, 0), coalesce(extras.tax, 0), coalesce(received.amt, 0), coalesce(paid_out.amt, 0)
    from days
    left join nights on nights.d = days.d left join extras on extras.d = days.d
    left join received on received.d = days.d left join paid_out on paid_out.d = days.d
   order by days.d;
end $$;

revoke all on function daily_report(uuid, date, date) from public, anon;
grant execute on function daily_report(uuid, date, date) to authenticated;
