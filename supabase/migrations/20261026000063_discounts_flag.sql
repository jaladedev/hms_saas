-- 063 Third enforced flag: discounts.
--
-- Same rule as reports.export (052): when a hotel group has a flag row `discounts` with enabled = false, has_permission(property,
-- 'discount.apply') answers false for everyone in that group, so apply_discount and apply_discount_amount refuse (NOT_FOUND,
-- like any person without the permission) and the discount form disappears. A discount already on a booking stays on it, and
-- viewing, invoicing and payments are untouched. No row, or enabled = true, means on, so existing hotels keep discounting.
-- The flag lookup runs only for the two flagged permissions, so every other permission costs what it did before.
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
       and (p_permission <> 'discount.apply' or tenant_feature_on(m.tenant_id, 'discounts'))
  )
$$;
