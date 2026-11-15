-- 132 Service charge as its own kind of charge, apart from tax (prototype/handoff: a hotel's service charge must not land in "tax collected").
--
-- tax_rules.kind: 'tax' (every existing rule) or 'service_charge'. Chosen when the rule is added and never edited (a trigger refuses a
-- change), like the basis. A service charge rule works only on nights: basis percent or fixed_per_night (not per stay), and never
-- applies_to_charges (extras on a folio carry no service charge). It still orders and compounds with the other rules exactly as before,
-- so a hotel can charge 10% service first and VAT on top of it.
--
-- Money is NOT changed anywhere: a night's tax_minor, a reservation's tax_minor and total_minor, invoices and payments all still include
-- the service charge, because calc_night_tax still adds up every rule. What is new is the split. reservation_nights.service_minor
-- records how much of a night's tax_minor is service charge ("of which", like stay_tax_minor), so every screen that shows Tax can show
-- Tax and Service charge as two lines whose sum is the old number.
--
-- service_minor is set by a trigger, so none of the ~15 functions that write nights had to change:
--   * insert, or an update that changes the rate, the night, or the tax without the stay levy: worked out by calc_night_service from the
--     rules in force on that night, the same walk calc_night_tax does, and never more than tax_minor less the stay levy;
--   * any other update (the levy moving, a status change): kept as it is, only clamped to what the tax still allows.
-- Nights booked before this migration have 0, which is right: no service charge rule can exist before it.
-- A service charge rule's later edits (rate, dates) change future prices only, as for tax: a booking keeps what it was made with.

alter table tax_rules add column kind text not null default 'tax' check (kind in ('tax', 'service_charge'));
alter table tax_rules add constraint tax_rules_service_nights_only
  check (kind = 'tax' or (basis in ('percent', 'fixed_per_night') and not applies_to_charges));

create function tax_rules_kind_fixed() returns trigger language plpgsql as $$
begin
  if new.kind is distinct from old.kind then raise exception 'tax_rules_kind_fixed' using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger tax_rules_kind_fixed before update on tax_rules for each row execute function tax_rules_kind_fixed();

drop trigger tax_rules_audit on tax_rules;
create trigger tax_rules_audit after insert or update or delete on tax_rules
  for each row execute function audit_setup_row('tax_rule',
    'name,kind,basis,rate_value,sequence,compounds,effective_from,effective_to,status,applies_to_charges');

alter table reservation_nights add column service_minor bigint not null default 0 check (service_minor >= 0);

-- The part of calc_night_tax that comes from service charge rules (same walk, same compounding, same rounding).
create function calc_night_service(p_property uuid, p_night date, p_rate bigint) returns bigint
language plpgsql stable security definer set search_path = public as $$
declare r record; running numeric := p_rate; total bigint := 0; t bigint;
begin
  for r in
    select * from tax_rules
     where property_id = p_property and status = 'active' and basis in ('percent', 'fixed_per_night')
       and effective_from <= p_night and (effective_to is null or effective_to >= p_night)
     order by sequence, id
  loop
    if r.basis = 'percent' then
      t := round((case when r.compounds then running else p_rate end) * r.rate_value / 100)::bigint;
    else
      t := round(r.rate_value)::bigint;
    end if;
    running := running + t;
    if r.kind = 'service_charge' then total := total + t; end if;
  end loop;
  return total;
end $$;
revoke all on function calc_night_service(uuid, date, bigint) from public, anon, authenticated;

create function set_night_service() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_property uuid; v_room bigint;
begin
  v_room := greatest(new.tax_minor - new.stay_tax_minor, 0);
  if tg_op = 'INSERT'
     or new.rate_minor is distinct from old.rate_minor or new.night_date is distinct from old.night_date
     or (new.tax_minor - new.stay_tax_minor) is distinct from (old.tax_minor - old.stay_tax_minor) then
    select property_id into v_property from reservation_rooms where id = new.reservation_room_id;
    new.service_minor := least(greatest(calc_night_service(v_property, new.night_date, new.rate_minor), 0), v_room);
  else
    new.service_minor := least(old.service_minor, v_room);
  end if;
  return new;
end $$;
revoke all on function set_night_service() from public, anon, authenticated;
create trigger reservation_nights_service before insert or update on reservation_nights
  for each row execute function set_night_service();

-- Invoices (the room invoice, issued in nine places) carry the split too, as a snapshot at issue like their other amounts:
-- invoices.service_minor is the part of invoices.tax_minor that is service charge, taken by a trigger from the reservation's nights as
-- they are when the invoice row is written, and never more than the invoice's tax. Invoices issued before this migration have 0.
alter table invoices add column service_minor bigint not null default 0 check (service_minor >= 0);

create function set_invoice_service() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_service bigint;
begin
  select coalesce(sum(n.service_minor), 0) into v_service
    from reservation_nights n join reservation_rooms rr on rr.id = n.reservation_room_id
   where rr.reservation_id = new.reservation_id;
  new.service_minor := least(v_service, new.tax_minor);
  return new;
end $$;
revoke all on function set_invoice_service() from public, anon, authenticated;
create trigger invoices_service before insert on invoices for each row execute function set_invoice_service();

-- The daily report keeps tax and service charge apart (the reports screen and the CSV): room_tax_minor is now the tax only, and the new
-- last column room_service_minor is the service charge on the nights. The two add up to what room_tax_minor was; with no service charge
-- rules nothing differs. (Returned columns cannot change in place, so the function is dropped and made again with the same grants.)
drop function daily_report(uuid, date, date);
create function daily_report(p_property uuid, p_from date, p_to date)
returns table (
  day date, rooms_available integer, rooms_sold integer,
  room_revenue_minor bigint, room_tax_minor bigint, extras_minor bigint, extras_tax_minor bigint,
  cash_in_minor bigint, refunds_paid_minor bigint, room_service_minor bigint
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
    select n.night_date as d, count(*)::integer as sold, sum(n.rate_minor)::bigint as rate, sum(n.tax_minor - n.service_minor)::bigint as tax, sum(n.service_minor)::bigint as service
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
         coalesce(extras.net, 0), coalesce(extras.tax, 0), coalesce(received.amt, 0), coalesce(paid_out.amt, 0), coalesce(nights.service, 0)
    from days
    left join nights on nights.d = days.d left join extras on extras.d = days.d
    left join received on received.d = days.d left join paid_out on paid_out.d = days.d
   order by days.d;
end $$;

revoke all on function daily_report(uuid, date, date) from public, anon;
grant execute on function daily_report(uuid, date, date) to authenticated;
