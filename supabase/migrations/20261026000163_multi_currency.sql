-- 163 More currencies, one currency per hotel (TODO 8.10).
--
-- Decision: a hotel has one currency. Every booking, payment, invoice and refund of that hotel is in it (money rows already copy the hotel's
-- currency when they are made). A booking never mixes currencies, and nothing converts between them inside a money function.
--   supported_currencies()  NGN, GHS, KES, ZAR, USD: the currencies Paystack settles. The hotel's currency must be one of them.
--   properties.currency     NGN is always allowed. Any other currency needs the plan flag multi_currency. Once the hotel has a booking, a charge,
--                           a payment, an invoice, a refund or an event booking the currency cannot change (INVALID_STATE: currency locked).
--                           Before that, a change also rewrites the currency on the hotel's room types, rate plans and daily rates, which are
--                           numbers in the hotel's currency; the amounts are not converted, so prices must be checked after a change.
--   room types, rate plans, daily rates: the currency column is always the hotel's currency, whatever a caller sends.
--   daily_report_figures    counts the hotel's own currency (it counted only NGN). Everything built on it (daily report, day close, occupancy
--                           figures that read it) follows.
--   exchange_rates          dated rows kept by hand per group of hotels: 1 unit of from_currency = rate units of to_currency on that date.
--                           For comparing hotels in different currencies on a report; no money function reads them, and a booking never uses one.
--                           fx_rate_get returns the latest rate on or before a date (never a later one), or null when none was entered.
-- Plan flag multi_currency (enforced, Pro plan). With it off a hotel can stay in the currency it has; rates can still be read.
-- Not built: showing a group total across currencies, guest-facing currency choice, paying one booking in another currency than the hotel's,
-- non-Paystack currencies, rounding rules for converted amounts.

create function supported_currencies() returns text[] language sql immutable set search_path = public as $$
  select array['NGN', 'GHS', 'KES', 'ZAR', 'USD']
$$;
revoke all on function supported_currencies() from public, anon;
grant execute on function supported_currencies() to authenticated;

create or replace function plan_enforced_flags() returns text[]
language sql immutable set search_path = public as $$
  select array['reports.export', 'online_payments', 'discounts', 'online_booking', 'guest_cancel', 'guest_changes', 'early_checkin',
               'housekeeping', 'maintenance', 'audit_log', 'branding', 'dynamic_pricing', 'sms_notifications', 'restaurant_pos', 'group_bookings', 'inventory',
               'guest_services', 'api_access', 'loyalty', 'staff_hr', 'multi_currency']
$$;
revoke all on function plan_enforced_flags() from public, anon;
update plans set features = (select array_agg(distinct k order by k) from unnest(features || array['multi_currency']) k) where code = 'pro';

-- ---- the hotel's currency -------------------------------------------------------------------------------------------
create function property_currency_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.currency := upper(btrim(new.currency));
  if not (new.currency = any (supported_currencies())) then raise exception 'POLICY_VIOLATION: currency' using errcode = 'P0001'; end if;
  if tg_op = 'INSERT' or new.currency is distinct from old.currency then
    if new.currency <> 'NGN' and not tenant_feature_on(new.tenant_id, 'multi_currency') then
      raise exception 'POLICY_VIOLATION: multi_currency off' using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.currency is distinct from old.currency then
    if exists (select 1 from reservations where property_id = old.id)
       or exists (select 1 from folio_charges where property_id = old.id)
       or exists (select 1 from payments where property_id = old.id)
       or exists (select 1 from folio_payments where property_id = old.id)
       or exists (select 1 from invoices where property_id = old.id)
       or exists (select 1 from refunds where property_id = old.id)
       or exists (select 1 from venue_bookings where property_id = old.id) then
      raise exception 'INVALID_STATE: currency locked' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
create trigger properties_currency_guard before insert or update of currency on properties for each row execute function property_currency_guard();

