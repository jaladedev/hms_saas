-- Dynamic pricing, step two (migration 152): automatic apply writes the suggested price into daily_rates. Hotel A: tenant a1, property a2, Standard a3.
-- Owner aa01, front desk aa04, other hotel's owner bb01. Nights are looked at two days out so the hotel's "today" cannot shift them.
\set ON_ERROR_STOP on

create function t152_rule(p_name text, p_percent numeric) returns void language plpgsql as $$
begin
  perform save_pricing_rule('00000000-0000-0000-0000-0000000000a2', null, null, p_name, 'weekday', null, null, array[1,2,3,4,5,6,7], null, null, p_percent, true);
end $$;
create function t152_clear() returns void language plpgsql as $$
declare r record;
begin
  for r in select id from pricing_rules where property_id = '00000000-0000-0000-0000-0000000000a2' loop perform delete_pricing_rule(r.id); end loop;
  perform set_pricing_limits('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', null, null);
end $$;
create function t152_rate(p_offset integer) returns bigint language sql security definer as $$
  select amount_minor from resolve_rate('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3',
    (select id from rate_plans where property_id = '00000000-0000-0000-0000-0000000000a2' and is_default), current_date + p_offset);
$$;

-- 1. permissions and the flag
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select set_pricing_auto_apply(%L, true)', v_p), 'NOT_FOUND');
  perform t_expect(format('select pricing_apply_now(%L)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select set_pricing_auto_apply(%L, true)', v_p), 'NOT_FOUND');
  perform t_expect(format('select pricing_settings_get(%L)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if (pricing_settings_get(v_p) ->> 'auto_apply')::boolean then raise exception 'FAIL default should be off'; end if;
  perform t_expect(format('select pricing_apply_now(%L)', v_p), 'POLICY_VIOLATION: auto apply off');
  perform t_sys();
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values ('00000000-0000-0000-0000-0000000000a1', 'dynamic_pricing', false);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select set_pricing_auto_apply(%L, true)', v_p), 'POLICY_VIOLATION: dynamic pricing off');
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = '00000000-0000-0000-0000-0000000000a1' and feature_key = 'dynamic_pricing';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin
    perform apply_due_pricing();
    raise exception 'FAIL staff ran the cron function';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS auto apply: permissions, default off, flag, cron function closed to staff';
end $$;

-- 2. switching on prices the nights, switching off puts them back
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t constant uuid := '00000000-0000-0000-0000-0000000000a3';
  v_plan uuid; v_before bigint; v_after bigint; r jsonb; v_rows_before integer; v_n jsonb; v_audit integer; begin
  perform t_sys();
  select id into v_plan from rate_plans where property_id = v_p and is_default;
  select count(*) into v_rows_before from daily_rates where property_id = v_p;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_before := t152_rate(2);
  -- no rules: switching on changes nothing
  r := set_pricing_auto_apply(v_p, true);
  if (r -> 'result' ->> 'nights_set')::int <> 0 then raise exception 'FAIL nothing should be set without rules: %', r; end if;
  if t152_rate(2) <> v_before then raise exception 'FAIL price moved without a rule'; end if;
  if (set_pricing_auto_apply(v_p, true) ->> 'changed')::boolean then raise exception 'FAIL repeat switch should be a no-op'; end if;

  perform t152_rule('Up 10', 10);
  r := pricing_apply_now(v_p);
  v_after := t152_rate(2);
  if v_after <> (round(v_before * 1.10 / 10000) * 10000)::bigint then raise exception 'FAIL applied price % vs base %', v_after, v_before; end if;
  if (r ->> 'nights_set')::int < 60 then raise exception 'FAIL expected the whole horizon: %', r; end if;
  -- running again does not compound
  perform pricing_apply_now(v_p);
  if t152_rate(2) <> v_after then raise exception 'FAIL price compounded on a second run'; end if;
  v_n := (select n from jsonb_array_elements(pricing_suggestions(v_p, current_date + 2, 3)) t, jsonb_array_elements(t -> 'nights') n
           where t ->> 'room_type_id' = v_t::text and (n ->> 'night')::date = current_date + 2);
  if (v_n ->> 'current_minor')::bigint <> v_after or (v_n ->> 'base_minor')::bigint <> v_before or not (v_n ->> 'auto')::boolean
     or (v_n ->> 'suggested_minor')::bigint <> v_after then raise exception 'FAIL suggestion view: %', v_n; end if;
  -- a changed rule moves from the original base, not from the last applied price
  perform t152_clear();
  perform t152_rule('Up 20', 20);
  perform pricing_apply_now(v_p);
  if t152_rate(2) <> (round(v_before * 1.20 / 10000) * 10000)::bigint then raise exception 'FAIL rule change did not move from the base'; end if;
  -- with no rule left the nights go back
  perform t152_clear();
  perform pricing_apply_now(v_p);
  if t152_rate(2) <> v_before then raise exception 'FAIL price not restored when rules went: % vs %', t152_rate(2), v_before; end if;
  if (pricing_settings_get(v_p) ->> 'nights_managed')::int <> 0 then raise exception 'FAIL nights still managed'; end if;

  -- off puts everything back and leaves the table as it was
  perform t152_rule('Up 10', 10);
  perform pricing_apply_now(v_p);
  r := set_pricing_auto_apply(v_p, false);
  if t152_rate(2) <> v_before then raise exception 'FAIL off did not restore'; end if;
  perform t_sys();
  if (select count(*) from daily_rates where property_id = v_p) <> v_rows_before then raise exception 'FAIL daily_rates rows differ after off'; end if;
  if exists (select 1 from pricing_applied where property_id = v_p) then raise exception 'FAIL tracking left behind'; end if;
  select count(*) into v_audit from audit_logs where entity_id = v_p and action in ('pricing.auto_on', 'pricing.auto_off', 'pricing.applied');
  if v_audit < 4 then raise exception 'FAIL not audited (%)', v_audit; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t152_clear();
  raise notice 'PASS auto apply: prices written from the base without compounding, restored on rule removal and on off, audited';
end $$;

-- 3. a person's own price wins, a night with an existing daily rate goes back to it, and the limits hold
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t constant uuid := '00000000-0000-0000-0000-0000000000a3';
  v_plan uuid; v_manual bigint; v_orig bigint; v_base3 bigint; v_base4 bigint; r jsonb; begin
  perform t_sys();
  select id into v_plan from rate_plans where property_id = v_p and is_default;
  -- night +4 already has a daily rate set by hand before auto-apply
  v_base3 := t152_rate(3);
  v_orig := (t152_rate(4) / 10000 + 1) * 10000;
  insert into daily_rates (tenant_id, property_id, room_type_id, rate_plan_id, business_date, amount_minor)
    values ('00000000-0000-0000-0000-0000000000a1', v_p, v_t, v_plan, current_date + 4, v_orig)
    on conflict (property_id, room_type_id, rate_plan_id, business_date) do update set amount_minor = excluded.amount_minor;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t152_rule('Up 10', 10);
  perform set_pricing_auto_apply(v_p, true);
  if t152_rate(4) <> (round(v_orig * 1.10 / 10000) * 10000)::bigint then raise exception 'FAIL existing daily rate should be the base'; end if;
  -- a person changes night +3 afterwards
  perform t_sys();
  v_manual := t152_rate(3) + 50000;
  update daily_rates set amount_minor = v_manual where property_id = v_p and room_type_id = v_t and rate_plan_id = v_plan and business_date = current_date + 3;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := pricing_apply_now(v_p);
  if t152_rate(3) <> v_manual then raise exception 'FAIL the manual price was overwritten'; end if;
  if (r ->> 'nights_by_hand')::int < 1 then raise exception 'FAIL by-hand count: %', r; end if;
  -- the ceiling holds an applied price
  perform set_pricing_limits(v_p, v_t, null, v_base3);
  perform pricing_apply_now(v_p);
  if t152_rate(5) > v_base3 then raise exception 'FAIL ceiling not held'; end if;
  perform t152_clear();
  -- off: the hand-set night stays, the earlier daily rate returns, the rest are as before
  perform set_pricing_auto_apply(v_p, false);
  if t152_rate(3) <> v_manual or t152_rate(4) <> v_orig then raise exception 'FAIL restore after off: % %', t152_rate(3), t152_rate(4); end if;
  perform t_sys();
  delete from daily_rates where property_id = v_p and room_type_id = v_t and rate_plan_id = v_plan and business_date in (current_date + 3, current_date + 4);
  raise notice 'PASS auto apply: hand-set price wins, earlier daily rate is the base and returns, ceiling holds';
end $$;

-- 4. the cron
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_n integer; v_base bigint; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_base := t152_rate(2);
  perform t152_rule('Up 10', 10);
  perform set_pricing_auto_apply(v_p, true);
  perform t_sys();
  v_n := apply_due_pricing();
  if v_n < 1 then raise exception 'FAIL cron ran % hotels', v_n; end if;
  if (select last_applied_at from pricing_settings where property_id = v_p) is null then raise exception 'FAIL last run not recorded'; end if;
  -- plan loses the flag: the cron switches the hotel off and restores prices
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values ('00000000-0000-0000-0000-0000000000a1', 'dynamic_pricing', false);
  perform apply_due_pricing();
  if (select auto_apply from pricing_settings where property_id = v_p) then raise exception 'FAIL not switched off when the flag went'; end if;
  if t152_rate(2) <> v_base then raise exception 'FAIL prices not restored when the flag went'; end if;
  delete from tenant_feature_entitlements where tenant_id = '00000000-0000-0000-0000-0000000000a1' and feature_key = 'dynamic_pricing';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t152_clear();
  raise notice 'PASS auto apply: cron runs switched-on hotels, switches off and restores when the plan loses the flag';
end $$;
