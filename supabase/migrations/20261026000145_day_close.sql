-- 145 Night audit and day close (TODO 8.8).
--
-- At the end of a hotel day a manager closes it: the system lists what is still open, and closing keeps the day's report figures
-- as they were at that moment, so a later change cannot rewrite a day the hotel has signed off.
--
--   day.close                     new permission: owner, general manager, accountant (all three already hold report.view, so the
--                                 figures the audit shows are figures they may read anyway). Front desk does not hold it; a custom
--                                 role can be given it.
--   day_closes                    one row per property and hotel day, never edited or deleted. `figures` is the day's daily_report row
--                                 as it stood at close; `open_items` the counts that were open; `override_note` why the day was closed
--                                 with items open. Read with day.close or report.view; every write goes through close_day.
--   daily_report_figures(property, from, to)
--                                 the daily_report query itself, without the permission check, for the functions below (a role that holds
--                                 day.close but not report.view must never reach it directly: execute is revoked from everyone).
--                                 daily_report now calls it, so the report and the audit cannot drift apart.
--   night_audit_items(property, day)
--                                 what is open on a day (internal; counts and the first 50 booking references of each kind):
--                                   arrivals_not_checked_in    confirmed stays with a room still 'booked' that should be in house that night
--                                                              (arrival on or before the day, departure after it)
--                                   departures_not_checked_out checked-in rooms whose stay ended on or before the day
--                                   unverified_payments        bank transfers and "other" payments received on or before the day that nobody
--                                                              with payment.verify has checked yet (migration 056)
--   night_audit_preview(property, day)
--                                 day.close. The day (default: the hotel's today), whether it is closed, the open items and the figures
--                                 as they are now. A future day is refused.
--   close_day(property, day, override_note, idempotency_key)
--                                 day.close. Closes one day once. With items open it needs a note of at least 5 characters (the same shape
--                                 as the check-in override). Idempotent per key; a second close of the same day with another key is
--                                 INVALID_STATE: already closed. One audit row (`day.closed`). NOT_FOUND for no permission, another hotel
--                                 or an unknown property.
--   night_audit_days(property, days)
--                                 day.close or report.view. The last 1 to 92 days, newest first, each with closed or open and, for a
--                                 closed day, `changed_since_close`: the live figures no longer match the ones kept (a late payment, a
--                                 void, a charge posted for that day). Room count (rooms_available) is not compared, only what was sold,
--                                 earned and received.
--
-- Not built, on purpose: room charges are not posted at close. Room revenue here comes from the booked nights (reservation_nights), so
-- there is nothing to post, and posting would count the same night twice. Extras (folio_charges) are posted the moment staff add them, so
-- there is no unposted charge to list either. Closing also does not stop later changes to a closed day: it keeps a record and shows when
-- the live figures have moved away from it.

insert into permissions (key) values ('day.close');
insert into role_permissions (role_id, permission_id)
select r.id, p.id
  from roles r, permissions p
 where p.key = 'day.close' and r.key in ('owner', 'general_manager', 'accountant');

-- ---- The report query, without the permission check -----------------------------------------------------------------------
create function daily_report_figures(p_property uuid, p_from date, p_to date)
returns table (
  day date, rooms_available integer, rooms_sold integer,
  room_revenue_minor bigint, room_tax_minor bigint, extras_minor bigint, extras_tax_minor bigint,
  cash_in_minor bigint, refunds_paid_minor bigint, room_service_minor bigint
) language plpgsql stable security definer set search_path = public as $$
declare v_tz text; v_avail integer;
begin
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
revoke all on function daily_report_figures(uuid, date, date) from public, anon, authenticated;

-- daily_report keeps its signature, grants and answers; only the query moved.
create or replace function daily_report(p_property uuid, p_from date, p_to date)
returns table (
  day date, rooms_available integer, rooms_sold integer,
  room_revenue_minor bigint, room_tax_minor bigint, extras_minor bigint, extras_tax_minor bigint,
  cash_in_minor bigint, refunds_paid_minor bigint, room_service_minor bigint
) language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission(p_property, 'report.view', 'NOT_FOUND');
  return query select * from daily_report_figures(p_property, p_from, p_to);
end $$;
revoke all on function daily_report(uuid, date, date) from public, anon;
grant execute on function daily_report(uuid, date, date) to authenticated;

-- ---- The record of a closed day -------------------------------------------------------------------------------------------
create table day_closes (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  property_id   uuid not null,
  business_date date not null,
  closed_at     timestamptz not null default now(),
  closed_by     uuid references auth.users (id) on delete set null,
  figures       jsonb not null,
  open_items    jsonb not null,
  override_note text check (override_note is null or length(override_note) between 5 and 500),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  unique (property_id, business_date)
);
create index on day_closes (property_id, business_date desc);

alter table day_closes enable row level security;
create policy day_closes_select on day_closes for select to authenticated
  using (has_permission(property_id, 'day.close') or has_permission(property_id, 'report.view'));
revoke insert, update, delete on day_closes from authenticated, anon;

-- A closed day is a record: never edited, never deleted. The one change allowed is the database clearing `closed_by` when that
-- person's login is removed (the foreign key's "on delete set null"); nothing else in the row may move then.
create function day_closes_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.closed_by is not null and new.closed_by is null
     and (to_jsonb(new) - 'closed_by') = (to_jsonb(old) - 'closed_by') then
    return new;
  end if;
  raise exception 'day_closes rows are kept as history' using errcode = '23514';
