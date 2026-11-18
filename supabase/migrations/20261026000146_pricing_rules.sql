-- 146 Dynamic pricing, step one: rules and a SUGGESTED price screen (TODO 8.5). Nothing here changes a real price.
--
-- A hotel writes rules; the system shows, night by night, what each room type's price would be if the rules applied. A person still sets
-- the real rate (daily_rates, migration 005), so resolve_rate, quotes, holds and search are untouched and keep agreeing (test 11). Applying
-- suggestions automatically is the second step in TODO 8.5 and is not built.
--
--   pricing_rules    one row per rule. kind 'occupancy' (the share of that room type's rooms already taken for the night, band_from to band_to,
--                    0 to 100), 'lead_time' (days from the hotel's today to the night, band_from to band_to, 0 to 365), 'weekday' (weekdays,
--                    1 Monday to 7 Sunday) or 'event' (date_from to date_to, the night itself inside the range). adjust_percent is a change
--                    of the night's current rate, -50 to 100 and never 0. room_type_id null = every room type. At most 40 rules a hotel.
--   pricing_limits   a floor and a ceiling per room type, in minor units. Either may be empty; floor never above ceiling.
--   Rules that match one night ADD their percentages (+10 and +5 make +15), the result is rounded to the nearest 100 naira and then held
--   inside the floor and ceiling. A night with no rate (resolve_rate says RATE_MISSING) is left out.
--   Occupancy counts rooms in service with a live claim that night (a stay, a block, or a hold that has not lapsed) over rooms in service.
--   save_pricing_rule, delete_pricing_rule, set_pricing_limits   need rate.manage and the dynamic_pricing flag on for the hotel group
--                    (no row = on, as for every flag since 052). NOT_FOUND for no permission or another hotel. All audited.
--   pricing_rule_list, pricing_limits_list                      rate.view or rate.manage; readable even with the flag off.
--   pricing_suggestions(property, from, days)                   rate.view or rate.manage and the flag on; 1 to 60 days; read only.
-- Writes go through the functions only (no direct insert, update or delete).

create table pricing_rules (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  property_id    uuid not null,
  room_type_id   uuid,
  name           text not null check (char_length(name) between 1 and 60),
  kind           text not null check (kind in ('occupancy', 'lead_time', 'weekday', 'event')),
  band_from      smallint,
  band_to        smallint,
  weekdays       smallint[],
  date_from      date,
  date_to        date,
  adjust_percent numeric(5, 2) not null check (adjust_percent between -50 and 100 and adjust_percent <> 0),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  foreign key (tenant_id, property_id, room_type_id) references room_types (tenant_id, property_id, id),
  check (kind <> 'occupancy' or (band_from between 0 and 100 and band_to between band_from and 100)),
  check (kind <> 'lead_time' or (band_from between 0 and 365 and band_to between band_from and 365)),
  check (kind <> 'weekday' or (weekdays is not null and cardinality(weekdays) between 1 and 7 and weekdays <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[])),
  check (kind <> 'event' or (date_from is not null and date_to is not null and date_to >= date_from))
);
create index pricing_rules_property_idx on pricing_rules (property_id, is_active);
alter table pricing_rules enable row level security;
create policy pricing_rules_select on pricing_rules for select to authenticated
  using (has_permission(property_id, 'rate.view') or has_permission(property_id, 'rate.manage'));
revoke insert, update, delete on pricing_rules from authenticated, anon;
create trigger pricing_rules_updated before update on pricing_rules for each row execute function set_updated_at();

create table pricing_limits (
  tenant_id    uuid not null,
  property_id  uuid not null,
  room_type_id uuid not null,
  floor_minor  bigint check (floor_minor is null or floor_minor > 0),
  ceiling_minor bigint check (ceiling_minor is null or ceiling_minor > 0),
  updated_at   timestamptz not null default now(),
  primary key (room_type_id),
  foreign key (tenant_id, property_id, room_type_id) references room_types (tenant_id, property_id, id),
  check (floor_minor is not null or ceiling_minor is not null),
  check (floor_minor is null or ceiling_minor is null or floor_minor <= ceiling_minor)
);
alter table pricing_limits enable row level security;
create policy pricing_limits_select on pricing_limits for select to authenticated
  using (has_permission(property_id, 'rate.view') or has_permission(property_id, 'rate.manage'));
