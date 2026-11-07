-- 051 Plan and feature flags for a hotel group, set by a platform admin.
--
-- 050 left the plan and entitlement tables untouched because plans and prices are not decided. This adds the two switches a
-- platform admin needs without deciding them: a plan is a free-text code (for example "starter") with a status, and a feature
-- flag is a free-text key that is on or off. Nothing in the app reads these yet, so setting them records what the group is
-- meant to have; it does not turn anything on or off. Enforcement comes when a first gated feature exists.
--
-- Audit: 047 already audits both tables by trigger with auth.uid() as the actor, so these functions write no extra rows and
-- a repeated call that changes nothing writes nothing.
-- Same access rule as 050: admin changes, support reads, anyone else gets NOT_FOUND.

create function platform_set_subscription(p_tenant uuid, p_plan_code text, p_status text, p_trial_ends_at timestamptz, p_period_end timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s tenant_subscriptions%rowtype; v_plan text := lower(btrim(coalesce(p_plan_code, '')));
begin
  perform platform_require('admin');
  if v_plan !~ '^[a-z0-9][a-z0-9_-]{1,39}$' then raise exception 'POLICY_VIOLATION: plan' using errcode = 'P0001'; end if;
  if p_status is null or p_status not in ('trial', 'active', 'past_due', 'cancelled') then raise exception 'POLICY_VIOLATION: subscription status' using errcode = 'P0001'; end if;
  perform 1 from tenants where id = p_tenant for update;   -- also serialises two admins editing the same group
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into s from tenant_subscriptions where tenant_id = p_tenant order by created_at desc limit 1;
  if not found then
    insert into tenant_subscriptions (tenant_id, plan_code, status, trial_ends_at, current_period_start, current_period_end)
    values (p_tenant, v_plan, p_status, p_trial_ends_at, now(), p_period_end);
    return jsonb_build_object('changed', true);
  end if;
  if s.plan_code = v_plan and s.status = p_status and s.trial_ends_at is not distinct from p_trial_ends_at and s.current_period_end is not distinct from p_period_end then
    return jsonb_build_object('changed', false);
  end if;
  update tenant_subscriptions set plan_code = v_plan, status = p_status, trial_ends_at = p_trial_ends_at, current_period_end = p_period_end where id = s.id;
  return jsonb_build_object('changed', true);
end $$;

create function platform_set_entitlement(p_tenant uuid, p_feature_key text, p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e tenant_feature_entitlements%rowtype; v_key text := lower(btrim(coalesce(p_feature_key, '')));
begin
  perform platform_require('admin');
  if v_key !~ '^[a-z][a-z0-9_.]{1,59}$' then raise exception 'POLICY_VIOLATION: feature key' using errcode = 'P0001'; end if;
  if p_enabled is null then raise exception 'POLICY_VIOLATION: enabled' using errcode = 'P0001'; end if;
  perform 1 from tenants where id = p_tenant for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into e from tenant_feature_entitlements where tenant_id = p_tenant and feature_key = v_key;
  if not found then
    insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values (p_tenant, v_key, p_enabled);
    return jsonb_build_object('changed', true);
  end if;
  if e.enabled = p_enabled then return jsonb_build_object('changed', false); end if;
  update tenant_feature_entitlements set enabled = p_enabled where id = e.id;
  return jsonb_build_object('changed', true);
end $$;

-- The detail now also lists the flags. (Same function as 050 plus one key; the rest is unchanged.)
create or replace function platform_tenant_detail(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t tenants%rowtype;
begin
  perform platform_require('support');
  select * into t from tenants where id = p_tenant;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return jsonb_build_object(
    'tenant', jsonb_build_object('id', t.id, 'name', t.name, 'slug', t.slug, 'status', t.status, 'currency', t.default_currency, 'created_at', t.created_at),
    'properties', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'code', p.code, 'city', p.city, 'state', p.state,
                     'timezone', p.timezone, 'currency', p.currency, 'status', p.status) order by p.name) from properties p where p.tenant_id = t.id), '[]'::jsonb),
    'domains', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'host', d.host, 'property_id', d.property_id, 'is_primary', d.is_primary,
                     'verified_at', d.verified_at) order by d.host) from tenant_domains d where d.tenant_id = t.id), '[]'::jsonb),
    'payment_accounts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'provider', a.provider, 'mode', a.mode, 'label', a.account_label,
                     'secret_reference', a.secret_reference, 'status', a.status) order by a.mode, a.account_label)
                     from payment_provider_accounts a where a.tenant_id = t.id), '[]'::jsonb),
    'owners', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email, 'status', m.status) order by u.email)
                     from tenant_memberships m join auth.users u on u.id = m.user_id
                    where m.tenant_id = t.id and exists (select 1 from membership_roles mr join roles r on r.id = mr.role_id
                                                          where mr.membership_id = m.id and r.key = 'owner')), '[]'::jsonb),
    'subscription', (select jsonb_build_object('plan_code', s.plan_code, 'status', s.status, 'trial_ends_at', s.trial_ends_at,
                     'current_period_end', s.current_period_end) from tenant_subscriptions s where s.tenant_id = t.id order by s.created_at desc limit 1),
    'entitlements', coalesce((select jsonb_agg(jsonb_build_object('feature_key', f.feature_key, 'enabled', f.enabled) order by f.feature_key)
                     from tenant_feature_entitlements f where f.tenant_id = t.id), '[]'::jsonb));
end $$;

revoke all on function platform_set_subscription(uuid, text, text, timestamptz, timestamptz), platform_set_entitlement(uuid, text, boolean) from public, anon;
grant execute on function platform_set_subscription(uuid, text, text, timestamptz, timestamptz), platform_set_entitlement(uuid, text, boolean) to authenticated;
