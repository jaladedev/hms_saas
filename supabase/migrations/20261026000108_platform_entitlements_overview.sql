-- 108 Every hotel group's feature flags in one read, for the platform's entitlements grid (prototype "Feature Entitlements Matrix").
--
-- platform_entitlements_overview(): platform support or admin (anyone else NOT_FOUND). Returns {enforced, hotels}: the flags the
-- platform really enforces (plan_enforced_flags, the single source) and one row per hotel group with its name, slug, status, latest
-- plan and the flags set for it (feature_key, enabled). It reads nothing but those tables, so no reservation, guest or
-- payment data and no secret can appear. Read only: changing a flag stays on the hotel's own page (platform_set_entitlement, admin).

create function platform_entitlements_overview() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform platform_require('support');
  return jsonb_build_object('enforced', to_jsonb(plan_enforced_flags()), 'hotels', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', t.id, 'name', t.name, 'slug', t.slug, 'status', t.status,
      'plan_code', (select s.plan_code from tenant_subscriptions s where s.tenant_id = t.id order by s.created_at desc limit 1),
      'subscription_status', (select s.status from tenant_subscriptions s where s.tenant_id = t.id order by s.created_at desc limit 1),
      'entitlements', coalesce((select jsonb_agg(jsonb_build_object('feature_key', f.feature_key, 'enabled', f.enabled) order by f.feature_key)
                                  from tenant_feature_entitlements f where f.tenant_id = t.id), '[]'::jsonb)
    ) order by t.name)
    from tenants t), '[]'::jsonb));
end $$;
revoke all on function platform_entitlements_overview() from public, anon;
grant execute on function platform_entitlements_overview() to authenticated;
