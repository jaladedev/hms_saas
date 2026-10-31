-- Staff management (migration 019). Reuses t_as / t_sys / t_expect (05).
-- Existing users: aa01 owner A (membership aaa01), aa04 front desk A, aa05 accountant A, bb01 owner B.
-- This file adds: 0e0001 a new person, 0e0002 "ux" (staff.manage only, plus housekeeping at property A),
-- 0e0003 "ux2" (every permission, but not the owner role).
\set ON_ERROR_STOP on

update auth.users set email = 'owner.a@example.com' where id = '00000000-0000-0000-0000-00000000aa01';
update auth.users set email = 'front.desk@example.com' where id = '00000000-0000-0000-0000-00000000aa04';
update auth.users set email = 'owner.b@example.com' where id = '00000000-0000-0000-0000-00000000bb01';
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000e0001', 'new.person@example.com'),
  ('00000000-0000-0000-0000-0000000e0002', 'ux@example.com'),
  ('00000000-0000-0000-0000-0000000e0003', 'ux2@example.com');

-- custom roles, only for these tests
insert into roles (key, name, is_system) values ('t16_staff_only', 'Staff only', false), ('t16_all', 'All permissions', false);
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p where r.key = 't16_staff_only' and p.key = 'staff.manage';
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p where r.key = 't16_all';
insert into tenant_memberships (id, tenant_id, user_id, status) values
  ('00000000-0000-0000-0000-0000000eee02', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000e0002', 'active'),
  ('00000000-0000-0000-0000-0000000eee03', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000e0003', 'active');
insert into membership_roles (membership_id, role_id, property_id)
select '00000000-0000-0000-0000-0000000eee02'::uuid, id, null::uuid from roles where key = 't16_staff_only'
union all select '00000000-0000-0000-0000-0000000eee02'::uuid, id, '00000000-0000-0000-0000-0000000000a2'::uuid from roles where key = 'housekeeping'
union all select '00000000-0000-0000-0000-0000000eee03'::uuid, id, null::uuid from roles where key = 't16_all';

-- 1. The directory: managers see their own hotel group's members and roles, nobody else sees anything
do $$ declare d jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  d := staff_directory();
  if exists (select 1 from jsonb_array_elements(d) x where x ->> 'tenant_id' <> '00000000-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL directory leaks another hotel group';
  end if;
  if (select count(*) from jsonb_array_elements(d) x where (x ->> 'is_self')::boolean) <> 1 then raise exception 'FAIL is_self'; end if;
  if not exists (select 1 from jsonb_array_elements(d) x where x ->> 'email' = 'front.desk@example.com'
                   and x -> 'roles' -> 0 ->> 'role_key' = 'front_desk' and x ->> 'status' = 'active') then
    raise exception 'FAIL directory misses the front desk member %', d;
  end if;
  if (d -> 0 ->> 'status') = 'revoked' then raise exception 'FAIL revoked people should be last'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if staff_directory() <> '[]'::jsonb then raise exception 'FAIL front desk sees the directory'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  d := staff_directory();
  if jsonb_array_length(d) <> 1 or d -> 0 ->> 'email' <> 'owner.b@example.com' then raise exception 'FAIL hotel B directory %', d; end if;
  perform t_sys();
  perform t_expect('select staff_directory()', 'NOT_FOUND');
  raise notice 'PASS directory: managers see their own group with roles; others see nothing';
end $$;

-- 2. Adding people and roles: permission, scope, idempotence, audit
do $$ declare r jsonb; v_audit integer; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform staff_check_grant('00000000-0000-0000-0000-0000000000a1', 'front_desk', null);
  r := add_staff_member('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000e0001', 'front_desk', null);
  if not (r ->> 'new_member')::boolean or not (r ->> 'role_added')::boolean then raise exception 'FAIL first add %', r; end if;
  r := add_staff_member('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000e0001', 'front_desk', null);
  if (r ->> 'new_member')::boolean or (r ->> 'role_added')::boolean then raise exception 'FAIL repeat add changed something %', r; end if;
  r := add_staff_member('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000e0001', 'reservations_officer', '00000000-0000-0000-0000-0000000000a2');
  if (r ->> 'new_member')::boolean or not (r ->> 'role_added')::boolean then raise exception 'FAIL second role %', r; end if;
  perform t_sys();
  if (select count(*) from membership_roles mr join tenant_memberships m on m.id = mr.membership_id
       where m.user_id = '00000000-0000-0000-0000-0000000e0001') <> 2 then raise exception 'FAIL duplicate role rows'; end if;
  select count(*) into v_audit from audit_logs where action = 'staff.role_added' and actor_user_id = '00000000-0000-0000-0000-00000000aa01';
  if v_audit <> 2 then raise exception 'FAIL audit rows %', v_audit; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect($q$select add_staff_member('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000e0001', 'front_desk', '00000000-0000-0000-0000-0000000000b2')$q$, 'POLICY_VIOLATION: property');
  perform t_expect($q$select add_staff_member('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000e0001', 'no_such_role', null)$q$, 'NOT_FOUND');
  perform t_expect($q$select add_staff_member('00000000-0000-0000-0000-0000000000a1', gen_random_uuid(), 'front_desk', null)$q$, 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect($q$select add_staff_member('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000e0001', 'housekeeping', null)$q$, 'NOT_FOUND');
  perform t_expect($q$select staff_check_grant('00000000-0000-0000-0000-0000000000a1', 'housekeeping', null)$q$, 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect($q$select add_staff_member('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000e0001', 'housekeeping', null)$q$, 'NOT_FOUND');
  perform t_sys();
  raise notice 'PASS add: owner only, idempotent, scoped, audited; wrong hotel, bad role, bad user and bad property refused';
end $$;

-- 3. Escalation: you can only hand out what you hold, at a scope you hold it for
do $$ declare v_owner_role uuid; begin
  perform t_as('00000000-0000-0000-0000-0000000e0002');           -- staff.manage everywhere, housekeeping at property A only
  if not (add_staff_member('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000e0001', 'housekeeping', '00000000-0000-0000-0000-0000000000a2') ->> 'role_added')::boolean then
    raise exception 'FAIL ux could not grant housekeeping at A';
  end if;
  perform t_expect($q$select add_staff_member('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000e0001', 'housekeeping', null)$q$, 'POLICY_VIOLATION: ROLE_ESCALATION');
  perform t_expect($q$select add_staff_member('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000e0001', 'front_desk', '00000000-0000-0000-0000-0000000000a2')$q$, 'POLICY_VIOLATION: ROLE_ESCALATION');
  perform t_expect($q$select add_staff_member('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000e0001', 'owner', null)$q$, 'POLICY_VIOLATION: ROLE_ESCALATION');
  perform t_expect($q$select staff_check_grant('00000000-0000-0000-0000-0000000000a1', 'owner', '00000000-0000-0000-0000-0000000000a2')$q$, 'POLICY_VIOLATION: ROLE_ESCALATION');
  perform t_sys();
  select mr.id into v_owner_role from membership_roles mr join roles r on r.id = mr.role_id
   where mr.membership_id = '00000000-0000-0000-0000-0000000aaa01' and r.key = 'owner';
  perform t_as('00000000-0000-0000-0000-0000000e0002');
  perform t_expect(format('select remove_staff_role(%L)', v_owner_role), 'POLICY_VIOLATION: ROLE_ESCALATION');
  perform t_expect($q$select set_staff_status('00000000-0000-0000-0000-0000000aaa01', 'suspended')$q$, 'POLICY_VIOLATION: ROLE_ESCALATION');
  perform t_sys();
  raise notice 'PASS escalation: cannot grant, remove or suspend anything above your own roles or scope';
end $$;

-- 4. Removing a role
do $$ declare v_fd uuid; v_own uuid; begin
  perform t_sys();
  select mr.id into v_fd from membership_roles mr join roles r on r.id = mr.role_id
   where mr.membership_id = (select id from tenant_memberships where user_id = '00000000-0000-0000-0000-0000000e0001') and r.key = 'front_desk';
  select mr.id into v_own from membership_roles mr join roles r on r.id = mr.role_id
   where mr.membership_id = '00000000-0000-0000-0000-0000000aaa01' and r.key = 'owner';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select remove_staff_role(%L)', v_fd), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select remove_staff_role(%L)', v_own), 'POLICY_VIOLATION: SELF_CHANGE');
  perform remove_staff_role(v_fd);
  perform t_expect(format('select remove_staff_role(%L)', v_fd), 'NOT_FOUND');                 -- already gone
  perform t_sys();
  if not exists (select 1 from audit_logs where action = 'staff.role_removed' and metadata ->> 'role' = 'front_desk') then
    raise exception 'FAIL removal not audited';
  end if;
  raise notice 'PASS remove role: manager only, not your own, audited';
end $$;

-- 5. Suspend, reinstate, revoke
do $$ declare m uuid; n integer; r jsonb; begin
  select id into m from tenant_memberships where user_id = '00000000-0000-0000-0000-0000000e0001';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select set_staff_status(%L, %L)', m, 'suspended'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if not (set_staff_status(m, 'suspended') ->> 'changed')::boolean then raise exception 'FAIL suspend'; end if;
  perform t_as('00000000-0000-0000-0000-0000000e0001');
  if has_permission('00000000-0000-0000-0000-0000000000a2', 'room.view') then raise exception 'FAIL suspended person still has access'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect($q$select add_staff_member('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000e0001', 'front_desk', null)$q$, 'INVALID_STATE: suspended');
  if (set_staff_status(m, 'suspended') ->> 'changed')::boolean then raise exception 'FAIL repeat suspend changed something'; end if;
  perform set_staff_status(m, 'active');
  perform t_as('00000000-0000-0000-0000-0000000e0001');
  if not has_permission('00000000-0000-0000-0000-0000000000a2', 'room.view') then raise exception 'FAIL reinstated person has no access'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select set_staff_status(%L, %L)', '00000000-0000-0000-0000-0000000aaa01', 'suspended'), 'POLICY_VIOLATION: SELF_CHANGE');
  perform t_expect(format('select set_staff_status(%L, %L)', m, 'invited'), 'POLICY_VIOLATION: status');
  perform t_as('00000000-0000-0000-0000-0000000e0002');
  perform t_expect(format('select set_staff_status(%L, %L)', m, 'revoked'), 'POLICY_VIOLATION: ROLE_ESCALATION');   -- ux does not hold reservations_officer

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := set_staff_status(m, 'revoked');
  perform t_expect(format('select set_staff_status(%L, %L)', m, 'suspended'), 'INVALID_STATE: revoked');
  perform t_sys();
  select count(*) into n from membership_roles where membership_id = m;
  if n <> 0 then raise exception 'FAIL revoke left % roles', n; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := add_staff_member('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000e0001', 'front_desk', null);
  perform t_sys();
  if not (r ->> 'new_member')::boolean then raise exception 'FAIL re-add after revoke %', r; end if;
  if (select status from tenant_memberships where id = m) <> 'active' then raise exception 'FAIL not active again'; end if;
  if (select count(*) from membership_roles where membership_id = m) <> 1 then raise exception 'FAIL old roles came back'; end if;
  if (select count(*) from audit_logs where action = 'staff.status_changed' and entity_id = m) <> 3 then raise exception 'FAIL status audit rows'; end if;
  raise notice 'PASS status: suspend and reinstate cut and restore access; revoke is final and wipes roles; not on yourself';
end $$;

-- 6. The last owner can never be removed or suspended, by anyone
do $$ declare m_owner constant uuid := '00000000-0000-0000-0000-0000000aaa01'; v_own uuid; m_new uuid; begin
  perform t_sys();
  if (select count(*) from tenant_memberships m join membership_roles mr on mr.membership_id = m.id join roles r on r.id = mr.role_id
       where m.tenant_id = '00000000-0000-0000-0000-0000000000a1' and m.status = 'active' and r.key = 'owner' and mr.property_id is null) <> 1 then
    raise exception 'FAIL fixture: expected exactly one active owner at hotel A';
  end if;
  select mr.id into v_own from membership_roles mr join roles r on r.id = mr.role_id where mr.membership_id = m_owner and r.key = 'owner';
  select id into m_new from tenant_memberships where user_id = '00000000-0000-0000-0000-0000000e0001';

  perform t_as('00000000-0000-0000-0000-0000000e0003');           -- holds every permission, so escalation does not stop them
  perform t_expect(format('select set_staff_status(%L, %L)', m_owner, 'suspended'), 'POLICY_VIOLATION: LAST_OWNER');
  perform t_expect(format('select set_staff_status(%L, %L)', m_owner, 'revoked'), 'POLICY_VIOLATION: LAST_OWNER');
  perform t_expect(format('select remove_staff_role(%L)', v_own), 'POLICY_VIOLATION: LAST_OWNER');

  perform add_staff_member('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000e0001', 'owner', null);
  perform set_staff_status(m_owner, 'suspended');                  -- fine now: another active owner remains
  perform t_expect(format('select set_staff_status(%L, %L)', m_new, 'suspended'), 'POLICY_VIOLATION: LAST_OWNER');
  perform set_staff_status(m_owner, 'active');
  perform t_sys();
  if (select status from tenant_memberships where id = m_owner) <> 'active' then raise exception 'FAIL owner not restored'; end if;
  raise notice 'PASS last owner: cannot be suspended, revoked or stripped of the role while no other owner is active';
end $$;

-- 7. Server-only lookups and internal helpers are closed to clients
do $$ declare v uuid; begin
  perform t_sys();
  v := find_user_id_by_email('  NEW.Person@Example.com ');
  if v is distinct from '00000000-0000-0000-0000-0000000e0001'::uuid then raise exception 'FAIL email lookup %', v; end if;
  if find_user_id_by_email('nobody@example.com') is not null then raise exception 'FAIL unknown email found'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin perform find_user_id_by_email('owner.a@example.com'); raise exception 'FAIL client may look up emails';
  exception when insufficient_privilege then null; end;
  begin perform staff_actor_manages('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000a1'); raise exception 'FAIL helper is callable';
  exception when insufficient_privilege then null; end;
  perform set_config('role', 'anon', true);
  begin perform staff_directory(); raise exception 'FAIL anon may read the directory';
  exception when insufficient_privilege then null; end;
  perform t_sys();
  raise notice 'PASS closed doors: email lookup is server-only, helpers are internal, anon is refused';
end $$;
