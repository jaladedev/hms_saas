-- 152 Dynamic pricing, step two: automatic apply (TODO 8.5). A hotel switches it on; the maintenance job then writes the suggested price
-- of each of the next 60 nights into the default rate plan's daily_rates.
--
-- Why daily_rates and not a change inside resolve_rate: resolve_rate already reads daily_rates first, so quotes, holds, search and every
-- later booking function (date changes, stay edits, early check-in) see the new price through the one path they already use and cannot
-- disagree (test 11). Putting the rules inside resolve_rate would make a price depend on live occupancy at the moment of each call, so
-- the second room of one hold would be priced differently from the first. Writing the price keeps it fixed until the next run.
-- A booking or hold already made keeps the nightly prices stored on its nights (reservation_nights), so a price that moves later never
-- changes what a guest was quoted or charged.
--
--   pricing_settings        one row per hotel: auto_apply (default off), when it last ran and what it did.
--   pricing_applied         one row per night the job manages: status 'applied' (the daily rate is the one the job wrote) or 'manual' (a
--                           person changed that night's price afterwards, so the job leaves it alone), the price BEFORE the job (base_minor,
--                           which the rules are always worked from, so repeated runs never compound) and whether a daily rate existed
--                           before (original_row; if not, switching off removes the row again).
--   pricing_night_base      the price the rules start from for one night: the stored base for a night the job manages, else resolve_rate.
--   pricing_compute_night   the rule maths for one night (moved out of pricing_suggestions so the screen and the job cannot drift apart).
--   pricing_suggestions     as in 146; "current_minor" is still the price in force now, and each night also says base_minor (what the rules
--                           start from) and auto (the job set the current price). With auto-apply off nothing differs from 146.
--   pricing_settings_get    rate.view or rate.manage; readable with the flag off.
--   set_pricing_auto_apply  rate.manage. Switching ON needs the dynamic_pricing flag and prices the next 60 nights at once; switching OFF is
--                           always allowed and puts every night the job still owns back to the price it had. Audited both ways.
--   pricing_apply_now       rate.manage and the flag; the same run as the job, for after the rules changed. Needs auto-apply on.
--   apply_due_pricing       system only (maintenance cron): runs every hotel that has it on. A hotel whose plan lost the dynamic_pricing flag is
--                           switched off and its prices put back.
--
-- A night is only changed when a rule matched or a floor/ceiling applied; a night the rules leave alone is never touched. A night whose
-- price a person changed after the job set it is marked 'manual' and left alone until auto-apply is switched off and on again.
-- One audit row per run (pricing.applied) with the counts, plus the usual summary rows daily_rates already writes. Writes go through
-- the functions only.

create table pricing_settings (
  property_id     uuid primary key references properties (id),
  tenant_id       uuid not null,
  auto_apply      boolean not null default false,
  last_applied_at timestamptz,
  last_summary    jsonb,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users (id) on delete set null,
  foreign key (tenant_id, property_id) references properties (tenant_id, id)
);
alter table pricing_settings enable row level security;
create policy pricing_settings_select on pricing_settings for select to authenticated
  using (has_permission(property_id, 'rate.view') or has_permission(property_id, 'rate.manage'));
revoke insert, update, delete on pricing_settings from authenticated, anon;

create table pricing_applied (
  tenant_id     uuid not null,
  property_id   uuid not null,
  room_type_id  uuid not null,
  rate_plan_id  uuid not null,
  business_date date not null,
  status        text not null check (status in ('applied', 'manual')),
  base_minor    bigint not null check (base_minor > 0),
  applied_minor bigint not null check (applied_minor > 0),
  original_row  boolean not null,
  updated_at    timestamptz not null default now(),
  primary key (property_id, room_type_id, rate_plan_id, business_date),
  foreign key (tenant_id, property_id, room_type_id) references room_types (tenant_id, property_id, id),
  foreign key (tenant_id, property_id, rate_plan_id) references rate_plans (tenant_id, property_id, id)
);
alter table pricing_applied enable row level security;
create policy pricing_applied_select on pricing_applied for select to authenticated
  using (has_permission(property_id, 'rate.view') or has_permission(property_id, 'rate.manage'));
revoke insert, update, delete on pricing_applied from authenticated, anon;