revoke insert, update, delete on pricing_limits from authenticated, anon;

-- The flag is enforced; keep the platform's list of enforced flags in step (latest list: migration 112).
create or replace function plan_enforced_flags() returns text[]
language sql immutable set search_path = public as $$
  select array['reports.export', 'online_payments', 'discounts', 'online_booking', 'guest_cancel', 'guest_changes', 'early_checkin',
               'housekeeping', 'maintenance', 'audit_log', 'branding', 'dynamic_pricing']
$$;
revoke all on function plan_enforced_flags() from public, anon;
-- Pro is described as "everything that is enforced today"; Starter and Standard do not get it. Applying a plan sets the flag from this list.
update plans set features = (select array_agg(distinct k order by k) from unnest(features || array['dynamic_pricing']) k) where code = 'pro';

create function save_pricing_rule(p_property uuid, p_rule uuid, p_room_type uuid, p_name text, p_kind text, p_from integer, p_to integer,
                                  p_weekdays integer[], p_date_from date, p_date_to date, p_percent numeric, p_active boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_prop properties%rowtype; v_actor uuid; v_id uuid; v_name text := btrim(coalesce(p_name, '')); v_days smallint[];
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'rate.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(v_prop.tenant_id, 'dynamic_pricing') then raise exception 'POLICY_VIOLATION: dynamic pricing off' using errcode = 'P0001'; end if;

  if char_length(v_name) not between 1 and 60 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if p_kind is null or p_kind not in ('occupancy', 'lead_time', 'weekday', 'event') then raise exception 'POLICY_VIOLATION: kind' using errcode = 'P0001'; end if;
  if p_percent is null or p_percent = 0 or p_percent < -50 or p_percent > 100 or p_percent <> round(p_percent, 2) then
    raise exception 'POLICY_VIOLATION: percent' using errcode = 'P0001';
  end if;
  if p_room_type is not null and not exists (select 1 from room_types where id = p_room_type and property_id = p_property) then
    raise exception 'POLICY_VIOLATION: room type' using errcode = 'P0001';
  end if;
  if p_kind = 'occupancy' and (p_from is null or p_to is null or p_from < 0 or p_to > 100 or p_to < p_from) then raise exception 'POLICY_VIOLATION: band' using errcode = 'P0001'; end if;
  if p_kind = 'lead_time' and (p_from is null or p_to is null or p_from < 0 or p_to > 365 or p_to < p_from) then raise exception 'POLICY_VIOLATION: band' using errcode = 'P0001'; end if;
  if p_kind = 'weekday' then
    select array_agg(distinct d::smallint order by d::smallint) into v_days from unnest(coalesce(p_weekdays, '{}'::integer[])) d;
    if v_days is null or exists (select 1 from unnest(v_days) d where d < 1 or d > 7) then raise exception 'POLICY_VIOLATION: weekdays' using errcode = 'P0001'; end if;
  end if;
  if p_kind = 'event' and (p_date_from is null or p_date_to is null or p_date_to < p_date_from or p_date_to - p_date_from > 365) then
    raise exception 'POLICY_VIOLATION: dates' using errcode = 'P0001';
  end if;

  if p_rule is null then
    if (select count(*) from pricing_rules where property_id = p_property) >= 40 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
    insert into pricing_rules (tenant_id, property_id, room_type_id, name, kind, band_from, band_to, weekdays, date_from, date_to, adjust_percent, is_active)
    values (v_prop.tenant_id, p_property, p_room_type, v_name, p_kind,
            case when p_kind in ('occupancy', 'lead_time') then p_from end, case when p_kind in ('occupancy', 'lead_time') then p_to end,
            case when p_kind = 'weekday' then v_days end,
            case when p_kind = 'event' then p_date_from end, case when p_kind = 'event' then p_date_to end,
            p_percent, coalesce(p_active, true))
    returning id into v_id;
  else
    update pricing_rules set room_type_id = p_room_type, name = v_name, kind = p_kind,
           band_from = case when p_kind in ('occupancy', 'lead_time') then p_from end, band_to = case when p_kind in ('occupancy', 'lead_time') then p_to end,
           weekdays = case when p_kind = 'weekday' then v_days end,
           date_from = case when p_kind = 'event' then p_date_from end, date_to = case when p_kind = 'event' then p_date_to end,
           adjust_percent = p_percent, is_active = coalesce(p_active, true)
     where id = p_rule and property_id = p_property
     returning id into v_id;
    if v_id is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  end if;

  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'pricing_rule.saved', 'pricing_rule', v_id, null,
                      jsonb_build_object('name', v_name, 'kind', p_kind, 'percent', p_percent, 'active', coalesce(p_active, true), 'created', p_rule is null));
  return jsonb_build_object('rule_id', v_id);
