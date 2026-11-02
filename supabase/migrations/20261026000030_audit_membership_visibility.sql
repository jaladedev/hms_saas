-- 030 Show staff access changes in the audit trail.
--
-- Suspending, reinstating and removing a staff member is recorded by set_staff_status() (019) as
-- 'staff.status_changed' on a membership, which belongs to the whole hotel group and so has no property.
-- audit_logs_select (007) only ever showed rows that have a property, so those rows were written but could be
-- read by nobody through the app, and the setup history screen could not list them.
--
-- This widens the policy in one narrow way: a row with no property, about a membership, in a hotel group where the
-- reader holds audit.view at some property, is now visible. Everything else is as before. Other rows without a
-- property (a guest being updated, platform events with no tenant) stay hidden, which is why this names the entity
-- type instead of showing every row that has no property.
--
--   can_view_tenant_audit(tenant) -> true when the caller holds audit.view at any property of that tenant
--     authenticated only; null tenant is never visible

create function can_view_tenant_audit(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_tenant is not null and exists (
    select 1 from properties p where p.tenant_id = p_tenant and has_permission(p.id, 'audit.view'))
$$;
revoke all on function can_view_tenant_audit(uuid) from public, anon;
grant execute on function can_view_tenant_audit(uuid) to authenticated;

drop policy audit_logs_select on audit_logs;
create policy audit_logs_select on audit_logs for select to authenticated
  using (
    (property_id is not null and has_permission(property_id, 'audit.view'))
    or (property_id is null and entity_type = 'membership' and can_view_tenant_audit(tenant_id))
  );