-- ---- The base price of one night -------------------------------------------------------------------------------------------
create function pricing_night_base(p_property uuid, p_room_type uuid, p_plan uuid, p_night date)
returns table (base_minor bigint, auto boolean)
language plpgsql stable security definer set search_path = public as $$
declare a pricing_applied%rowtype; v_daily bigint; v bigint;
begin
  select * into a from pricing_applied
   where property_id = p_property and room_type_id = p_room_type and rate_plan_id = p_plan and business_date = p_night;
  if found and a.status = 'applied' then
    select d.amount_minor into v_daily from daily_rates d
     where d.property_id = p_property and d.room_type_id = p_room_type and d.rate_plan_id = p_plan and d.business_date = p_night;
    if v_daily is not null and v_daily = a.applied_minor then
      return query select a.base_minor, true;
      return;
    end if;
  end if;
  begin
    select r.amount_minor into v from resolve_rate(p_property, p_room_type, p_plan, p_night) r;
  exception when others then
    v := null;               -- RATE_MISSING: nothing to base a price on
  end;
  return query select v, false;
end $$;
revoke all on function pricing_night_base(uuid, uuid, uuid, date) from public, anon, authenticated;

-- ---- The rule maths for one night ------------------------------------------------------------------------------------------
create function pricing_compute_night(p_property uuid, p_room_type uuid, p_night date, p_base bigint, p_today date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_rooms integer; v_busy integer; v_occ numeric; v_lead integer; v_sum numeric; v_names text[]; v_sug bigint; v_limited text; l pricing_limits%rowtype;
begin
  select * into l from pricing_limits where room_type_id = p_room_type;
  select count(*)::integer into v_rooms from rooms where room_type_id = p_room_type and operational_status = 'active';
  select count(distinct c.room_id)::integer into v_busy
    from room_inventory_claims c join rooms r on r.id = c.room_id
   where r.room_type_id = p_room_type and r.operational_status = 'active' and c.status = 'active'
     and (c.claim_type <> 'hold' or c.hold_expires_at > now()) and c.start_date <= p_night and c.end_date > p_night;
  v_occ := case when v_rooms > 0 then round(v_busy * 100.0 / v_rooms, 1) end;
  v_lead := p_night - p_today;

  select coalesce(sum(r.adjust_percent), 0), coalesce(array_agg(r.name order by r.created_at), '{}')
    into v_sum, v_names
    from pricing_rules r
   where r.property_id = p_property and r.is_active and (r.room_type_id is null or r.room_type_id = p_room_type)
     and ((r.kind = 'occupancy' and v_occ is not null and v_occ >= r.band_from and v_occ <= r.band_to)
       or (r.kind = 'lead_time' and v_lead >= r.band_from and v_lead <= r.band_to)
       or (r.kind = 'weekday' and extract(isodow from p_night)::smallint = any (r.weekdays))
       or (r.kind = 'event' and p_night between r.date_from and r.date_to));

  v_sug := (round(p_base * (1 + v_sum / 100) / 10000) * 10000)::bigint;      -- nearest 100 naira
  v_limited := null;
  if l.floor_minor is not null and v_sug < l.floor_minor then v_sug := l.floor_minor; v_limited := 'floor'; end if;
  if l.ceiling_minor is not null and v_sug > l.ceiling_minor then v_sug := l.ceiling_minor; v_limited := 'ceiling'; end if;
  if v_sug <= 0 then v_sug := p_base; v_limited := 'floor'; end if;           -- a price is never zero

  return jsonb_build_object('suggested_minor', v_sug, 'change_percent', v_sum, 'occupancy_percent', v_occ, 'lead_days', v_lead,
                            'rules', to_jsonb(v_names), 'limited', v_limited);
end $$;
revoke all on function pricing_compute_night(uuid, uuid, date, bigint, date) from public, anon, authenticated;

-- ---- The suggestions (same answer as 146 with auto-apply off) --------------------------------------------------------------
create or replace function pricing_suggestions(p_property uuid, p_from date, p_days integer default 14) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_prop properties%rowtype; v_today date; v_plan uuid; v_out jsonb := '[]'::jsonb; t record; v_nights jsonb; n date;
  v_cur bigint; v_base bigint; v_auto boolean; c jsonb;
begin
  select * into v_prop from properties where id = p_property;
  if not found or not (has_permission(p_property, 'rate.view') or has_permission(p_property, 'rate.manage')) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(v_prop.tenant_id, 'dynamic_pricing') then raise exception 'POLICY_VIOLATION: dynamic pricing off' using errcode = 'P0001'; end if;
  if p_from is null or p_days is null or p_days < 1 or p_days > 60 then raise exception 'POLICY_VIOLATION: range' using errcode = 'P0001'; end if;

  v_today := (now() at time zone v_prop.timezone)::date;
  select id into v_plan from rate_plans where property_id = p_property and is_default;

  for t in select id, name from room_types where property_id = p_property and status = 'active' order by name loop
    v_nights := '[]'::jsonb;
    for n in select d::date from generate_series(p_from, p_from + (p_days - 1), interval '1 day') d loop
      begin
        select amount_minor into v_cur from resolve_rate(p_property, t.id, v_plan, n);
      exception when others then
        v_cur := null;       -- RATE_MISSING (or no default plan): no suggestion for that night
      end;
      continue when v_cur is null;

      select b.base_minor, b.auto into v_base, v_auto from pricing_night_base(p_property, t.id, v_plan, n) b;
      v_base := coalesce(v_base, v_cur);
      c := pricing_compute_night(p_property, t.id, n, v_base, v_today);

      v_nights := v_nights || jsonb_build_object('night', n, 'current_minor', v_cur, 'base_minor', v_base, 'auto', coalesce(v_auto, false),
                                                 'suggested_minor', c -> 'suggested_minor', 'change_percent', c -> 'change_percent',
                                                 'occupancy_percent', c -> 'occupancy_percent', 'lead_days', c -> 'lead_days',
                                                 'rules', c -> 'rules', 'limited', c -> 'limited');
    end loop;
    v_out := v_out || jsonb_build_object('room_type_id', t.id, 'room_type_name', t.name, 'nights', v_nights);
  end loop;
  return v_out;
end $$;

-- ---- One run for one hotel -------------------------------------------------------------------------------------------------
-- Prices the next 60 nights of every active room type on the default plan. Set-based writes, so daily_rates writes one summary audit row
-- per room type per statement rather than one per night.
create function pricing_apply_property(p_property uuid, p_actor uuid, p_by text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c_horizon constant integer := 60;
  v_prop properties%rowtype; v_today date; v_plan uuid; t record; n date; a pricing_applied%rowtype; v_has boolean; v_daily bigint;
  v_base bigint; v_auto boolean; c jsonb; v_sug bigint; v_chg numeric; v_lim text;
  v_up jsonb := '[]'::jsonb; v_del jsonb := '[]'::jsonb; v_tup jsonb := '[]'::jsonb; v_tdel jsonb := '[]'::jsonb; v_tman jsonb := '[]'::jsonb;
  v_set integer := 0; v_restored integer := 0; v_manual integer := 0; v_summary jsonb;
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_today := property_today(p_property);
  select id into v_plan from rate_plans where property_id = p_property and is_default;
  if v_plan is null then
    return jsonb_build_object('nights_set', 0, 'nights_restored', 0, 'nights_by_hand', 0, 'note', 'no default rate plan');
  end if;

  for t in select id from room_types where property_id = p_property and status = 'active' order by id loop
    for n in select d::date from generate_series(v_today, v_today + (c_horizon - 1), interval '1 day') d loop
      select * into a from pricing_applied
       where property_id = p_property and room_type_id = t.id and rate_plan_id = v_plan and business_date = n;
      v_has := found;
      if v_has and a.status = 'manual' then
        v_manual := v_manual + 1;
        continue;
      end if;
      select d.amount_minor into v_daily from daily_rates d
       where d.property_id = p_property and d.room_type_id = t.id and d.rate_plan_id = v_plan and d.business_date = n;
      if v_has and v_daily is distinct from a.applied_minor then
        -- a person changed this night's price after the job set it: theirs stays, and the job stops managing the night
        v_tman := v_tman || jsonb_build_object('room_type_id', t.id, 'night', n);
        v_manual := v_manual + 1;
        continue;
      end if;

      select b.base_minor, b.auto into v_base, v_auto from pricing_night_base(p_property, t.id, v_plan, n) b;
      continue when v_base is null or v_base <= 0;
      c := pricing_compute_night(p_property, t.id, n, v_base, v_today);
      v_sug := (c ->> 'suggested_minor')::bigint;
      v_chg := (c ->> 'change_percent')::numeric;
      v_lim := c ->> 'limited';
      if v_chg = 0 and v_lim is null then v_sug := v_base; end if;       -- no rule matched and no limit applied: leave the night alone

      if v_sug = v_base then
        if v_has then
          -- the rules no longer move this night: put the price it had back
          if a.original_row then v_up := v_up || jsonb_build_object('room_type_id', t.id, 'night', n, 'amount', v_base);
          else v_del := v_del || jsonb_build_object('room_type_id', t.id, 'night', n); end if;
          v_tdel := v_tdel || jsonb_build_object('room_type_id', t.id, 'night', n);
          v_restored := v_restored + 1;
        end if;
        continue;
      end if;
      if v_has and a.applied_minor = v_sug then continue; end if;        -- already at the right price

      v_up := v_up || jsonb_build_object('room_type_id', t.id, 'night', n, 'amount', v_sug);
      v_tup := v_tup || jsonb_build_object('room_type_id', t.id, 'night', n, 'base', v_base, 'applied', v_sug, 'original', case when v_has then a.original_row else v_daily is not null end);
      v_set := v_set + 1;
    end loop;
  end loop;

  if jsonb_array_length(v_up) > 0 then
    insert into daily_rates (tenant_id, property_id, room_type_id, rate_plan_id, business_date, amount_minor)
    select v_prop.tenant_id, p_property, x.room_type_id, v_plan, x.night, x.amount
      from jsonb_to_recordset(v_up) as x(room_type_id uuid, night date, amount bigint)
    on conflict (property_id, room_type_id, rate_plan_id, business_date) do update set amount_minor = excluded.amount_minor;
  end if;
  if jsonb_array_length(v_del) > 0 then
    delete from daily_rates d using jsonb_to_recordset(v_del) as x(room_type_id uuid, night date)
     where d.property_id = p_property and d.rate_plan_id = v_plan and d.room_type_id = x.room_type_id and d.business_date = x.night;
  end if;
  if jsonb_array_length(v_tup) > 0 then
    insert into pricing_applied (tenant_id, property_id, room_type_id, rate_plan_id, business_date, status, base_minor, applied_minor, original_row)
    select v_prop.tenant_id, p_property, x.room_type_id, v_plan, x.night, 'applied', x.base, x.applied, x.original
      from jsonb_to_recordset(v_tup) as x(room_type_id uuid, night date, base bigint, applied bigint, original boolean)
    on conflict (property_id, room_type_id, rate_plan_id, business_date)
      do update set applied_minor = excluded.applied_minor, status = 'applied', updated_at = now();
  end if;
  if jsonb_array_length(v_tdel) > 0 then
    delete from pricing_applied a2 using jsonb_to_recordset(v_tdel) as x(room_type_id uuid, night date)
     where a2.property_id = p_property and a2.rate_plan_id = v_plan and a2.room_type_id = x.room_type_id and a2.business_date = x.night;
  end if;
  if jsonb_array_length(v_tman) > 0 then
    update pricing_applied a2 set status = 'manual', updated_at = now() from jsonb_to_recordset(v_tman) as x(room_type_id uuid, night date)
     where a2.property_id = p_property and a2.rate_plan_id = v_plan and a2.room_type_id = x.room_type_id and a2.business_date = x.night;
  end if;
  delete from pricing_applied where property_id = p_property and business_date < v_today;     -- nights that have passed

  v_summary := jsonb_build_object('nights_set', v_set, 'nights_restored', v_restored, 'nights_by_hand', v_manual, 'by', p_by);
  update pricing_settings set last_applied_at = now(), last_summary = v_summary where property_id = p_property;
  perform write_audit(v_prop.tenant_id, p_property, p_actor, 'pricing.applied', 'property', p_property, null, v_summary);
  return v_summary;
end $$;
revoke all on function pricing_apply_property(uuid, uuid, text) from public, anon, authenticated;

-- ---- Putting every night back ----------------------------------------------------------------------------------------------
-- A night the job still owns (its daily rate is still the one the job wrote) goes back to the price it had: the old daily rate, or no
-- daily rate if there was none. A night a person changed is left exactly as they set it. All tracking for the hotel is then removed.
create function pricing_revert_property(p_property uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_restored integer := 0; v_cleared integer := 0; v_n integer;
begin
  update daily_rates d set amount_minor = a.base_minor
    from pricing_applied a
   where a.property_id = p_property and a.status = 'applied' and a.original_row
     and d.property_id = a.property_id and d.room_type_id = a.room_type_id and d.rate_plan_id = a.rate_plan_id
     and d.business_date = a.business_date and d.amount_minor = a.applied_minor;
  get diagnostics v_n = row_count;
  v_restored := v_n;

  delete from daily_rates d using pricing_applied a
   where a.property_id = p_property and a.status = 'applied' and not a.original_row
     and d.property_id = a.property_id and d.room_type_id = a.room_type_id and d.rate_plan_id = a.rate_plan_id
     and d.business_date = a.business_date and d.amount_minor = a.applied_minor;
  get diagnostics v_n = row_count;
  v_cleared := v_n;

  delete from pricing_applied where property_id = p_property;
  return jsonb_build_object('nights_restored', v_restored, 'rates_removed', v_cleared);
end $$;
revoke all on function pricing_revert_property(uuid) from public, anon, authenticated;

-- ---- Settings, switch, run now ---------------------------------------------------------------------------------------------
create function pricing_settings_get(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s pricing_settings%rowtype;
begin
  if p_property is null or not (has_permission(p_property, 'rate.view') or has_permission(p_property, 'rate.manage')) then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  select * into s from pricing_settings where property_id = p_property;
  return jsonb_build_object(
    'auto_apply', coalesce(s.auto_apply, false), 'last_applied_at', s.last_applied_at, 'last_summary', s.last_summary,
    'nights_managed', (select count(*) from pricing_applied where property_id = p_property and status = 'applied'),
    'nights_by_hand', (select count(*) from pricing_applied where property_id = p_property and status = 'manual'));
end $$;
revoke all on function pricing_settings_get(uuid) from public, anon;
grant execute on function pricing_settings_get(uuid) to authenticated;

create function set_pricing_auto_apply(p_property uuid, p_on boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_prop properties%rowtype; v_actor uuid; v_was boolean; v_result jsonb;
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'rate.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_on is null then raise exception 'POLICY_VIOLATION: switch' using errcode = 'P0001'; end if;
  if p_on and not tenant_feature_on(v_prop.tenant_id, 'dynamic_pricing') then raise exception 'POLICY_VIOLATION: dynamic pricing off' using errcode = 'P0001'; end if;

  insert into pricing_settings (property_id, tenant_id) values (p_property, v_prop.tenant_id) on conflict (property_id) do nothing;
  select auto_apply into v_was from pricing_settings where property_id = p_property for update;
  if v_was = p_on then return jsonb_build_object('auto_apply', p_on, 'changed', false); end if;

  update pricing_settings set auto_apply = p_on, updated_at = now(), updated_by = v_actor where property_id = p_property;
  if p_on then
    perform write_audit(v_prop.tenant_id, p_property, v_actor, 'pricing.auto_on', 'property', p_property, null, '{}'::jsonb);
    v_result := pricing_apply_property(p_property, v_actor, 'switch on');
  else
    v_result := pricing_revert_property(p_property);
    update pricing_settings set last_summary = null where property_id = p_property;
    perform write_audit(v_prop.tenant_id, p_property, v_actor, 'pricing.auto_off', 'property', p_property, null, v_result);
  end if;
  return jsonb_build_object('auto_apply', p_on, 'changed', true, 'result', v_result);
end $$;
revoke all on function set_pricing_auto_apply(uuid, boolean) from public, anon;
grant execute on function set_pricing_auto_apply(uuid, boolean) to authenticated;

create function pricing_apply_now(p_property uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_prop properties%rowtype; v_actor uuid; v_on boolean;
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'rate.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(v_prop.tenant_id, 'dynamic_pricing') then raise exception 'POLICY_VIOLATION: dynamic pricing off' using errcode = 'P0001'; end if;
  select auto_apply into v_on from pricing_settings where property_id = p_property for update;
  if v_on is not true then raise exception 'POLICY_VIOLATION: auto apply off' using errcode = 'P0001'; end if;
  return pricing_apply_property(p_property, v_actor, 'apply now');
end $$;
revoke all on function pricing_apply_now(uuid) from public, anon;
grant execute on function pricing_apply_now(uuid) to authenticated;

-- ---- The cron's job --------------------------------------------------------------------------------------------------------
create function apply_due_pricing() returns integer
language plpgsql security definer set search_path = public as $$
declare s record; v_n integer := 0; v_res jsonb;
begin
  for s in select property_id, tenant_id from pricing_settings where auto_apply order by property_id for update skip locked loop
    begin
      if tenant_feature_on(s.tenant_id, 'dynamic_pricing') then
        perform pricing_apply_property(s.property_id, null, 'maintenance');
      else
        -- the plan no longer includes dynamic pricing: switch it off and put the prices back
        v_res := pricing_revert_property(s.property_id);
        update pricing_settings set auto_apply = false, last_summary = null, updated_at = now() where property_id = s.property_id;
        perform write_audit(s.tenant_id, s.property_id, null, 'pricing.auto_off', 'property', s.property_id, null, v_res || jsonb_build_object('by', 'plan'));
      end if;
      v_n := v_n + 1;
    exception when others then
      raise warning 'apply_due_pricing: property % failed: %', s.property_id, sqlerrm;
    end;
  end loop;
  return v_n;
end $$;
revoke all on function apply_due_pricing() from public, anon, authenticated;
grant execute on function apply_due_pricing() to service_role;
