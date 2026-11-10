-- Custom roles (migration 084): who may make them, what they may hold, how they are granted, and that groups never see each other's.
-- Reuses t_as / t_sys / t_expect (05). Users: aa01 owner A, aa04 front desk A, aa05 accountant A, aa02 housekeeping A, bb01 owner B.
\set ON_ERROR_STOP on

create function t86_denied(p_sql text) returns void language plpgsql as $$
begin execute p_sql; raise exception 'FAIL expected a refusal: %', p_sql;
exception when insufficient_privilege then null; end $$;

do $$ declare
  ta uuid := '00000000-0000-0000-0000-0000000000a1'; tb uuid := '00000000-0000-0000-0000-0000000000b1'; pa uuid := '00000000-0000-0000-0000-0000000000a2';
  owner text := '00000000-0000-0000-0000-00000000aa01'; fd text := '00000000-0000-0000-0000-00000000aa04';
  acc text := '00000000-0000-0000-0000-00000000aa05'; hk text := '00000000-0000-0000-0000-00000000aa02'; ob text := '00000000-0000-0000-0000-00000000bb01';
  r jsonb; rid uuid; rkey text; mr uuid; n integer; i integer;
begin
  perform t_sys();
  -- A. the owner makes a role; the key, permissions and audit are as written
  perform t_as(owner);
  r := create_custom_role(ta, 'Night auditor', array['report.view', 'report.export', 'reservation.view']);
  rid := (r ->> 'role_id')::uuid; rkey := r ->> 'key';
  if rkey <> 'custom.night-auditor.' || left(ta::text, 8) then raise exception 'FAIL key %', rkey; end if;
  perform t_sys();
  if (select tenant_id from roles where id = rid) <> ta or (select is_system from roles where id = rid) then raise exception 'FAIL role row'; end if;
  if (select array_agg(p.key order by p.key) from role_permissions rp join permissions p on p.id = rp.permission_id where rp.role_id = rid) <> array['report.export', 'report.view', 'reservation.view'] then raise exception 'FAIL permissions stored'; end if;
  if (select count(*) from audit_logs where action = 'role.created' and entity_id = rid) <> 1 then raise exception 'FAIL created audit'; end if;

  -- B. what a custom role may not be
  perform t_as(owner);
  perform t_expect(format('select create_custom_role(%L, %L, %L)', ta, 'Boss two', array['staff.manage', 'report.view']), 'POLICY_VIOLATION: permissions');
  perform t_expect(format('select create_custom_role(%L, %L, %L)', ta, 'Both ways', array['refund.request', 'refund.approve']), 'POLICY_VIOLATION: permissions');
  perform t_expect(format('select create_custom_role(%L, %L, %L)', ta, 'Nothing', array[]::text[]), 'POLICY_VIOLATION: permissions');
  perform t_expect(format('select create_custom_role(%L, %L, null)', ta, 'Null list'), 'POLICY_VIOLATION: permissions');
  perform t_expect(format('select create_custom_role(%L, %L, %L)', ta, 'Made up', array['room.view', 'room.fly']), 'POLICY_VIOLATION: permissions');
  perform t_expect(format('select create_custom_role(%L, %L, %L)', ta, 'X', array['room.view']), 'POLICY_VIOLATION: name');
  perform t_expect(format('select create_custom_role(%L, %L, %L)', ta, '<b>Hi</b>', array['room.view']), 'POLICY_VIOLATION: name');
  perform t_expect(format('select create_custom_role(%L, %L, %L)', ta, 'Accountant', array['room.view']), 'POLICY_VIOLATION: name taken');
  perform t_expect(format('select create_custom_role(%L, %L, %L)', ta, 'night AUDITOR', array['room.view']), 'POLICY_VIOLATION: name taken');
  r := create_custom_role(ta, 'Refund asker', array['refund.request']); perform create_custom_role(ta, 'Refund approver', array['refund.approve']);

  -- C. only a manager of the group; another group's owner and everyone else see nothing
  perform t_as(fd);
  perform t_expect(format('select create_custom_role(%L, %L, %L)', ta, 'Sneaky', array['room.view']), 'NOT_FOUND');
  perform t_expect(format('select custom_roles_list(%L)', ta), 'NOT_FOUND');
  perform t_as(acc);
  perform t_expect(format('select update_custom_role(%L, %L, %L)', rid, 'Night auditor', array['room.view']), 'NOT_FOUND');
  perform t_expect(format('select delete_custom_role(%L)', rid), 'NOT_FOUND');
  perform t_as(ob);
  perform t_expect(format('select create_custom_role(%L, %L, %L)', ta, 'Cross', array['room.view']), 'NOT_FOUND');
  perform t_expect(format('select update_custom_role(%L, %L, %L)', rid, 'Hijack', array['room.view']), 'NOT_FOUND');
  perform t_expect(format('select delete_custom_role(%L)', rid), 'NOT_FOUND');
  perform t_expect(format('select custom_roles_list(%L)', ta), 'NOT_FOUND');
  perform t_sys();
  perform t_expect(format('select create_custom_role(%L, %L, %L)', ta, 'Anon', array['room.view']), 'NOT_FOUND');
  perform t_as(owner);
  if jsonb_array_length(custom_roles_list(ta)) <> 3 then raise exception 'FAIL owner list %', custom_roles_list(ta); end if;

  -- D. reading: a group reads its own custom roles and permissions, never another group's; system roles stay readable
  perform t_as(fd);
  if (select count(*) from roles where id = rid) <> 1 or (select count(*) from role_permissions where role_id = rid) <> 3 then raise exception 'FAIL member cannot read own group role'; end if;
  perform t_as(ob);
  if (select count(*) from roles where tenant_id is not null) <> 0 or (select count(*) from role_permissions where role_id = rid) <> 0 then raise exception 'FAIL group B reads group A roles'; end if;
  if (select count(*) from roles where tenant_id is null) < 7 then raise exception 'FAIL system roles unreadable'; end if;
  perform t_as(owner);
  perform t86_denied(format('insert into roles (key, name, is_system, tenant_id) values (%L, %L, false, %L)', 'custom.direct.' || left(ta::text, 8), 'Direct', ta));
  perform t86_denied(format('insert into role_permissions (role_id, permission_id) select %L, id from permissions limit 1', rid));
  perform t86_denied(format('update roles set name = %L where id = %L', 'Renamed', rid));
  perform t86_denied(format('delete from roles where id = %L', rid));