end $$;
revoke all on function save_pricing_rule(uuid, uuid, uuid, text, text, integer, integer, integer[], date, date, numeric, boolean) from public, anon;
grant execute on function save_pricing_rule(uuid, uuid, uuid, text, text, integer, integer, integer[], date, date, numeric, boolean) to authenticated;

create function delete_pricing_rule(p_rule uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r pricing_rules%rowtype; v_actor uuid;
begin
  select * into r from pricing_rules where id = p_rule;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(r.property_id, 'rate.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(r.tenant_id, 'dynamic_pricing') then raise exception 'POLICY_VIOLATION: dynamic pricing off' using errcode = 'P0001'; end if;
  delete from pricing_rules where id = r.id;
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'pricing_rule.deleted', 'pricing_rule', r.id, null, jsonb_build_object('name', r.name, 'kind', r.kind));
end $$;
revoke all on function delete_pricing_rule(uuid) from public, anon;
grant execute on function delete_pricing_rule(uuid) to authenticated;

-- Both empty clears the limits for that room type.
create function set_pricing_limits(p_property uuid, p_room_type uuid, p_floor bigint, p_ceiling bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v_prop properties%rowtype; v_actor uuid;
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'rate.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(v_prop.tenant_id, 'dynamic_pricing') then raise exception 'POLICY_VIOLATION: dynamic pricing off' using errcode = 'P0001'; end if;
  if not exists (select 1 from room_types where id = p_room_type and property_id = p_property) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if (p_floor is not null and (p_floor <= 0 or p_floor > 100000000000)) or (p_ceiling is not null and (p_ceiling <= 0 or p_ceiling > 100000000000))
     or (p_floor is not null and p_ceiling is not null and p_floor > p_ceiling) then
    raise exception 'POLICY_VIOLATION: limits' using errcode = 'P0001';
  end if;
  if p_floor is null and p_ceiling is null then
    delete from pricing_limits where room_type_id = p_room_type;
  else
    insert into pricing_limits (tenant_id, property_id, room_type_id, floor_minor, ceiling_minor)
    values (v_prop.tenant_id, p_property, p_room_type, p_floor, p_ceiling)
    on conflict (room_type_id) do update set floor_minor = excluded.floor_minor, ceiling_minor = excluded.ceiling_minor, updated_at = now();
  end if;
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'pricing_limits.saved', 'room_type', p_room_type, null,
                      jsonb_build_object('floor_minor', p_floor, 'ceiling_minor', p_ceiling));
end $$;
revoke all on function set_pricing_limits(uuid, uuid, bigint, bigint) from public, anon;
grant execute on function set_pricing_limits(uuid, uuid, bigint, bigint) to authenticated;

create function pricing_rule_list(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_permission(p_property, 'rate.view') or has_permission(p_property, 'rate.manage')) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'room_type_id', r.room_type_id, 'room_type_name', t.name, 'name', r.name, 'kind', r.kind, 'band_from', r.band_from, 'band_to', r.band_to,
      'weekdays', to_jsonb(r.weekdays), 'date_from', r.date_from, 'date_to', r.date_to, 'adjust_percent', r.adjust_percent, 'is_active', r.is_active)
      order by r.is_active desc, r.created_at)
      from pricing_rules r left join room_types t on t.id = r.room_type_id
     where r.property_id = p_property), '[]'::jsonb);
end $$;
revoke all on function pricing_rule_list(uuid) from public, anon;
grant execute on function pricing_rule_list(uuid) to authenticated;

create function pricing_limits_list(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_permission(p_property, 'rate.view') or has_permission(p_property, 'rate.manage')) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('room_type_id', t.id, 'room_type_name', t.name, 'base_rate_minor', t.base_rate_minor,
                                        'floor_minor', l.floor_minor, 'ceiling_minor', l.ceiling_minor) order by t.name)
      from room_types t left join pricing_limits l on l.room_type_id = t.id
     where t.property_id = p_property and t.status = 'active'), '[]'::jsonb);
