-- The entitlements overview (migration 108). Platform people from 51: f050 admin, f051 support, f052 hotel owner; group 't50-hotel'.
\set ON_ERROR_STOP on

do $$ declare v_t uuid := (select id from tenants where slug = 't50-hotel'); v_all int; r jsonb; row jsonb; v_state text;
begin
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = v_t;
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values (v_t, 'discounts', false), (v_t, 'reports.export', true);
  delete from tenant_subscriptions where tenant_id = v_t;
  insert into tenant_subscriptions (tenant_id, plan_code, status) values (v_t, 'standard', 'active');

  v_all := (select count(*) from tenants);   -- counted here, as the system: a platform user's own view of tenants is limited by row security
  -- support and admin read; every group appears once with its flags and plan
  perform t_as('00000000-0000-0000-0000-00000000f051');
  r := platform_entitlements_overview();
  if r -> 'enforced' <> to_jsonb(plan_enforced_flags()) then raise exception 'FAIL enforced list %', r -> 'enforced'; end if;
  r := r -> 'hotels';
  if jsonb_array_length(r) <> v_all then raise exception 'FAIL not one row per group: %', jsonb_array_length(r); end if;
  select e into row from jsonb_array_elements(r) e where e ->> 'id' = v_t::text;
  if row ->> 'plan_code' <> 'standard' or row ->> 'subscription_status' <> 'active' then raise exception 'FAIL plan missing %', row; end if;
  if row -> 'entitlements' <> '[{"feature_key":"discounts","enabled":false},{"feature_key":"reports.export","enabled":true}]'::jsonb then raise exception 'FAIL flags %', row -> 'entitlements'; end if;
  if row ?| array['secret', 'secret_reference', 'host', 'email'] then raise exception 'FAIL unexpected keys %', row; end if;
  perform t_as('00000000-0000-0000-0000-00000000f050');
  if jsonb_array_length(platform_entitlements_overview() -> 'hotels') <> v_all then raise exception 'FAIL admin cannot read'; end if;

  -- a hotel owner and a signed-out caller get nothing
  perform t_as('00000000-0000-0000-0000-00000000f052');
  perform t_expect('select platform_entitlements_overview()', 'NOT_FOUND');
  perform t_sys();
  begin
    set local role anon;
    perform platform_entitlements_overview();
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could call platform_entitlements_overview'; end if;
  raise notice 'PASS platform entitlements overview: support and admin read one row per group with its flags; owner and anon refused';
end $$;
