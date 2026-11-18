-- Dynamic pricing, step one (migration 146): rules, limits and suggestions. Hotel A: tenant a1, property a2, Standard a3. Owner aa01, front desk aa04,
-- other hotel's owner bb01. Suggestions start two days out so the hotel's own "today" (Lagos) cannot shift a night's lead time between 0 and 1.
\set ON_ERROR_STOP on

create function t146_rule(p_name text, p_kind text, p_percent numeric, p_from integer default null, p_to integer default null,
                          p_days integer[] default null, p_df date default null, p_dt date default null, p_type uuid default null,
                          p_active boolean default true, p_rule uuid default null) returns jsonb
language sql as $$
  select save_pricing_rule('00000000-0000-0000-0000-0000000000a2', p_rule, p_type, p_name, p_kind, p_from, p_to, p_days, p_df, p_dt, p_percent, p_active);
$$;
-- one night of one room type from the suggestions
create function t146_night(p_offset integer) returns jsonb
language sql as $$
  select n from jsonb_array_elements(pricing_suggestions('00000000-0000-0000-0000-0000000000a2', current_date + 2, 30)) t,
                jsonb_array_elements(t -> 'nights') n
   where t ->> 'room_type_id' = '00000000-0000-0000-0000-0000000000a3' and (n ->> 'night')::date = current_date + 2 + p_offset;
$$;
create function t146_clear() returns void language plpgsql as $$
declare r record;
begin
  for r in select id from pricing_rules where property_id = '00000000-0000-0000-0000-0000000000a2' loop perform delete_pricing_rule(r.id); end loop;
  perform set_pricing_limits('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', null, null);
end $$;

