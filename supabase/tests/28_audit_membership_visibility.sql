-- Staff access changes in the audit trail (migration 030). Reuses t_as / t_sys (05).
-- Users: aa01 owner A (audit.view), aa04 front desk A (no audit.view), bb01 owner of Hotel B.
-- Rows are inserted as the table owner with fixed ids, then read as each person (row-level security applies).
\set ON_ERROR_STOP on

insert into audit_logs (id, tenant_id, property_id, actor_user_id, action, entity_type, entity_id, metadata) values
  ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000000a1', null, '00000000-0000-0000-0000-00000000aa01', 'staff.status_changed', 'membership', gen_random_uuid(), '{"from":"active","to":"suspended"}'),
  ('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-0000000000a1', null, '00000000-0000-0000-0000-00000000aa01', 'guest.updated', 'guest', gen_random_uuid(), '{}'),
  ('00000000-0000-0000-0000-0000000d0003', null, null, null, 'staff.status_changed', 'membership', gen_random_uuid(), '{}'),
  ('00000000-0000-0000-0000-0000000d0004', '00000000-0000-0000-0000-0000000000b1', null, '00000000-0000-0000-0000-00000000bb01', 'staff.status_changed', 'membership', gen_random_uuid(), '{}');

-- 1. An owner sees their own hotel group's membership rows, and nothing else that has no property
do $$ declare ids uuid[]; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  select array_agg(id order by id) into ids from audit_logs where id::text like '00000000-0000-0000-0000-0000000d000%';
  perform t_sys();
  if ids is distinct from array['00000000-0000-0000-0000-0000000d0001']::uuid[] then raise exception 'FAIL owner A sees %', ids; end if;
  raise notice 'PASS an owner sees their group''s staff access changes and no other row without a property';
end $$;

-- 2. Someone without audit.view sees none of them
do $$ declare n integer; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  select count(*) into n from audit_logs where id::text like '00000000-0000-0000-0000-0000000d000%';
  perform t_sys();
  if n <> 0 then raise exception 'FAIL front desk sees % rows', n; end if;
  raise notice 'PASS a login without audit.view sees none of them';
end $$;

-- 3. Another hotel group's owner sees only their own
do $$ declare ids uuid[]; begin
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  select array_agg(id order by id) into ids from audit_logs where id::text like '00000000-0000-0000-0000-0000000d000%';
  perform t_sys();
  if ids is distinct from array['00000000-0000-0000-0000-0000000d0004']::uuid[] then raise exception 'FAIL owner B sees %', ids; end if;
  raise notice 'PASS another hotel group sees only its own';
end $$;

-- 4. The helper: true only with audit.view at a property of that tenant; a null tenant is never visible; anon cannot call it
do $$ begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if not can_view_tenant_audit('00000000-0000-0000-0000-0000000000a1') then raise exception 'FAIL owner A own tenant'; end if;
  if can_view_tenant_audit('00000000-0000-0000-0000-0000000000b1') then raise exception 'FAIL owner A other tenant'; end if;
  if can_view_tenant_audit(null) then raise exception 'FAIL null tenant'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if can_view_tenant_audit('00000000-0000-0000-0000-0000000000a1') then raise exception 'FAIL front desk'; end if;
  perform t_sys();
  perform set_config('role', 'anon', true);
  begin
    perform can_view_tenant_audit('00000000-0000-0000-0000-0000000000a1');
    raise exception 'FAIL anon ran can_view_tenant_audit';
  exception when insufficient_privilege then null;
  end;
  perform t_sys();
  raise notice 'PASS can_view_tenant_audit is true only with audit.view in that hotel group, and not for anon';
end $$;

-- 5. A real suspension is now readable by the owner who made it
do $$ declare m uuid; n integer; begin
  select id into m from tenant_memberships where user_id = '00000000-0000-0000-0000-00000000aa04';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_staff_status(m, 'suspended');
  perform set_staff_status(m, 'active');
  select count(*) into n from audit_logs where action = 'staff.status_changed' and entity_id = m;
  perform t_sys();
  if n <> 2 then raise exception 'FAIL owner reads % of the 2 status rows', n; end if;
  raise notice 'PASS suspending and reinstating someone leaves rows the owner can read';
end $$;
