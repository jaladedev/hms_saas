-- Plan catalog (migration 097). Reuses the platform people from 51: f050 admin, f051 support, f052 hotel owner; group 't50-hotel'.
\set ON_ERROR_STOP on

-- 1. the starting plans exist with placeholder prices; admin and support read them, an owner and anon do not
do $$ declare r jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000f051');
  r := platform_list_plans();
  if jsonb_array_length(r) < 3 then raise exception 'FAIL starting plans missing %', r; end if;
  if (r -> 0 ->> 'code') <> 'starter' or (r -> 0 ->> 'price_is_placeholder') <> 'true' then raise exception 'FAIL first plan %', r -> 0; end if;
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_list_plans();
  perform t_as('00000000-0000-0000-0000-00000000f052');
  perform t_expect('select platform_list_plans()', 'NOT_FOUND');
  perform t_sys();
  raise notice 'PASS plan catalog: placeholder plans listed for admin and support, hidden from a hotel owner';
end $$;

-- 2. only an admin saves; bad values are refused and change nothing
do $$ declare v_n int; begin
  perform t_sys();
  select count(*) into v_n from plans;
  perform t_as('00000000-0000-0000-0000-00000000f051');
  perform t_expect($q$select platform_save_plan('team', 'Team', null, 100, '{}', true)$q$, 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000f052');
  perform t_expect($q$select platform_save_plan('team', 'Team', null, 100, '{}', true)$q$, 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform t_expect($q$select platform_save_plan('Bad Code', 'Team', null, 100, '{}', true)$q$, 'POLICY_VIOLATION: plan code');
  perform t_expect($q$select platform_save_plan('team', 'T', null, 100, '{}', true)$q$, 'POLICY_VIOLATION: plan name');
  perform t_expect($q$select platform_save_plan('team', 'Team', null, -1, '{}', true)$q$, 'POLICY_VIOLATION: plan price');
  perform t_expect($q$select platform_save_plan('team', 'Team', null, null, '{}', true)$q$, 'POLICY_VIOLATION: plan price');
  perform t_expect($q$select platform_save_plan('team', 'Team', null, 100, '{}', null)$q$, 'POLICY_VIOLATION: plan active');
  perform t_expect($q$select platform_save_plan('team', 'Team', null, 100, array['Bad Key!'], true)$q$, 'POLICY_VIOLATION: plan features');
  perform t_sys();
  if (select count(*) from plans) <> v_n then raise exception 'FAIL a refused call changed the catalog'; end if;
  raise notice 'PASS plan catalog: support, an owner and bad values are refused and change nothing';
end $$;

-- 3. creating, a repeat that changes nothing, an edit; features are tidied; the price stops being a placeholder; audited
do $$ declare r jsonb; v_before int; v_f text[]; begin
  perform t_as('00000000-0000-0000-0000-00000000f050');
  r := platform_save_plan(' Team ', ' Team  plan ', '  ', 2500000, array[' Online_Booking ', 'discounts', 'discounts', ''], true);
  if (r ->> 'changed') <> 'true' then raise exception 'FAIL create %', r; end if;
  perform t_sys();
  select features into v_f from plans where code = 'team';
  if v_f <> array['discounts', 'online_booking'] then raise exception 'FAIL features not tidied %', v_f; end if;
  if (select name from plans where code = 'team') <> 'Team plan' then raise exception 'FAIL name not tidied'; end if;
  if (select description from plans where code = 'team') is not null then raise exception 'FAIL blank description kept'; end if;
  if (select price_is_placeholder from plans where code = 'team') then raise exception 'FAIL saved price still a placeholder'; end if;
  if not exists (select 1 from audit_logs where entity_type = 'plan' and action = 'plan.created') then raise exception 'FAIL create not audited'; end if;
  select count(*) into v_before from audit_logs where entity_type = 'plan';

  perform t_as('00000000-0000-0000-0000-00000000f050');
  r := platform_save_plan('team', 'Team plan', null, 2500000, array['discounts', 'online_booking'], true);
  if (r ->> 'changed') <> 'false' then raise exception 'FAIL repeat should change nothing %', r; end if;
  r := platform_save_plan('team', 'Team plan', null, 3000000, array['discounts', 'online_booking'], true);
  if (r ->> 'changed') <> 'true' then raise exception 'FAIL price edit %', r; end if;
  perform t_sys();
  if (select monthly_price_minor from plans where code = 'team') <> 3000000 then raise exception 'FAIL price not saved'; end if;
  if (select count(*) from audit_logs where entity_type = 'plan') <> v_before + 1 then raise exception 'FAIL expected exactly one more audit row'; end if;
  -- saving a placeholder plan at its own price still counts as a decision
  perform t_as('00000000-0000-0000-0000-00000000f050');
  r := platform_save_plan('starter', 'Starter', 'Placeholder plan: one property, bookings and front desk.', 1500000, array['online_booking', 'online_payments'], true);
  perform t_sys();
  if (r ->> 'changed') <> 'true' or (select price_is_placeholder from plans where code = 'starter') then raise exception 'FAIL confirming a placeholder price %', r; end if;
  raise notice 'PASS plan catalog: created, tidied, repeat changes nothing, edit audited once, placeholder cleared by saving';
end $$;

-- 4. applying a plan sets the code and the enforced flags; other flags are left alone; a repeat changes nothing
do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); r jsonb; v_n int; begin
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = v_t;
  delete from tenant_subscriptions where tenant_id = v_t;
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values (v_t, 'beta.thing', true);

  perform t_as('00000000-0000-0000-0000-00000000f051');
  perform t_expect(format($q$select platform_apply_plan(%L, 'pro')$q$, v_t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform t_expect(format($q$select platform_apply_plan(%L, 'nope')$q$, v_t), 'POLICY_VIOLATION: plan');
  perform t_expect($q$select platform_apply_plan(gen_random_uuid(), 'pro')$q$, 'NOT_FOUND');

  r := platform_apply_plan(v_t, 'starter');
  if (r ->> 'changed') <> 'true' then raise exception 'FAIL apply %', r; end if;
  perform t_sys();
  if (select plan_code from tenant_subscriptions where tenant_id = v_t) <> 'starter' then raise exception 'FAIL plan code not set'; end if;
  select count(*) into v_n from tenant_feature_entitlements where tenant_id = v_t and feature_key = any (plan_enforced_flags());
  if v_n <> 11 then raise exception 'FAIL % of 11 flags set', v_n; end if;
  if not (select enabled from tenant_feature_entitlements where tenant_id = v_t and feature_key = 'online_booking') then raise exception 'FAIL online_booking should be on'; end if;
  if (select enabled from tenant_feature_entitlements where tenant_id = v_t and feature_key = 'reports.export') then raise exception 'FAIL reports.export should be off on starter'; end if;
  if not (select enabled from tenant_feature_entitlements where tenant_id = v_t and feature_key = 'beta.thing') then raise exception 'FAIL an unrelated flag was touched'; end if;

  perform t_as('00000000-0000-0000-0000-00000000f050');
  r := platform_apply_plan(v_t, 'starter');
  if (r ->> 'changed') <> 'false' then raise exception 'FAIL repeat apply should change nothing %', r; end if;
  r := platform_apply_plan(v_t, 'pro');
  perform t_sys();
  if (r ->> 'changed') <> 'true' or not (select enabled from tenant_feature_entitlements where tenant_id = v_t and feature_key = 'reports.export') then raise exception 'FAIL switching to pro %', r; end if;
  if (select count(*) from tenant_subscriptions where tenant_id = v_t) <> 1 then raise exception 'FAIL a second subscription row'; end if;
  raise notice 'PASS plan catalog: apply sets plan and the enforced flags, leaves other flags, repeat changes nothing';
end $$;

-- 5. an inactive plan cannot be applied; the catalog is closed to every login except through the functions
do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); v_state text; begin
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_save_plan('team', 'Team plan', null, 3000000, array['discounts'], false);
  perform t_expect(format($q$select platform_apply_plan(%L, 'team')$q$, v_t), 'POLICY_VIOLATION: plan');
  begin
    perform 1 from plans;
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  perform t_sys();
  if v_state <> 'refused' then raise exception 'FAIL a signed-in user read the plans table directly'; end if;
  begin
    set local role anon;
    perform platform_list_plans();
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could call platform_list_plans'; end if;
  raise notice 'PASS plan catalog: inactive plan not applicable, table closed to logins, anon refused';
end $$;