end $$;
revoke all on function pricing_limits_list(uuid) from public, anon;
grant execute on function pricing_limits_list(uuid) to authenticated;

-- The suggestions. One entry per active room type, with a night for each date that has a rate.
create function pricing_suggestions(p_property uuid, p_from date, p_days integer default 14) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_prop properties%rowtype; v_today date; v_plan uuid; v_out jsonb := '[]'::jsonb; t record; v_nights jsonb; n date;
  v_cur bigint; v_rooms integer; v_busy integer; v_occ numeric; v_lead integer; v_sum numeric; v_names text[]; v_sug bigint; v_limited text; l pricing_limits%rowtype;
begin
  select * into v_prop from properties where id = p_property;
  if not found or not (has_permission(p_property, 'rate.view') or has_permission(p_property, 'rate.manage')) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(v_prop.tenant_id, 'dynamic_pricing') then raise exception 'POLICY_VIOLATION: dynamic pricing off' using errcode = 'P0001'; end if;
  if p_from is null or p_days is null or p_days < 1 or p_days > 60 then raise exception 'POLICY_VIOLATION: range' using errcode = 'P0001'; end if;

  v_today := (now() at time zone v_prop.timezone)::date;
  select id into v_plan from rate_plans where property_id = p_property and is_default;

  for t in select id, name from room_types where property_id = p_property and status = 'active' order by name loop
    select * into l from pricing_limits where room_type_id = t.id;
    select count(*)::integer into v_rooms from rooms where room_type_id = t.id and operational_status = 'active';
    v_nights := '[]'::jsonb;
    for n in select d::date from generate_series(p_from, p_from + (p_days - 1), interval '1 day') d loop
      begin
        select amount_minor into v_cur from resolve_rate(p_property, t.id, v_plan, n);
      exception when others then
        v_cur := null;       -- RATE_MISSING (or no default plan): no suggestion for that night
      end;
      continue when v_cur is null;

      select count(distinct c.room_id)::integer into v_busy
        from room_inventory_claims c join rooms r on r.id = c.room_id
       where r.room_type_id = t.id and r.operational_status = 'active' and c.status = 'active'
         and (c.claim_type <> 'hold' or c.hold_expires_at > now()) and c.start_date <= n and c.end_date > n;
      v_occ := case when v_rooms > 0 then round(v_busy * 100.0 / v_rooms, 1) end;
      v_lead := n - v_today;

      select coalesce(sum(r.adjust_percent), 0), coalesce(array_agg(r.name order by r.created_at), '{}')
        into v_sum, v_names
        from pricing_rules r
       where r.property_id = p_property and r.is_active and (r.room_type_id is null or r.room_type_id = t.id)
         and ((r.kind = 'occupancy' and v_occ is not null and v_occ >= r.band_from and v_occ <= r.band_to)
           or (r.kind = 'lead_time' and v_lead >= r.band_from and v_lead <= r.band_to)
           or (r.kind = 'weekday' and extract(isodow from n)::smallint = any (r.weekdays))
           or (r.kind = 'event' and n between r.date_from and r.date_to));

      v_sug := (round(v_cur * (1 + v_sum / 100) / 10000) * 10000)::bigint;      -- nearest 100 naira
      v_limited := null;
      if l.floor_minor is not null and v_sug < l.floor_minor then v_sug := l.floor_minor; v_limited := 'floor'; end if;
      if l.ceiling_minor is not null and v_sug > l.ceiling_minor then v_sug := l.ceiling_minor; v_limited := 'ceiling'; end if;
      if v_sug <= 0 then v_sug := v_cur; v_limited := 'floor'; end if;           -- a price is never zero

      v_nights := v_nights || jsonb_build_object('night', n, 'current_minor', v_cur, 'suggested_minor', v_sug, 'change_percent', v_sum,
                                                 'occupancy_percent', v_occ, 'lead_days', v_lead, 'rules', to_jsonb(v_names), 'limited', v_limited);
    end loop;
    v_out := v_out || jsonb_build_object('room_type_id', t.id, 'room_type_name', t.name, 'nights', v_nights);
  end loop;
  return v_out;
end $$;
revoke all on function pricing_suggestions(uuid, date, integer) from public, anon;
grant execute on function pricing_suggestions(uuid, date, integer) to authenticated;
