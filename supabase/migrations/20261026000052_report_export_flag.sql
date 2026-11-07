-- 052 The first feature flag that does something: reports.export.
--
-- 051 let a platform admin record feature flags, but nothing read them. This makes one of them real. When a hotel group has a
-- flag row `reports.export` with enabled = false, has_permission(property, 'report.export') answers false for everyone in that
-- group, so the CSV download buttons disappear and the download routes refuse. Viewing the reports is unaffected (report.view).
--
-- Rules chosen here:
--   * A flag that has no row means ON. Every existing hotel keeps exporting; only an explicit "off" removes it. (The table's
--     own default of enabled = false applies to a row that is inserted without a value, but 051 always inserts a value.)
--   * Only this permission is checked against a flag. Every other permission takes the same path as before.
--   * It is enforced in has_permission, the one place all five export checks already go through, so a future export is covered
--     by asking for the same permission.
-- has_permission is the most used function in the system, so the extra test is written to cost nothing for any other permission:
-- the flag lookup runs only when the permission asked for is report.export.

create function tenant_feature_on(p_tenant uuid, p_feature text) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from tenant_feature_entitlements where tenant_id = p_tenant and feature_key = p_feature and enabled = false)
$$;
revoke all on function tenant_feature_on(uuid, text) from public, anon, authenticated;

create or replace function has_permission(p_property uuid, p_permission text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from tenant_memberships m
      join membership_roles mr on mr.membership_id = m.id
      join role_permissions rp on rp.role_id = mr.role_id
      join permissions p on p.id = rp.permission_id
      join properties pr on pr.id = p_property and pr.tenant_id = m.tenant_id
     where m.user_id = (select auth.uid())
       and m.status = 'active'
       and p.key = p_permission
       and (mr.property_id is null or mr.property_id = p_property)
       and (p_permission <> 'report.export' or tenant_feature_on(m.tenant_id, 'reports.export'))
  )
$$;