-- After the change is written (the price triggers read the hotel's row), the prices follow it.
create function property_currency_follow() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update room_types set currency = new.currency where property_id = new.id and currency <> new.currency;
  update rate_plans set currency = new.currency where property_id = new.id and currency <> new.currency;
  update daily_rates set currency = new.currency where property_id = new.id and currency <> new.currency;
  return null;
end $$;
create trigger properties_currency_follow after update of currency on properties for each row when (old.currency is distinct from new.currency) execute function property_currency_follow();

-- Room types, rate plans and daily rates always carry the hotel's currency.
create function price_row_currency() returns trigger language plpgsql security definer set search_path = public as $$
begin
  select currency into new.currency from properties where id = new.property_id;
  return new;
end $$;
create trigger room_types_currency before insert or update of currency, property_id on room_types for each row execute function price_row_currency();
create trigger rate_plans_currency before insert or update of currency, property_id on rate_plans for each row execute function price_row_currency();
create trigger daily_rates_currency before insert or update of currency, property_id on daily_rates for each row execute function price_row_currency();

-- ---- the report counts the hotel's own currency -----------------------------------------------------------------------------
create or replace function daily_report_figures(p_property uuid, p_from date, p_to date)
returns table (
  day date, rooms_available integer, rooms_sold integer,
  room_revenue_minor bigint, room_tax_minor bigint, extras_minor bigint, extras_tax_minor bigint,
  cash_in_minor bigint, refunds_paid_minor bigint, room_service_minor bigint
) language plpgsql stable security definer set search_path = public as $$
declare v_tz text; v_cur text; v_avail integer;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'POLICY_VIOLATION: report range' using errcode = 'P0001';
  end if;
  select timezone, currency into v_tz, v_cur from properties where id = p_property;
  select count(*) into v_avail from rooms where property_id = p_property and operational_status = 'active';

  return query
  with days as (select d::date as d from generate_series(p_from, p_to, interval '1 day') d),
  nights as (
    select n.night_date as d, count(*)::integer as sold, sum(n.rate_minor)::bigint as rate, sum(n.tax_minor - n.service_minor)::bigint as tax, sum(n.service_minor)::bigint as service
      from reservation_nights n
      join reservation_rooms rr on rr.id = n.reservation_room_id
      join reservations r on r.id = rr.reservation_id
     where r.property_id = p_property and r.currency = v_cur
       and r.reservation_status in ('confirmed', 'checked_in', 'checked_out') and rr.room_status <> 'cancelled'
       and n.night_date between p_from and p_to
     group by n.night_date),
  extras as (
    select c.charge_date as d, sum(c.total_minor - c.tax_minor)::bigint as net, sum(c.tax_minor)::bigint as tax
      from folio_charges c
     where c.property_id = p_property and c.status = 'posted' and c.currency = v_cur and c.charge_date between p_from and p_to
     group by c.charge_date),
  received as (
    select (x.at at time zone v_tz)::date as d, sum(x.amt)::bigint as amt
      from (select received_at as at, amount_minor as amt from payments
             where property_id = p_property and payment_status = 'succeeded' and currency = v_cur
            union all
            select received_at, amount_minor from folio_payments
             where property_id = p_property and payment_status = 'succeeded' and currency = v_cur) x
     where (x.at at time zone v_tz)::date between p_from and p_to
     group by 1),
  paid_out as (
    select (f.completed_at at time zone v_tz)::date as d, sum(f.amount_minor)::bigint as amt
      from refunds f
     where f.property_id = p_property and f.refund_status = 'succeeded' and f.currency = v_cur and f.completed_at is not null
       and (f.completed_at at time zone v_tz)::date between p_from and p_to
     group by 1)
  select days.d, v_avail, coalesce(nights.sold, 0), coalesce(nights.rate, 0), coalesce(nights.tax, 0),
         coalesce(extras.net, 0), coalesce(extras.tax, 0), coalesce(received.amt, 0), coalesce(paid_out.amt, 0), coalesce(nights.service, 0)
    from days
    left join nights on nights.d = days.d left join extras on extras.d = days.d
    left join received on received.d = days.d left join paid_out on paid_out.d = days.d
   order by days.d;
end $$;
revoke all on function daily_report_figures(uuid, date, date) from public, anon, authenticated;

-- ---- exchange rates, kept by hand ---------------------------------------------------------------------------------------------
create table exchange_rates (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id),
  from_currency char(3) not null check (from_currency = any (supported_currencies())),
  to_currency   char(3) not null check (to_currency = any (supported_currencies())),
  rate_date     date not null,
  rate          numeric(18, 8) not null check (rate > 0),
  note          text check (note is null or char_length(note) <= 200),
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, from_currency, to_currency, rate_date),
  check (from_currency <> to_currency)
);
alter table exchange_rates enable row level security;
create policy exchange_rates_select on exchange_rates for select to authenticated
  using (has_tenant_permission(tenant_id, 'report.view') or has_tenant_permission(tenant_id, 'property.configure'));