end $$;

do $$ declare
  ta uuid := '00000000-0000-0000-0000-0000000000a1'; tb uuid := '00000000-0000-0000-0000-0000000000b1'; pa uuid := '00000000-0000-0000-0000-0000000000a2';
  owner text := '00000000-0000-0000-0000-00000000aa01'; fd text := '00000000-0000-0000-0000-00000000aa04'; hk text := '00000000-0000-0000-0000-00000000aa02';
  ob text := '00000000-0000-0000-0000-00000000bb01'; fdu uuid := '00000000-0000-0000-0000-00000000aa04'; hku uuid := '00000000-0000-0000-0000-00000000aa02';
  rid uuid; rkey text; r jsonb; mr uuid; i integer;
begin
  perform t_sys();
  select id, key into rid, rkey from roles where tenant_id = ta and name = 'Night auditor';

  -- E. granting: a custom role is granted by key like any other, at a property; another group's role is NOT_FOUND
  perform t_as(owner);
  if has_permission(pa, 'report.export') is not true then raise exception 'FAIL owner baseline'; end if;
  perform t_as(hk);
  if has_permission(pa, 'report.export') then raise exception 'FAIL housekeeping should not export yet'; end if;
  perform t_as(owner);
  r := add_staff_member(ta, hku, rkey, pa);
  if not (r ->> 'role_added')::boolean then raise exception 'FAIL grant: %', r; end if;
  perform t_as(hk);
  if not has_permission(pa, 'report.export') or not has_permission(pa, 'housekeeping.update') then raise exception 'FAIL custom permission not applied (or lost the old one)'; end if;
  perform t_as(ob);
  perform t_expect(format('select add_staff_member(%L, %L, %L, null)', tb, hku, rkey), 'NOT_FOUND');
  perform t_expect(format('select staff_check_grant(%L, %L, null)', tb, rkey), 'NOT_FOUND');

  -- F. changing a role in use applies at once, and is audited with what it was
  perform t_as(owner);
  perform update_custom_role(rid, 'Night auditor', array['report.view', 'reservation.view']);
  perform t_as(hk);
  if has_permission(pa, 'report.export') or not has_permission(pa, 'report.view') then raise exception 'FAIL change not applied at once'; end if;
  perform t_sys();
  if (select metadata -> 'was_permissions' from audit_logs where action = 'role.updated' and entity_id = rid order by created_at desc limit 1) <> '["report.export", "report.view", "reservation.view"]'::jsonb then raise exception 'FAIL updated audit'; end if;
  perform t_as(owner);
  perform t_expect(format('select update_custom_role(%L, %L, %L)', rid, 'Night auditor', array['staff.manage']), 'POLICY_VIOLATION: permissions');
  perform t_expect(format('select update_custom_role(%L, %L, %L)', rid, 'Accountant', array['room.view']), 'POLICY_VIOLATION: name taken');
  perform t_expect(format('select update_custom_role(%L, %L, %L)', (select id from roles where key = 'accountant'), 'Accountant', array['room.view']), 'NOT_FOUND');

  -- G. delete: a role in use stays, an unused one goes, system roles cannot be touched
  perform t_expect(format('select delete_custom_role(%L)', rid), 'INVALID_STATE: in use');
  perform t_expect(format('select delete_custom_role(%L)', (select id from roles where key = 'front_desk')), 'NOT_FOUND');
  perform t_sys();
  select id into mr from membership_roles where role_id = rid;
  perform t_as(owner);
  perform remove_staff_role(mr);
  perform t_as(hk);
  if has_permission(pa, 'report.view') then raise exception 'FAIL removed role still grants'; end if;
  perform t_as(owner);
  perform delete_custom_role(rid);
  perform t_sys();
  if exists (select 1 from roles where id = rid) or exists (select 1 from role_permissions where role_id = rid) then raise exception 'FAIL not deleted'; end if;
  if (select count(*) from audit_logs where action = 'role.deleted' and entity_id = rid) <> 1 then raise exception 'FAIL deleted audit'; end if;

  -- H. at most 20 per group; the limit is per group, and a name may be reused after delete
  perform t_as(owner);
  for i in 1 .. 20 loop
    begin
      perform create_custom_role(ta, 'Filler ' || i, array['room.view']);
    exception when sqlstate 'P0001' then
      if sqlerrm <> 'POLICY_VIOLATION: too many roles' then raise; end if;
      exit;
    end;
  end loop;
  if (select count(*) from roles where tenant_id = ta) <> 20 then raise exception 'FAIL the cap should stop at 20, got %', (select count(*) from roles where tenant_id = ta); end if;
  perform t_expect(format('select create_custom_role(%L, %L, %L)', ta, 'One too many', array['room.view']), 'POLICY_VIOLATION: too many roles');
  perform t_as(ob);
  perform create_custom_role(tb, 'Night auditor', array['room.view']);
  perform t_sys();
  delete from roles where tenant_id is not null;

  raise notice 'PASS custom roles: owner-only, no staff.manage, no refund both ways, scoped reads, grant/change/delete behave, 20 per group, audited';
end $$;

drop function t86_denied(text);
