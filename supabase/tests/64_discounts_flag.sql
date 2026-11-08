-- The discounts flag (migration 063). Uses the group 't50-hotel' and its owner f053 (tests 51, 53).
\set ON_ERROR_STOP on

do $$
declare
  v_t uuid := (select id from tenants where slug = 't50-hotel');
  v_p uuid := (select id from properties where tenant_id = (select id from tenants where slug = 't50-hotel') limit 1);
begin
  perform t_as('00000000-0000-0000-0000-00000000f053');
  if not has_permission(v_p, 'discount.apply') then raise exception 'FAIL the owner cannot discount with no flag row'; end if;

  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'reports.export', false);
  perform t_as('00000000-0000-0000-0000-00000000f053');
  if not has_permission(v_p, 'discount.apply') then raise exception 'FAIL an unrelated flag removed discounts'; end if;

  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'reports.export', true);
  perform platform_set_entitlement(v_t, 'discounts', false);
  perform t_as('00000000-0000-0000-0000-00000000f053');
  if has_permission(v_p, 'discount.apply') then raise exception 'FAIL discounts allowed with the flag off'; end if;
  if not has_permission(v_p, 'report.export') or not has_permission(v_p, 'invoice.issue') or not has_permission(v_p, 'staff.manage') then raise exception 'FAIL another permission was lost'; end if;

  -- another group keeps discounting
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if not has_permission('00000000-0000-0000-0000-0000000000a2', 'discount.apply') then raise exception 'FAIL another group lost discounts'; end if;

  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'discounts', true);
  perform t_as('00000000-0000-0000-0000-00000000f053');
  if not has_permission(v_p, 'discount.apply') then raise exception 'FAIL discounts did not return'; end if;
  perform t_sys();
  raise notice 'PASS discounts off removes discount.apply for that group only; on or absent keeps it; other permissions and groups untouched';
end $$;