revoke all on exchange_rates from anon, authenticated;
grant select on exchange_rates to authenticated;

-- Enter or correct the rate for one day (property.configure). A correction on the same day replaces it and is audited with the old value.
create function fx_rate_set(p_property uuid, p_from text, p_to text, p_date date, p_rate numeric, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_tenant uuid; v_id uuid; v_old numeric; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_from text := upper(btrim(coalesce(p_from, ''))); v_to text := upper(btrim(coalesce(p_to, '')));
begin
  v_actor := require_permission(p_property, 'property.configure', 'NOT_FOUND');
  select tenant_id into v_tenant from properties where id = p_property;
  if not tenant_feature_on(v_tenant, 'multi_currency') then raise exception 'POLICY_VIOLATION: multi_currency off' using errcode = 'P0001'; end if;
  if not (v_from = any (supported_currencies())) or not (v_to = any (supported_currencies())) or v_from = v_to then raise exception 'POLICY_VIOLATION: currency' using errcode = 'P0001'; end if;
  if p_date is null or p_date > property_today(p_property) or p_date < property_today(p_property) - 3650 then raise exception 'POLICY_VIOLATION: date' using errcode = 'P0001'; end if;
  if p_rate is null or p_rate <= 0 or p_rate >= 1000000000 or round(p_rate, 8) <> p_rate then raise exception 'POLICY_VIOLATION: rate' using errcode = 'P0001'; end if;
  if char_length(coalesce(v_note, '')) > 200 then raise exception 'POLICY_VIOLATION: text' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtext('fx:' || v_tenant::text || v_from || v_to || p_date::text));
  select id, rate into v_id, v_old from exchange_rates where tenant_id = v_tenant and from_currency = v_from and to_currency = v_to and rate_date = p_date for update;
  if found then
    update exchange_rates set rate = p_rate, note = v_note, created_by = v_actor, updated_at = now() where id = v_id;
  else
    insert into exchange_rates (tenant_id, from_currency, to_currency, rate_date, rate, note, created_by) values (v_tenant, v_from, v_to, p_date, p_rate, v_note, v_actor) returning id into v_id;
  end if;
  perform write_audit(v_tenant, p_property, v_actor, 'exchange_rate.set', 'exchange_rate', v_id, null,
                      jsonb_build_object('from', v_from, 'to', v_to, 'date', p_date, 'rate', p_rate, 'was', v_old));
  return jsonb_build_object('rate_id', v_id);
end $$;

-- The latest rate on or before the date, or null. Readable with report.view or property.configure; readable with the flag off.
create function fx_rate_get(p_property uuid, p_from text, p_to text, p_date date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid; r exchange_rates%rowtype; v_from text := upper(btrim(coalesce(p_from, ''))); v_to text := upper(btrim(coalesce(p_to, '')));
begin
  if not has_permission(p_property, 'report.view') and not has_permission(p_property, 'property.configure') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select tenant_id into v_tenant from properties where id = p_property;
  if v_from = v_to and v_from = any (supported_currencies()) then return jsonb_build_object('rate', 1, 'rate_date', p_date); end if;
  select * into r from exchange_rates where tenant_id = v_tenant and from_currency = v_from and to_currency = v_to and rate_date <= p_date order by rate_date desc limit 1;
  if found then return jsonb_build_object('rate', r.rate, 'rate_date', r.rate_date); end if;
  -- the inverse of a rate entered the other way round
  select * into r from exchange_rates where tenant_id = v_tenant and from_currency = v_to and to_currency = v_from and rate_date <= p_date order by rate_date desc limit 1;
  if found then return jsonb_build_object('rate', round(1 / r.rate, 8), 'rate_date', r.rate_date, 'inverse', true); end if;
  return null;
end $$;
revoke all on function fx_rate_set(uuid, text, text, date, numeric, text), fx_rate_get(uuid, text, text, date) from public, anon;
grant execute on function fx_rate_set(uuid, text, text, date, numeric, text), fx_rate_get(uuid, text, text, date) to authenticated;
