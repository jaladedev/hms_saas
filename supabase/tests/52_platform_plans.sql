-- Plan and feature flags (migration 051). Runs after 51, which creates the group 't50-hotel'. Reuses t_as / t_sys / t_expect (05).
--   f050 platform admin, f051 platform support, f052 an ordinary hotel owner.
\set ON_ERROR_STOP on

-- 1. Only an admin may change; support, a hotel owner and anon are refused; a bad value is refused
do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); begin
  perform t_as('00000000-0000-0000-0000-00000000f051');
  perform t_expect(format($q$select platform_set_subscription(%L, 'starter', 'trial', null, null)$q$, v_t), 'NOT_FOUND');
  perform t_expect(format($q$select platform_set_entitlement(%L, 'online_payments', true)$q$, v_t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000f052');
  perform t_expect(format($q$select platform_set_subscription(%L, 'starter', 'trial', null, null)$q$, v_t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform t_expect(format($q$select platform_set_subscription(%L, 'Bad Plan!', 'trial', null, null)$q$, v_t), 'POLICY_VIOLATION: plan');
  perform t_expect(format($q$select platform_set_subscription(%L, 'starter', 'free', null, null)$q$, v_t), 'POLICY_VIOLATION: subscription status');
  perform t_expect(format($q$select platform_set_subscription(%L, 'starter', null, null, null)$q$, v_t), 'POLICY_VIOLATION: subscription status');
  perform t_expect(format($q$select platform_set_entitlement(%L, 'Has Space', true)$q$, v_t), 'POLICY_VIOLATION: feature key');
  perform t_expect(format($q$select platform_set_entitlement(%L, 'x', true)$q$, v_t), 'POLICY_VIOLATION: feature key');
  perform t_expect(format($q$select platform_set_entitlement(%L, 'online_payments', null)$q$, v_t), 'POLICY_VIOLATION: enabled');
  perform t_expect($q$select platform_set_subscription(gen_random_uuid(), 'starter', 'trial', null, null)$q$, 'NOT_FOUND');
  perform t_expect($q$select platform_set_entitlement(gen_random_uuid(), 'online_payments', true)$q$, 'NOT_FOUND');
  perform t_sys();
  if exists (select 1 from tenant_subscriptions where tenant_id = v_t) or exists (select 1 from tenant_feature_entitlements where tenant_id = v_t) then
    raise exception 'FAIL a refused call changed something'; end if;
  raise notice 'PASS only an admin may set a plan or flag; support, an owner and bad values are refused and change nothing';
end $$;

-- 2. Setting a plan creates one row, a repeat changes nothing, a change updates the same row; all audited with the admin as actor
do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); r jsonb; n int; v_before bigint; begin
  perform t_as('00000000-0000-0000-0000-00000000f050');
  r := platform_set_subscription(v_t, ' Starter ', 'trial', '2026-12-01T00:00:00Z', null);
  if (r ->> 'changed') <> 'true' then raise exception 'FAIL first set %', r; end if;
  perform t_sys();
  select count(*) into v_before from audit_logs where tenant_id = v_t and entity_type = 'tenant_subscription';
  perform t_as('00000000-0000-0000-0000-00000000f050');
  r := platform_set_subscription(v_t, 'starter', 'trial', '2026-12-01T00:00:00Z', null);
  if (r ->> 'changed') <> 'false' then raise exception 'FAIL repeat should change nothing %', r; end if;
  r := platform_set_subscription(v_t, 'starter', 'active', null, '2027-01-01T00:00:00Z');
  if (r ->> 'changed') <> 'true' then raise exception 'FAIL update %', r; end if;
  perform t_sys();
  select count(*) into n from tenant_subscriptions where tenant_id = v_t;
  if n <> 1 then raise exception 'FAIL % subscription rows, expected 1', n; end if;
  if (select plan_code || '/' || status from tenant_subscriptions where tenant_id = v_t) <> 'starter/active' then raise exception 'FAIL stored values'; end if;
  if (select count(*) from audit_logs where tenant_id = v_t and entity_type = 'tenant_subscription') - v_before <> 1 then raise exception 'FAIL expected exactly one new audit row (the update); the repeat must write none'; end if;
  if not exists (select 1 from audit_logs where tenant_id = v_t and action = 'tenant_subscription.created' and actor_user_id = '00000000-0000-0000-0000-00000000f050') then raise exception 'FAIL created row not attributed to the admin'; end if;
  if not exists (select 1 from audit_logs where tenant_id = v_t and action = 'tenant_subscription.updated' and actor_user_id = '00000000-0000-0000-0000-00000000f050'
                  and metadata -> 'changed' -> 'status' ->> 'to' = 'active') then raise exception 'FAIL updated row not attributed or missing the change'; end if;
  raise notice 'PASS a plan is one row per group, set by code and status, repeat-safe, audited under the admin';
end $$;

-- 3. Flags: create, flip, repeat; key is normalised; audited
do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); r jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000f050');
  r := platform_set_entitlement(v_t, ' Online_Payments ', true);
  if (r ->> 'changed') <> 'true' then raise exception 'FAIL create flag'; end if;
  r := platform_set_entitlement(v_t, 'online_payments', true);
  if (r ->> 'changed') <> 'false' then raise exception 'FAIL repeat flag'; end if;
  r := platform_set_entitlement(v_t, 'online_payments', false);
  if (r ->> 'changed') <> 'true' then raise exception 'FAIL flip flag'; end if;
  perform platform_set_entitlement(v_t, 'reports.export', true);
  perform t_sys();
  if (select count(*) from tenant_feature_entitlements where tenant_id = v_t) <> 2 then raise exception 'FAIL flag rows'; end if;
  if (select enabled from tenant_feature_entitlements where tenant_id = v_t and feature_key = 'online_payments') then raise exception 'FAIL flag should be off'; end if;
  if (select count(*) from audit_logs where tenant_id = v_t and entity_type = 'tenant_feature_entitlement' and actor_user_id = '00000000-0000-0000-0000-00000000f050') <> 3 then
    raise exception 'FAIL expected 3 audit rows (two creates and one flip)'; end if;
  raise notice 'PASS flags are created, flipped and repeated safely, keys are normalised, and each change is audited under the admin';
end $$;

-- 4. Support sees plan and flags in the detail; the list shows the plan; another group is untouched
do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); d jsonb; e jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000f051');
  d := platform_tenant_detail(v_t);
  if d -> 'subscription' ->> 'plan_code' <> 'starter' or d -> 'subscription' ->> 'status' <> 'active' then raise exception 'FAIL detail plan %', d -> 'subscription'; end if;
  if jsonb_array_length(d -> 'entitlements') <> 2 or d -> 'entitlements' -> 0 ->> 'feature_key' <> 'online_payments' or (d -> 'entitlements' -> 0 ->> 'enabled') <> 'false' then raise exception 'FAIL detail flags %', d -> 'entitlements'; end if;
  select x into e from jsonb_array_elements(platform_list_tenants()) x where x ->> 'slug' = 't50-hotel';
  if e ->> 'plan_code' <> 'starter' or e ->> 'subscription_status' <> 'active' then raise exception 'FAIL list plan %', e; end if;
  perform t_sys();
  if exists (select 1 from tenant_subscriptions where tenant_id <> v_t) then raise exception 'FAIL another group got a plan'; end if;
  raise notice 'PASS support sees the plan and flags in the detail and the plan in the list; no other group was touched';
end $$;
