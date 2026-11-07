-- The reports.export flag (migration 052). Runs after 51 and 52, which create the group 't50-hotel' and its owner f053.
\set ON_ERROR_STOP on

do $$
declare
  v_t   uuid := (select id from tenants where slug = 't50-hotel');
  v_p   uuid := (select id from properties where tenant_id = (select id from tenants where slug = 't50-hotel') limit 1);
  v_oth uuid; v_othp uuid; v_othu uuid;
begin
  -- a user who can export in another group (any other tenant's owner)
  select m.user_id, pr.id, m.tenant_id into v_othu, v_othp, v_oth
    from tenant_memberships m join membership_roles mr on mr.membership_id = m.id join roles r on r.id = mr.role_id
    join properties pr on pr.tenant_id = m.tenant_id
   where r.key = 'owner' and m.status = 'active' and m.tenant_id <> v_t and mr.property_id is null order by m.created_at, pr.id limit 1;
  if v_othu is null then raise exception 'FAIL test setup: no other group owner'; end if;

  -- 1. no flag row: exporting works (the default is on)
  perform t_as('00000000-0000-0000-0000-00000000f053');
  if not has_permission(v_p, 'report.export') or not has_permission(v_p, 'report.view') then raise exception 'FAIL the owner cannot export with no flag row'; end if;

  -- 2. an unrelated flag off changes nothing
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'online_payments', false);
  perform t_as('00000000-0000-0000-0000-00000000f053');
  if not has_permission(v_p, 'report.export') then raise exception 'FAIL an unrelated flag removed export'; end if;

  -- 3. flag on: still works
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'reports.export', true);
  perform t_as('00000000-0000-0000-0000-00000000f053');
  if not has_permission(v_p, 'report.export') then raise exception 'FAIL export lost with the flag on'; end if;

  -- 4. flag off: export gone for this group only; viewing and every other permission remain
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'reports.export', false);
  perform t_as('00000000-0000-0000-0000-00000000f053');
  if has_permission(v_p, 'report.export') then raise exception 'FAIL export still allowed with the flag off'; end if;
  if not has_permission(v_p, 'report.view') or not has_permission(v_p, 'staff.manage') or not has_permission(v_p, 'invoice.issue') then raise exception 'FAIL another permission was lost'; end if;
  perform t_as(v_othu::text);
  if not has_permission(v_othp, 'report.export') then raise exception 'FAIL another group lost export'; end if;

  -- 5. flag back on: export returns
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'reports.export', true);
  perform t_as('00000000-0000-0000-0000-00000000f053');
  if not has_permission(v_p, 'report.export') then raise exception 'FAIL export did not return'; end if;

  -- 6. the helper is not callable by logins
  begin
    perform tenant_feature_on(v_t, 'reports.export');
    raise exception 'FAIL a login can call tenant_feature_on';
  exception when insufficient_privilege then null;
  end;
  perform t_sys();
  raise notice 'PASS reports.export off removes export for that group only, on or absent keeps it, other permissions and groups are untouched';
end $$;