end $$;
revoke all on function day_closes_guard() from public, anon, authenticated;
create trigger day_closes_guard_trg before update or delete on day_closes for each row execute function day_closes_guard();

-- ---- What is open on a day -------------------------------------------------------------------------------------------------
create function night_audit_items(p_property uuid, p_day date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_tz text; v_arr jsonb; v_dep jsonb; v_pay jsonb; v_n_arr integer; v_n_dep integer; v_n_pay integer; v_pay_minor bigint;
begin
  select timezone into v_tz from properties where id = p_property;

  select count(*), coalesce(jsonb_agg(jsonb_build_object('reservation_id', x.id, 'booking_reference', x.booking_reference, 'arrival_date', x.arrival_date)
                                      order by x.arrival_date, x.booking_reference) filter (where x.rn <= 50), '[]'::jsonb)
    into v_n_arr, v_arr
    from (select r.id, r.booking_reference, r.arrival_date, row_number() over (order by r.arrival_date, r.booking_reference) as rn
            from reservations r
           where r.property_id = p_property and r.reservation_status = 'confirmed'
             and r.arrival_date <= p_day and r.departure_date > p_day
             and exists (select 1 from reservation_rooms rr where rr.reservation_id = r.id and rr.room_status = 'booked')) x;

  select count(*), coalesce(jsonb_agg(jsonb_build_object('reservation_id', x.id, 'booking_reference', x.booking_reference, 'departure_date', x.departure_date)
                                      order by x.departure_date, x.booking_reference) filter (where x.rn <= 50), '[]'::jsonb)
    into v_n_dep, v_dep
    from (select r.id, r.booking_reference, r.departure_date, row_number() over (order by r.departure_date, r.booking_reference) as rn
            from reservations r
           where r.property_id = p_property and r.departure_date <= p_day
             and exists (select 1 from reservation_rooms rr where rr.reservation_id = r.id and rr.room_status = 'checked_in')) x;

  select count(*), coalesce(sum(x.amount_minor), 0)::bigint,
         coalesce(jsonb_agg(jsonb_build_object('reservation_id', x.reservation_id, 'booking_reference', x.booking_reference, 'amount_minor', x.amount_minor)
                            order by x.received_at, x.booking_reference) filter (where x.rn <= 50), '[]'::jsonb)
    into v_n_pay, v_pay_minor, v_pay
    from (select p.reservation_id, r.booking_reference, p.amount_minor, p.received_at,
                 row_number() over (order by p.received_at, r.booking_reference) as rn
            from payments p join reservations r on r.id = p.reservation_id
           where p.property_id = p_property and p.payment_status = 'succeeded' and p.verification_status = 'unverified'
             and (p.received_at at time zone v_tz)::date <= p_day) x;

  return jsonb_build_object(
    'arrivals_not_checked_in', v_n_arr, 'arrivals', v_arr,
    'departures_not_checked_out', v_n_dep, 'departures', v_dep,
    'unverified_payments', v_n_pay, 'unverified_payments_minor', v_pay_minor, 'payments', v_pay,
    'total', v_n_arr + v_n_dep + v_n_pay);
end $$;
revoke all on function night_audit_items(uuid, date) from public, anon, authenticated;

-- ---- Preview ---------------------------------------------------------------------------------------------------------------
create function night_audit_preview(p_property uuid, p_day date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_today date; v_day date; c day_closes%rowtype; f record; v_closed boolean;
begin
  perform require_permission(p_property, 'day.close', 'NOT_FOUND');
  v_today := property_today(p_property);
  v_day := coalesce(p_day, v_today);
  if v_day > v_today then raise exception 'POLICY_VIOLATION: future day' using errcode = 'P0001'; end if;
  if v_day < v_today - 366 then raise exception 'POLICY_VIOLATION: day too old' using errcode = 'P0001'; end if;

  select * into c from day_closes where property_id = p_property and business_date = v_day;
  v_closed := found;
  select * into f from daily_report_figures(p_property, v_day, v_day);
  return jsonb_build_object(
    'property_id', p_property, 'day', v_day, 'today', v_today,
    'closed', v_closed, 'closed_at', c.closed_at, 'override_note', c.override_note,
    'items', night_audit_items(p_property, v_day),
    'figures', to_jsonb(f),
    'kept_figures', c.figures);
end $$;
revoke all on function night_audit_preview(uuid, date) from public, anon;
grant execute on function night_audit_preview(uuid, date) to authenticated;

-- ---- Close -----------------------------------------------------------------------------------------------------------------
create function close_day(p_property uuid, p_day date, p_override_note text, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid; v_tenant uuid; v_today date; v_note text := nullif(btrim(coalesce(p_override_note, '')), '');
  v_idem record; v_hash text; v_items jsonb; v_figures jsonb; v_id uuid; v_at timestamptz; v_result jsonb; f record;
begin
  v_actor := require_permission(p_property, 'day.close', 'NOT_FOUND');
  select tenant_id into v_tenant from properties where id = p_property;
  if v_tenant is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_day is null then raise exception 'POLICY_VIOLATION: day required' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', p_property, p_day, coalesce(v_note, '')));
  select * into v_idem from idem_begin(v_tenant, 'close_day', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  v_today := property_today(p_property);
  if p_day > v_today then raise exception 'POLICY_VIOLATION: future day' using errcode = 'P0001'; end if;
  if p_day < v_today - 366 then raise exception 'POLICY_VIOLATION: day too old' using errcode = 'P0001'; end if;
  if v_note is not null and (length(v_note) < 5 or length(v_note) > 500) then
    raise exception 'POLICY_VIOLATION: note length' using errcode = 'P0001';
  end if;

  v_items := night_audit_items(p_property, p_day);
  if (v_items ->> 'total')::integer > 0 and v_note is null then
    raise exception 'POLICY_VIOLATION: open items need a note' using errcode = 'P0001';
  end if;
  -- A note with nothing open is not stored: the record then says plainly that the day was clean.
  if (v_items ->> 'total')::integer = 0 then v_note := null; end if;

  select * into f from daily_report_figures(p_property, p_day, p_day);
  v_figures := to_jsonb(f);

  insert into day_closes (tenant_id, property_id, business_date, closed_by, figures, open_items, override_note)
  values (v_tenant, p_property, p_day, v_actor, v_figures,
          jsonb_build_object('arrivals_not_checked_in', v_items -> 'arrivals_not_checked_in',
                             'departures_not_checked_out', v_items -> 'departures_not_checked_out',
                             'unverified_payments', v_items -> 'unverified_payments',
                             'unverified_payments_minor', v_items -> 'unverified_payments_minor',
                             'total', v_items -> 'total'),
          v_note)
  on conflict (property_id, business_date) do nothing
  returning id, closed_at into v_id, v_at;
  if v_id is null then raise exception 'INVALID_STATE: already closed' using errcode = 'P0001'; end if;

  perform write_audit(v_tenant, p_property, v_actor, 'day.closed', 'day_close', v_id, null,
                      jsonb_build_object('business_date', p_day, 'open_items', v_items -> 'total', 'override_note', v_note));

  v_result := jsonb_build_object('close_id', v_id, 'business_date', p_day, 'closed_at', v_at,
                                 'open_items', v_items -> 'total', 'figures', v_figures);
  perform idem_finish(v_tenant, 'close_day', p_idempotency_key, v_result);
  return v_result;
end $$;
revoke all on function close_day(uuid, date, text, text) from public, anon;
grant execute on function close_day(uuid, date, text, text) to authenticated;

-- ---- Recent days -----------------------------------------------------------------------------------------------------------
create function night_audit_days(p_property uuid, p_days integer default 14) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_today date; v_from date;
begin
  if p_property is null or not (has_permission(p_property, 'day.close') or has_permission(p_property, 'report.view')) then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  if p_days is null or p_days < 1 or p_days > 92 then raise exception 'POLICY_VIOLATION: days' using errcode = 'P0001'; end if;
  v_today := property_today(p_property);
  v_from := v_today - (p_days - 1);

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'day', d.day, 'closed', c.id is not null, 'closed_at', c.closed_at, 'override_note', c.override_note,
             'open_items', (c.open_items ->> 'total')::integer,
             'figures', case when c.id is not null then c.figures else to_jsonb(l) end,
             'changed_since_close',
               case when c.id is null then null
                    else (c.figures ->> 'rooms_sold', c.figures ->> 'room_revenue_minor', c.figures ->> 'room_tax_minor', c.figures ->> 'room_service_minor',
                          c.figures ->> 'extras_minor', c.figures ->> 'extras_tax_minor', c.figures ->> 'cash_in_minor', c.figures ->> 'refunds_paid_minor')
                         is distinct from
                         (l.rooms_sold::text, l.room_revenue_minor::text, l.room_tax_minor::text, l.room_service_minor::text,
                          l.extras_minor::text, l.extras_tax_minor::text, l.cash_in_minor::text, l.refunds_paid_minor::text)
               end)
           order by d.day desc)
      from (select g::date as day from generate_series(v_from, v_today, interval '1 day') g) d
      join daily_report_figures(p_property, v_from, v_today) l on l.day = d.day
      left join day_closes c on c.property_id = p_property and c.business_date = d.day
  ), '[]'::jsonb);
end $$;
revoke all on function night_audit_days(uuid, integer) from public, anon;
grant execute on function night_audit_days(uuid, integer) to authenticated;