-- 1. who may write and read, and what is accepted
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb; v_id uuid; l jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect('select t146_rule(''Weekend'', ''weekday'', 10, null, null, array[5,6])', 'NOT_FOUND');          -- front desk reads rates, never writes rules
  perform t_expect(format('select set_pricing_limits(%L, ''00000000-0000-0000-0000-0000000000a3'', 1000, 2000)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect('select t146_rule(''Weekend'', ''weekday'', 10, null, null, array[5,6])', 'NOT_FOUND');
  perform t_expect(format('select pricing_rule_list(%L)', v_p), 'NOT_FOUND');
  perform t_expect(format('select pricing_suggestions(%L, current_date, 7)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := t146_rule('  Weekend  ', 'weekday', 10, null, null, array[6, 5, 5]);
  v_id := (r ->> 'rule_id')::uuid;
  l := pricing_rule_list(v_p);
  if jsonb_array_length(l) <> 1 or l -> 0 ->> 'name' <> 'Weekend' or l -> 0 -> 'weekdays' <> '[5, 6]'::jsonb then raise exception 'FAIL list %', l; end if;
  perform t_expect('select t146_rule('''', ''weekday'', 10, null, null, array[1])', 'POLICY_VIOLATION: name');
  perform t_expect('select t146_rule(''x'', ''magic'', 10)', 'POLICY_VIOLATION: kind');
  perform t_expect('select t146_rule(''x'', ''weekday'', 0, null, null, array[1])', 'POLICY_VIOLATION: percent');
  perform t_expect('select t146_rule(''x'', ''weekday'', 101, null, null, array[1])', 'POLICY_VIOLATION: percent');
  perform t_expect('select t146_rule(''x'', ''weekday'', -51, null, null, array[1])', 'POLICY_VIOLATION: percent');
  perform t_expect('select t146_rule(''x'', ''weekday'', 5.555, null, null, array[1])', 'POLICY_VIOLATION: percent');
  perform t_expect('select t146_rule(''x'', ''weekday'', 5, null, null, array[8])', 'POLICY_VIOLATION: weekdays');
  perform t_expect('select t146_rule(''x'', ''weekday'', 5)', 'POLICY_VIOLATION: weekdays');
  perform t_expect('select t146_rule(''x'', ''occupancy'', 5, 60, 40)', 'POLICY_VIOLATION: band');
  perform t_expect('select t146_rule(''x'', ''occupancy'', 5, 0, 101)', 'POLICY_VIOLATION: band');
  perform t_expect('select t146_rule(''x'', ''lead_time'', 5, 0, 366)', 'POLICY_VIOLATION: band');
  perform t_expect('select t146_rule(''x'', ''event'', 5, null, null, null, current_date + 5, current_date + 1)', 'POLICY_VIOLATION: dates');
  perform t_expect('select t146_rule(''x'', ''event'', 5, null, null, null, null, null)', 'POLICY_VIOLATION: dates');
  perform t_expect(format('select t146_rule(''x'', ''weekday'', 5, null, null, array[1], null, null, %L)', gen_random_uuid()), 'POLICY_VIOLATION: room type');
  perform t_expect(format('select save_pricing_rule(%L, %L, null, ''x'', ''weekday'', null, null, array[1], null, null, 5, true)', v_p, gen_random_uuid()), 'NOT_FOUND');
  perform t_expect(format('select set_pricing_limits(%L, ''00000000-0000-0000-0000-0000000000a3'', 5000, 4000)', v_p), 'POLICY_VIOLATION: limits');
  perform t_expect(format('select set_pricing_limits(%L, ''00000000-0000-0000-0000-0000000000a3'', 0, 4000)', v_p), 'POLICY_VIOLATION: limits');
  perform t_expect(format('select set_pricing_limits(%L, %L, 1000, 2000)', v_p, gen_random_uuid()), 'NOT_FOUND');
  -- an edit changes the rule in place and can change its kind (the unused columns are cleared)
  perform t146_rule('Weekend', 'occupancy', 12.5, 70, 100, null, null, null, null, true, v_id);
  l := pricing_rule_list(v_p);
  if jsonb_array_length(l) <> 1 or l -> 0 ->> 'kind' <> 'occupancy' or (l -> 0 ->> 'adjust_percent')::numeric <> 12.5
     or l -> 0 -> 'weekdays' <> 'null'::jsonb or (l -> 0 ->> 'band_from')::int <> 70 then raise exception 'FAIL edit %', l; end if;
  perform t_sys();
  if not exists (select 1 from audit_logs where entity_id = v_id and action = 'pricing_rule.saved') then raise exception 'FAIL not audited'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform delete_pricing_rule(v_id);
  perform t_expect(format('select delete_pricing_rule(%L)', v_id), 'NOT_FOUND');
  perform t_sys();
  if not exists (select 1 from audit_logs where entity_id = v_id and action = 'pricing_rule.deleted') then raise exception 'FAIL delete not audited'; end if;
  raise notice 'PASS pricing rules: permissions, validation, edit, delete and audit';
end $$;

-- 2. the suggestion maths, and that nothing real changes
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t constant uuid := '00000000-0000-0000-0000-0000000000a3';
  n jsonb; cur bigint; v_before bigint; v_rate_before bigint; v_rate_after bigint; v_plan uuid; v_floor bigint; r record; begin
  perform t_sys();
  select id into v_plan from rate_plans where property_id = v_p and is_default;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  n := t146_night(0);
  if n is null then raise exception 'FAIL no suggestion for a night with a rate'; end if;
  cur := (n ->> 'current_minor')::bigint;
  if (n ->> 'suggested_minor')::bigint <> cur or (n ->> 'change_percent')::numeric <> 0 or n -> 'rules' <> '[]'::jsonb then raise exception 'FAIL no rules should mean no change: %', n; end if;
  perform t_sys();
  select count(*) into v_before from daily_rates where property_id = v_p;
  select amount_minor into v_rate_before from resolve_rate(v_p, v_t, v_plan, current_date + 2);

  -- two rules that both match every night add up: +10 and +5 is +15, rounded to the nearest 100 naira
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t146_rule('All days', 'weekday', 10, null, null, array[1, 2, 3, 4, 5, 6, 7]);
  perform t146_rule('Far ahead', 'lead_time', 5, 0, 365);
  n := t146_night(0);
  if (n ->> 'change_percent')::numeric <> 15 or (n ->> 'suggested_minor')::bigint <> (round(cur * 1.15 / 10000) * 10000)::bigint
     or jsonb_array_length(n -> 'rules') <> 2 or n ->> 'limited' is not null then raise exception 'FAIL added rules: %', n; end if;

  -- a rule for another room type, an inactive rule and a rule outside its dates do not apply
  perform t146_rule('Other type', 'weekday', 50, null, null, array[1, 2, 3, 4, 5, 6, 7], null, null, (select id from room_types where property_id = v_p and id <> v_t limit 1));
  perform t146_rule('Switched off', 'weekday', 40, null, null, array[1, 2, 3, 4, 5, 6, 7], null, null, null, false);
  perform t146_rule('Far event', 'event', 30, null, null, null, current_date + 200, current_date + 205);
  n := t146_night(0);
  if (n ->> 'change_percent')::numeric <> 15 then raise exception 'FAIL rules that should not match did: %', n; end if;

  -- an event rule covers only its own nights
  perform t146_rule('Two nights', 'event', 20, null, null, null, current_date + 3, current_date + 4);
  if (t146_night(0) ->> 'change_percent')::numeric <> 15 or (t146_night(1) ->> 'change_percent')::numeric <> 35
     or (t146_night(2) ->> 'change_percent')::numeric <> 35 or (t146_night(3) ->> 'change_percent')::numeric <> 15 then raise exception 'FAIL event window'; end if;

  -- an occupancy rule matches by the share of rooms taken that night (here every night: the band is 0 to 100)
  perform t146_clear();
  perform t146_rule('Any occupancy', 'occupancy', 8, 0, 100, null, null, null, v_t);
  n := t146_night(0);
  if n ->> 'occupancy_percent' is null or (n ->> 'change_percent')::numeric <> 8 then raise exception 'FAIL occupancy rule: %', n; end if;
  -- ... and a band that cannot match leaves the price alone (only a fully taken night is 100 and it is not 0 to 0 either unless empty)
  perform t146_clear();
  perform t146_rule('Impossible band', 'occupancy', 8, 100, 100, null, null, null, v_t);
  n := t146_night(0);
  if (n ->> 'occupancy_percent')::numeric < 100 and (n ->> 'change_percent')::numeric <> 0 then raise exception 'FAIL occupancy band matched outside its band: %', n; end if;

  -- the ceiling and the floor hold the suggestion
  perform t146_clear();
  perform t146_rule('Up', 'weekday', 40, null, null, array[1, 2, 3, 4, 5, 6, 7]);
  perform set_pricing_limits(v_p, v_t, null, cur);
  n := t146_night(0);
  if (n ->> 'suggested_minor')::bigint <> cur or n ->> 'limited' <> 'ceiling' then raise exception 'FAIL ceiling: %', n; end if;
  perform t146_clear();
  perform t146_rule('Down', 'weekday', -50, null, null, array[1, 2, 3, 4, 5, 6, 7]);
  v_floor := (cur * 0.9)::bigint;
  perform set_pricing_limits(v_p, v_t, v_floor, null);
  n := t146_night(0);
  if (n ->> 'suggested_minor')::bigint <> v_floor or n ->> 'limited' <> 'floor' then raise exception 'FAIL floor: %', n; end if;
  if (select floor_minor from pricing_limits_list(v_p) l, jsonb_to_recordset(l) as x(room_type_id uuid, floor_minor bigint) where x.room_type_id = v_t) is distinct from v_floor then
    raise exception 'FAIL limits list';
  end if;

  -- the range of days is checked
  perform t_expect(format('select pricing_suggestions(%L, current_date, 0)', v_p), 'POLICY_VIOLATION: range');
  perform t_expect(format('select pricing_suggestions(%L, current_date, 61)', v_p), 'POLICY_VIOLATION: range');

  -- nothing real moved: the same daily rates, the same resolve_rate answer
  perform t146_clear();
  perform t_sys();
  select amount_minor into v_rate_after from resolve_rate(v_p, v_t, v_plan, current_date + 2);
  if (select count(*) from daily_rates where property_id = v_p) <> v_before or v_rate_after <> v_rate_before then raise exception 'FAIL a real price moved'; end if;
  raise notice 'PASS pricing suggestions: rules add, event windows, occupancy, floor and ceiling, no real price moves';
end $$;

-- 3. the plan flag: off means no writes and no suggestions, reading the rules still works
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_id uuid; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_id := (t146_rule('Keep', 'weekday', 5, null, null, array[1]) ->> 'rule_id')::uuid;
  perform t_sys();
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values ('00000000-0000-0000-0000-0000000000a1', 'dynamic_pricing', false);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect('select t146_rule(''New'', ''weekday'', 5, null, null, array[2])', 'POLICY_VIOLATION: dynamic pricing off');
  perform t_expect(format('select delete_pricing_rule(%L)', v_id), 'POLICY_VIOLATION: dynamic pricing off');
  perform t_expect(format('select set_pricing_limits(%L, ''00000000-0000-0000-0000-0000000000a3'', 1000, 2000)', v_p), 'POLICY_VIOLATION: dynamic pricing off');
  perform t_expect(format('select pricing_suggestions(%L, current_date, 7)', v_p), 'POLICY_VIOLATION: dynamic pricing off');
  if jsonb_array_length(pricing_rule_list(v_p)) <> 1 then raise exception 'FAIL rules should stay readable with the flag off'; end if;
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = '00000000-0000-0000-0000-0000000000a1' and feature_key = 'dynamic_pricing';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t146_clear();
  perform t_sys();
  if not ('dynamic_pricing' = any (plan_enforced_flags())) then raise exception 'FAIL flag not in the enforced list'; end if;
  raise notice 'PASS pricing flag: off blocks writes and suggestions, rules stay readable, listed as enforced';
end $$;
