-- Maintenance requests (migration 026). Reuses t_as / t_sys / t_expect (05) and the users from earlier files:
-- aa01 owner A, aa02 housekeeping A, aa03 owner A but revoked, aa04 front desk A, aa05 accountant A,
-- aa08 maintenance A (created in 21), bb01 owner of Hotel B. This file adds aa10 maintenance A (with a profile name),
-- aa11 maintenance A (suspended) and aa12 maintenance A (deleted near the end).
-- Ids: a2 property A, rooms 101-105 (STD), b2 property B.
\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000aa10', 'mt2@example.test'), ('00000000-0000-0000-0000-00000000aa11', 'mt3@example.test'),
  ('00000000-0000-0000-0000-00000000aa12', 'mt4@example.test');
insert into tenant_memberships (id, tenant_id, user_id, status) values
  ('00000000-0000-0000-0000-0000000aaa10', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa10', 'active'),
  ('00000000-0000-0000-0000-0000000aaa11', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa11', 'suspended'),
  ('00000000-0000-0000-0000-0000000aaa12', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa12', 'active');
insert into membership_roles (membership_id, role_id)
select m.id, r.id from (values
  ('00000000-0000-0000-0000-0000000aaa10'::uuid), ('00000000-0000-0000-0000-0000000aaa11'::uuid), ('00000000-0000-0000-0000-0000000aaa12'::uuid)
) as m(id) join roles r on r.key = 'maintenance';
insert into user_profiles (id, full_name) values ('00000000-0000-0000-0000-00000000aa10', 'Tunde Ojo');

create function t24_room(p_number text) returns uuid language sql stable as $$
  select id from rooms where property_id = '00000000-0000-0000-0000-0000000000a2' and room_number = p_number
$$;
create function t24_audits(p_action text, p_entity uuid) returns bigint language sql stable as $$
  select count(*) from audit_logs where action = p_action and entity_id = p_entity
$$;
-- Report as the person in p_user and give back the request id (a unique key each time).
create function t24_report(p_user text, p_room text, p_title text, p_priority text default 'normal') returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  perform t_as(p_user);
  v_id := (report_maintenance_request('00000000-0000-0000-0000-0000000000a2', case when p_room is null then null else t24_room(p_room) end,
             case when p_room is null then 'Lobby' end, p_title, null, p_priority, null, null, 'mt-' || gen_random_uuid()::text) ->> 'request_id')::uuid;
  perform t_sys();
  return v_id;
end $$;

-- 1. The permission grants
do $$ declare v_n integer; begin
  perform t_sys();
  select count(*) into v_n from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
   where p.key = 'maintenance.view' and r.is_system and r.key in ('owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance');
  if v_n <> 5 then raise exception 'FAIL maintenance.view grants (%)', v_n; end if;
  if exists (select 1 from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
              where p.key = 'maintenance.view' and r.is_system and r.key in ('reservations_officer', 'accountant')) then
    raise exception 'FAIL maintenance.view granted too widely';
  end if;
  if exists (select 1 from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
              where p.key = 'maintenance.manage' and r.is_system and r.key in ('front_desk', 'housekeeping')) then
    raise exception 'FAIL front desk or housekeeping can manage maintenance';
  end if;
  raise notice 'PASS permissions: maintenance.view for the five operational roles, maintenance.manage still only for maintenance and management';
end $$;

-- 2. Reporting
do $$ declare
  a2 constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_room uuid := t24_room('102');
  r jsonb; r2 jsonb; v_id uuid; v_rows integer; v_other_room uuid;
begin
  perform t_sys();
  select id into v_other_room from rooms where property_id <> a2 limit 1;
  v_other_room := coalesce(v_other_room, gen_random_uuid());

  perform t_as('00000000-0000-0000-0000-00000000aa05');   -- accountant: no maintenance access
  perform t_expect(format('select report_maintenance_request(%L, %L, null, %L, null, %L, null, null, %L)', a2, v_room, 'Tap', 'normal', 'k-1'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');   -- another hotel's owner
  perform t_expect(format('select report_maintenance_request(%L, %L, null, %L, null, %L, null, null, %L)', a2, v_room, 'Tap', 'normal', 'k-1'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa03');   -- revoked owner
  perform t_expect(format('select report_maintenance_request(%L, %L, null, %L, null, %L, null, null, %L)', a2, v_room, 'Tap', 'normal', 'k-1'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select report_maintenance_request(%L, %L, null, %L, null, %L, null, null, %L)', gen_random_uuid(), v_room, 'Tap', 'normal', 'k-1'), 'NOT_FOUND');
  -- input checks
  perform t_expect(format('select report_maintenance_request(%L, %L, null, %L, null, %L, null, null, %L)', a2, v_room, '   ', 'normal', 'k-1'), 'POLICY_VIOLATION: title');
  perform t_expect(format('select report_maintenance_request(%L, %L, null, %L, null, %L, null, null, %L)', a2, v_room, repeat('x', 121), 'normal', 'k-1'), 'POLICY_VIOLATION: title');
  perform t_expect(format('select report_maintenance_request(%L, %L, null, %L, null, %L, null, null, %L)', a2, v_room, 'Tap', 'asap', 'k-1'), 'POLICY_VIOLATION: priority');
  perform t_expect(format('select report_maintenance_request(%L, %L, null, %L, null, null, null, null, %L)', a2, v_room, 'Tap', 'k-1'), 'POLICY_VIOLATION: priority');
  perform t_expect(format('select report_maintenance_request(%L, null, null, %L, null, %L, null, null, %L)', a2, 'Tap', 'normal', 'k-1'), 'POLICY_VIOLATION: a room or a place');
  perform t_expect(format('select report_maintenance_request(%L, null, %L, %L, null, %L, null, null, %L)', a2, repeat('x', 101), 'Tap', 'normal', 'k-1'), 'POLICY_VIOLATION: location');
  perform t_expect(format('select report_maintenance_request(%L, %L, null, %L, %L, %L, null, null, %L)', a2, v_room, 'Tap', repeat('x', 2001), 'normal', 'k-1'), 'POLICY_VIOLATION: description');
  perform t_expect(format('select report_maintenance_request(%L, %L, null, %L, null, %L, null, null, %L)', a2, v_other_room, 'Tap', 'normal', 'k-1'), 'POLICY_VIOLATION: room');
  perform t_expect(format('select report_maintenance_request(%L, %L, null, %L, null, %L, null, null, null)', a2, v_room, 'Tap', 'normal'), 'POLICY_VIOLATION: idempotency key');
  -- a due time or an assignee at the start is for people who manage maintenance
  perform t_expect(format('select report_maintenance_request(%L, %L, null, %L, null, %L, now(), null, %L)', a2, v_room, 'Tap', 'normal', 'k-1'), 'FORBIDDEN');
  perform t_expect(format('select report_maintenance_request(%L, %L, null, %L, null, %L, null, %L, %L)', a2, v_room, 'Tap', 'normal', '00000000-0000-0000-0000-00000000aa08', 'k-1'), 'FORBIDDEN');
  perform t_sys();
  if exists (select 1 from maintenance_requests where title in ('Tap', '   ') or length(title) > 120) then raise exception 'FAIL a refused report left a row'; end if;

  -- housekeeping reports a fault in a room
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  r := report_maintenance_request(a2, v_room, null, '  Tap leaking in the bathroom ', '  drips all night ', 'high', null, null, 'mt-key-0001');
  perform t_sys();
  v_id := (r ->> 'request_id')::uuid;
  if r ->> 'status' <> 'open' or r ->> 'priority' <> 'high' or r ->> 'room_id' <> v_room::text or r ->> 'assigned_to' is not null then raise exception 'FAIL report result %', r; end if;
  if not exists (select 1 from maintenance_requests where id = v_id and title = 'Tap leaking in the bathroom' and description = 'drips all night'
                    and reported_by = '00000000-0000-0000-0000-00000000aa02' and location is null) then raise exception 'FAIL report row'; end if;
  if t24_audits('maintenance.request_created', v_id) <> 1 then raise exception 'FAIL created audit'; end if;

  -- the same key and payload again: the same request, nothing new; the same key with other words: refused
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  r2 := report_maintenance_request(a2, v_room, null, '  Tap leaking in the bathroom ', '  drips all night ', 'high', null, null, 'mt-key-0001');
  perform t_expect(format('select report_maintenance_request(%L, %L, null, %L, null, %L, null, null, %L)', a2, v_room, 'Something else', 'high', 'mt-key-0001'), 'IDEMPOTENCY_MISMATCH');
  perform t_sys();
  if r2 is distinct from r then raise exception 'FAIL repeat report gave another answer'; end if;
  select count(*) into v_rows from maintenance_requests where title = 'Tap leaking in the bathroom';
  if v_rows <> 1 or t24_audits('maintenance.request_created', v_id) <> 1 then raise exception 'FAIL repeat report made a second request'; end if;

  -- a fault that is not in a room; a technician reporting with a due time and an assignee
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := report_maintenance_request(a2, null, 'Lobby', 'Lift makes a noise', null, 'low', null, null, 'mt-key-0002');
  perform t_sys();
  if not exists (select 1 from maintenance_requests where id = (r ->> 'request_id')::uuid and room_id is null and location = 'Lobby') then raise exception 'FAIL common-area request'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  r := report_maintenance_request(a2, v_room, null, 'Door lock sticks', null, 'normal', now() + interval '2 days', '00000000-0000-0000-0000-00000000aa10', 'mt-key-0003');
  perform t_expect(format('select report_maintenance_request(%L, %L, null, %L, null, %L, null, %L, %L)', a2, v_room, 'x', 'normal', '00000000-0000-0000-0000-00000000aa02', 'mt-key-0004'), 'POLICY_VIOLATION: assignee');
  perform t_expect(format('select report_maintenance_request(%L, %L, null, %L, null, %L, null, %L, %L)', a2, v_room, 'x', 'normal', '00000000-0000-0000-0000-00000000aa11', 'mt-key-0005'), 'POLICY_VIOLATION: assignee');
  perform t_expect(format('select report_maintenance_request(%L, %L, null, %L, null, %L, null, %L, %L)', a2, v_room, 'x', 'normal', '00000000-0000-0000-0000-00000000aa03', 'mt-key-0006'), 'POLICY_VIOLATION: assignee');
  perform t_sys();
  if not exists (select 1 from maintenance_requests where id = (r ->> 'request_id')::uuid and assigned_to = '00000000-0000-0000-0000-00000000aa10' and due_at is not null) then raise exception 'FAIL report with assignee and due time'; end if;
  raise notice 'PASS report: view permission, input checks, idempotent by key, common-area faults, due time and assignee for managers only';
end $$;

-- 3. Reading: row-level security
do $$ declare v_all integer; v_n integer; begin
  perform t_sys();
  select count(*) into v_all from maintenance_requests where property_id = '00000000-0000-0000-0000-0000000000a2';
  if v_all < 3 then raise exception 'FAIL fixture: expected requests to read'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa02'); select count(*) into v_n from maintenance_requests;
  if v_n <> v_all then raise exception 'FAIL housekeeping saw % of %', v_n, v_all; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04'); select count(*) into v_n from maintenance_requests;
  if v_n <> v_all then raise exception 'FAIL front desk saw % of %', v_n, v_all; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa08'); select count(*) into v_n from maintenance_requests;
  if v_n <> v_all then raise exception 'FAIL maintenance saw % of %', v_n, v_all; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01'); select count(*) into v_n from maintenance_requests;
  if v_n <> v_all then raise exception 'FAIL owner saw % of %', v_n, v_all; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa05'); select count(*) into v_n from maintenance_requests;
  if v_n <> 0 then raise exception 'FAIL accountant read requests'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa03'); select count(*) into v_n from maintenance_requests;
  if v_n <> 0 then raise exception 'FAIL revoked member read requests'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa11'); select count(*) into v_n from maintenance_requests;
  if v_n <> 0 then raise exception 'FAIL suspended member read requests'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01'); select count(*) into v_n from maintenance_requests;
  if v_n <> 0 then raise exception 'FAIL another hotel read requests'; end if;
  perform t_sys(); perform set_config('role', 'anon', true);
  select count(*) into v_n from maintenance_requests;
  if v_n <> 0 then raise exception 'FAIL anon read requests'; end if;
  perform t_sys();
  raise notice 'PASS read: maintenance view or manage, own hotel only, anon and others see nothing';
end $$;

-- 4. Writing: no direct writes for clients, rows are history for everyone
do $$ declare v_open uuid; v_done uuid := t24_report('00000000-0000-0000-0000-00000000aa08', '103', 'To be finished'); begin
  perform t_as('00000000-0000-0000-0000-00000000aa08'); perform resolve_maintenance_request(v_done, 'ok'); perform t_sys();
  select id into v_open from maintenance_requests where status = 'open' limit 1;
  if v_open is null then raise exception 'FAIL fixture: need an open request'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');   -- even the owner has no direct write
  begin insert into maintenance_requests (tenant_id, property_id, room_id, title) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', t24_room('104'), 'x');
        raise exception 'FAIL client insert succeeded'; exception when insufficient_privilege then null; end;
  begin update maintenance_requests set priority = 'urgent' where id = v_open; raise exception 'FAIL client update succeeded'; exception when insufficient_privilege then null; end;
  begin delete from maintenance_requests where id = v_open; raise exception 'FAIL client delete succeeded'; exception when insufficient_privilege then null; end;
  perform t_sys();

  -- the table owner cannot delete history, move a request, or touch a finished one
  begin delete from maintenance_requests where id = v_done; raise exception 'FAIL delete succeeded'; exception when check_violation then null; end;
  begin update maintenance_requests set room_id = t24_room('104') where id = v_open; raise exception 'FAIL request moved to another room'; exception when check_violation then null; end;
  begin update maintenance_requests set location = 'Roof' where id = v_open; raise exception 'FAIL place changed'; exception when check_violation then null; end;
  begin update maintenance_requests set resolution_note = 'edited later' where id = v_done; raise exception 'FAIL finished request changed'; exception when check_violation then null; end;
  begin update maintenance_requests set status = 'open', started_at = null, resolved_at = null where id = v_done; raise exception 'FAIL finished request reopened'; exception when check_violation then null; end;
  -- the table's own rules
  begin update maintenance_requests set status = 'resolved' where id = v_open; raise exception 'FAIL resolved without a time'; exception when check_violation then null; end;
  begin update maintenance_requests set status = 'open', started_at = now() where id = v_open; raise exception 'FAIL open request with a start time'; exception when check_violation then null; end;
  begin update maintenance_requests set status = 'cancelled', cancelled_at = now() where id = v_open; raise exception 'FAIL cancelled without a reason'; exception when check_violation then null; end;
  begin insert into maintenance_requests (tenant_id, property_id, title) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'no place');
        raise exception 'FAIL request with neither room nor place accepted'; exception when check_violation then null; end;
  begin insert into maintenance_requests (tenant_id, property_id, room_id, title) values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a2', t24_room('104'), 'x');
        raise exception 'FAIL tenant and property mismatch accepted'; exception when foreign_key_violation then null; end;
  begin insert into maintenance_requests (tenant_id, property_id, room_id, title) values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2', t24_room('104'), 'x');
        raise exception 'FAIL a room of another hotel accepted'; exception when foreign_key_violation then null; end;
  raise notice 'PASS write: clients cannot write; history cannot be deleted, moved or edited once finished; place and hotel must match';
end $$;

-- 5. Doing the work: claim, assign, start, priority, resolve, cancel
do $$ declare
  v_r uuid := t24_report('00000000-0000-0000-0000-00000000aa02', '104', 'Air conditioner not cooling');
  v_n uuid; r jsonb; v_room_before text;
begin
  perform t_sys();
  -- people who may only view cannot do any of it
  foreach v_n in array array[v_r] loop
    perform t_as('00000000-0000-0000-0000-00000000aa02');
    perform t_expect(format('select claim_maintenance_request(%L)', v_n), 'NOT_FOUND');
    perform t_expect(format('select assign_maintenance_request(%L, null)', v_n), 'NOT_FOUND');
    perform t_expect(format('select start_maintenance_request(%L)', v_n), 'NOT_FOUND');
    perform t_expect(format('select resolve_maintenance_request(%L)', v_n), 'NOT_FOUND');
    perform t_expect(format('select cancel_maintenance_request(%L, %L)', v_n, 'no'), 'NOT_FOUND');
    perform t_expect(format('select set_maintenance_priority(%L, %L)', v_n, 'low'), 'NOT_FOUND');
    perform t_expect(format('select link_maintenance_block(%L, null)', v_n), 'NOT_FOUND');
    perform t_as('00000000-0000-0000-0000-00000000aa04');
    perform t_expect(format('select start_maintenance_request(%L)', v_n), 'NOT_FOUND');
    perform t_as('00000000-0000-0000-0000-00000000aa05');
    perform t_expect(format('select claim_maintenance_request(%L)', v_n), 'NOT_FOUND');
    perform t_as('00000000-0000-0000-0000-00000000bb01');
    perform t_expect(format('select claim_maintenance_request(%L)', v_n), 'NOT_FOUND');
    perform t_expect(format('select resolve_maintenance_request(%L)', v_n), 'NOT_FOUND');
    perform t_expect(format('select claim_maintenance_request(%L)', gen_random_uuid()), 'NOT_FOUND');
  end loop;
  perform t_sys();
  if (select status from maintenance_requests where id = v_r) <> 'open' or (select assigned_to from maintenance_requests where id = v_r) is not null then raise exception 'FAIL a refused call changed the request'; end if;

  -- claim: only when free; a second tap changes nothing
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  r := claim_maintenance_request(v_r);
  perform claim_maintenance_request(v_r);
  perform t_sys();
  if r ->> 'assigned_to' <> '00000000-0000-0000-0000-00000000aa08' or t24_audits('maintenance.request_assigned', v_r) <> 1 then raise exception 'FAIL claim %', r; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa10');
  perform t_expect(format('select claim_maintenance_request(%L)', v_r), 'FORBIDDEN');

  -- assign: to people who manage maintenance here; the same again writes nothing; null takes it back
  perform t_expect(format('select assign_maintenance_request(%L, %L)', v_r, '00000000-0000-0000-0000-00000000aa02'), 'POLICY_VIOLATION: assignee');   -- housekeeping cannot manage
  perform t_expect(format('select assign_maintenance_request(%L, %L)', v_r, '00000000-0000-0000-0000-00000000aa05'), 'POLICY_VIOLATION: assignee');
  perform t_expect(format('select assign_maintenance_request(%L, %L)', v_r, '00000000-0000-0000-0000-00000000aa11'), 'POLICY_VIOLATION: assignee');   -- suspended
  perform t_expect(format('select assign_maintenance_request(%L, %L)', v_r, '00000000-0000-0000-0000-00000000aa03'), 'POLICY_VIOLATION: assignee');   -- revoked
  perform t_expect(format('select assign_maintenance_request(%L, %L)', v_r, '00000000-0000-0000-0000-00000000bb01'), 'POLICY_VIOLATION: assignee');   -- other hotel
  r := assign_maintenance_request(v_r, '00000000-0000-0000-0000-00000000aa10');
  perform assign_maintenance_request(v_r, '00000000-0000-0000-0000-00000000aa10');
  perform t_sys();
  if r ->> 'assigned_to' <> '00000000-0000-0000-0000-00000000aa10' or t24_audits('maintenance.request_assigned', v_r) <> 2 then raise exception 'FAIL reassign'; end if;
  if not exists (select 1 from audit_logs where action = 'maintenance.request_assigned' and entity_id = v_r
                    and metadata ->> 'from' = '00000000-0000-0000-0000-00000000aa08' and metadata ->> 'to' = '00000000-0000-0000-0000-00000000aa10'
                    and actor_user_id = '00000000-0000-0000-0000-00000000aa10') then raise exception 'FAIL assign audit content'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := assign_maintenance_request(v_r, null);
  perform t_sys();
  if r ->> 'assigned_to' is not null then raise exception 'FAIL unassign'; end if;

  -- priority
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform t_expect(format('select set_maintenance_priority(%L, %L)', v_r, 'asap'), 'POLICY_VIOLATION: priority');
  perform t_expect(format('select set_maintenance_priority(%L, null)', v_r), 'POLICY_VIOLATION: priority');
  r := set_maintenance_priority(v_r, 'urgent');
  perform set_maintenance_priority(v_r, 'urgent');
  perform t_sys();
  if r ->> 'priority' <> 'urgent' or t24_audits('maintenance.priority_set', v_r) <> 1 then raise exception 'FAIL priority'; end if;
  if not exists (select 1 from audit_logs where action = 'maintenance.priority_set' and entity_id = v_r and metadata ->> 'from' = 'normal' and metadata ->> 'to' = 'urgent') then raise exception 'FAIL priority audit content'; end if;

  -- start: takes the request when nobody has it; a double tap is a no-op; the room is untouched
  select housekeeping_status || '/' || operational_status into v_room_before from rooms where id = t24_room('104');
  perform t_as('00000000-0000-0000-0000-00000000aa10');
  r := start_maintenance_request(v_r);
  perform start_maintenance_request(v_r);
  perform t_sys();
  if r ->> 'status' <> 'in_progress' or r ->> 'assigned_to' <> '00000000-0000-0000-0000-00000000aa10' then raise exception 'FAIL start %', r; end if;
  if (select started_at from maintenance_requests where id = v_r) is null or t24_audits('maintenance.request_started', v_r) <> 1 then raise exception 'FAIL start fields or audit'; end if;
  if (select housekeeping_status || '/' || operational_status from rooms where id = t24_room('104')) <> v_room_before then raise exception 'FAIL starting a request changed the room'; end if;
  raise notice 'PASS work: view-only people refused, claim and assign rules, priority, start; each audited once, repeats are no-ops';
end $$;

-- 6. Resolve and cancel; a linked block is never released by resolving
do $$ declare
  a2 constant uuid := '00000000-0000-0000-0000-0000000000a2';
  t date := property_today('00000000-0000-0000-0000-0000000000a2') + 500;
  v_r uuid := t24_report('00000000-0000-0000-0000-00000000aa04', '102', 'Window will not close', 'high');
  v_other uuid := t24_report('00000000-0000-0000-0000-00000000aa04', '103', 'Wardrobe door loose');
  v_lobby uuid := t24_report('00000000-0000-0000-0000-00000000aa04', null, 'Lobby light flickers');
  v_block uuid; v_block_other uuid; r jsonb; v_claims_before bigint; v_room_before text; v_note text;
begin
  perform t_sys();
  -- the owner takes room 102 and 103 out of sale (room.block is an owner/manager permission, not a technician's)
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_block := (create_room_block(t24_room('102'), t, t + 3, 'window repair', 'fail', 'mt-block-1') ->> 'block_id')::uuid;
  v_block_other := (create_room_block(t24_room('103'), t, t + 3, 'wardrobe repair', 'fail', 'mt-block-2') ->> 'block_id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform t_expect(format('select create_room_block(%L, %L, %L, %L, %L, %L)', t24_room('104'), t, t + 3, 'x', 'fail', 'mt-block-3'), 'NOT_FOUND');

  -- linking: only a block of this request's room; clearing is allowed; repeats are no-ops
  perform t_expect(format('select link_maintenance_block(%L, %L)', v_r, v_block_other), 'POLICY_VIOLATION: block');
  perform t_expect(format('select link_maintenance_block(%L, %L)', v_r, gen_random_uuid()), 'POLICY_VIOLATION: block');
  perform t_expect(format('select link_maintenance_block(%L, %L)', v_lobby, v_block), 'POLICY_VIOLATION: a request with no room');
  perform t_expect(format('select link_maintenance_block(%L, %L)', v_r, coalesce((select id from room_inventory_claims where claim_type = 'stay' limit 1), gen_random_uuid())), 'POLICY_VIOLATION: block');
  r := link_maintenance_block(v_r, v_block);
  perform link_maintenance_block(v_r, v_block);
  perform t_sys();
  if r ->> 'room_block_id' <> v_block::text or t24_audits('maintenance.block_linked', v_r) <> 1 then raise exception 'FAIL link %', r; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform link_maintenance_block(v_other, v_block_other);
  r := link_maintenance_block(v_other, null);
  perform t_sys();
  if r ->> 'room_block_id' is not null then raise exception 'FAIL unlink'; end if;

  -- resolving: the note is kept, the answer says the block is still active, and nothing about the room or its claims moves
  select count(*) into v_claims_before from room_inventory_claims where room_id = t24_room('102');
  select housekeeping_status || '/' || operational_status into v_room_before from rooms where id = t24_room('102');
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform t_expect(format('select resolve_maintenance_request(%L, %L)', v_r, repeat('x', 1001)), 'POLICY_VIOLATION: note');
  r := resolve_maintenance_request(v_r, '  replaced the hinge ');
  perform t_sys();
  if r ->> 'status' <> 'resolved' or (r ->> 'block_still_active') <> 'true' then raise exception 'FAIL resolve result %', r; end if;
  if not exists (select 1 from maintenance_requests where id = v_r and resolution_note = 'replaced the hinge' and resolved_by = '00000000-0000-0000-0000-00000000aa08'
                    and resolved_at is not null and started_at is not null and assigned_to = '00000000-0000-0000-0000-00000000aa08') then raise exception 'FAIL resolve fields'; end if;
  if (select status from room_inventory_claims where id = v_block) <> 'active' then raise exception 'FAIL resolving released the room block'; end if;
  if (select count(*) from room_inventory_claims where room_id = t24_room('102')) <> v_claims_before
     or (select housekeeping_status || '/' || operational_status from rooms where id = t24_room('102')) <> v_room_before then raise exception 'FAIL resolving changed the room'; end if;
  if t24_audits('maintenance.request_resolved', v_r) <> 1 then raise exception 'FAIL resolved audit'; end if;

  -- again: nothing changes, the note stays; after the owner releases the block, the answer says it is no longer active
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform resolve_maintenance_request(v_r, 'edited');
  perform t_sys();
  select resolution_note into v_note from maintenance_requests where id = v_r;
  if v_note <> 'replaced the hinge' or t24_audits('maintenance.request_resolved', v_r) <> 1 then raise exception 'FAIL repeat resolve changed something'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform release_room_block(v_block);
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  r := resolve_maintenance_request(v_r);
  perform t_sys();
  if (r ->> 'block_still_active') <> 'false' then raise exception 'FAIL released block reported active'; end if;

  -- once resolved: nothing else works on it
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform t_expect(format('select start_maintenance_request(%L)', v_r), 'INVALID_STATE');
  perform t_expect(format('select claim_maintenance_request(%L)', v_r), 'INVALID_STATE');
  perform t_expect(format('select assign_maintenance_request(%L, %L)', v_r, '00000000-0000-0000-0000-00000000aa10'), 'INVALID_STATE');
  perform t_expect(format('select set_maintenance_priority(%L, %L)', v_r, 'low'), 'INVALID_STATE');
  perform t_expect(format('select link_maintenance_block(%L, null)', v_r), 'INVALID_STATE');
  perform t_expect(format('select cancel_maintenance_request(%L, %L)', v_r, 'too late'), 'INVALID_STATE');

  -- straight from open (one tap) takes the request on the way
  r := resolve_maintenance_request(v_lobby, 'bulb replaced');
  perform t_sys();
  if not exists (select 1 from maintenance_requests where id = v_lobby and status = 'resolved' and started_at is not null and assigned_to = '00000000-0000-0000-0000-00000000aa08') then raise exception 'FAIL one-tap resolve'; end if;
  if (r ->> 'block_still_active') <> 'false' then raise exception 'FAIL a request with no block reported one'; end if;

  -- cancel: reason required, repeat is a no-op, a cancelled request cannot be worked on or resolved
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform t_expect(format('select cancel_maintenance_request(%L, null)', v_other), 'POLICY_VIOLATION: reason');
  perform t_expect(format('select cancel_maintenance_request(%L, %L)', v_other, '   '), 'POLICY_VIOLATION: reason');
  perform t_expect(format('select cancel_maintenance_request(%L, %L)', v_other, repeat('x', 201)), 'POLICY_VIOLATION: reason');
  r := cancel_maintenance_request(v_other, 'duplicate of another report');
  perform cancel_maintenance_request(v_other, 'second tap');
  perform t_sys();
  if r ->> 'status' <> 'cancelled' or t24_audits('maintenance.request_cancelled', v_other) <> 1
     or (select cancel_reason from maintenance_requests where id = v_other) <> 'duplicate of another report' then raise exception 'FAIL cancel'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform t_expect(format('select start_maintenance_request(%L)', v_other), 'INVALID_STATE');
  perform t_expect(format('select resolve_maintenance_request(%L)', v_other), 'INVALID_STATE');
  perform t_expect(format('select claim_maintenance_request(%L)', v_other), 'INVALID_STATE');
  perform t_sys();
  raise notice 'PASS resolve and cancel: linked block never released and reported, room untouched, one-tap resolve, reason required, finished requests are closed';
end $$;

-- 7. The assignment picker
do $$ declare v_ids uuid[]; v_name text; begin
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  select array_agg(user_id order by user_id) into v_ids from list_maintenance_staff('00000000-0000-0000-0000-0000000000a2');
  select full_name into v_name from list_maintenance_staff('00000000-0000-0000-0000-0000000000a2') where user_id = '00000000-0000-0000-0000-00000000aa10';
  perform t_sys();
  if v_name <> 'Tunde Ojo' then raise exception 'FAIL picker did not use the profile name: %', v_name; end if;
  if not (v_ids @> array['00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000aa08', '00000000-0000-0000-0000-00000000aa10', '00000000-0000-0000-0000-00000000aa12']::uuid[]) then raise exception 'FAIL picker missing people: %', v_ids; end if;
  if v_ids && array['00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-00000000aa05', '00000000-0000-0000-0000-00000000aa11',
                    '00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-00000000bb01']::uuid[] then raise exception 'FAIL picker lists people who cannot manage maintenance: %', v_ids; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect($q$select * from list_maintenance_staff('00000000-0000-0000-0000-0000000000a2')$q$, 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect($q$select * from list_maintenance_staff('00000000-0000-0000-0000-0000000000a2')$q$, 'NOT_FOUND');
  perform t_sys();
  raise notice 'PASS picker: active staff who manage maintenance only, names from profiles, managers only';
end $$;

-- 8. Who can call what
do $$ begin
  perform t_sys(); perform set_config('role', 'anon', true);
  begin perform report_maintenance_request('00000000-0000-0000-0000-0000000000a2', null, 'Lobby', 'x', null, 'normal', null, null, 'k'); raise exception 'FAIL anon reported';
  exception when insufficient_privilege then null; end;
  begin perform start_maintenance_request(gen_random_uuid()); raise exception 'FAIL anon started';
  exception when insufficient_privilege then null; end;
  begin perform list_maintenance_staff('00000000-0000-0000-0000-0000000000a2'); raise exception 'FAIL anon listed staff';
  exception when insufficient_privilege then null; end;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin perform mt_request_json(null); raise exception 'FAIL client called an internal helper';
  exception when insufficient_privilege then null; end;
  perform t_sys();
  raise notice 'PASS access: anon and clients cannot reach the functions or internals they should not';
end $$;

-- 9. A deleted login keeps its resolved requests, with the person cleared
do $$ declare v_r uuid := t24_report('00000000-0000-0000-0000-00000000aa12', '105', 'Shower head loose'); begin
  perform t_as('00000000-0000-0000-0000-00000000aa12'); perform resolve_maintenance_request(v_r, 'tightened'); perform t_sys();
  if not exists (select 1 from maintenance_requests where id = v_r and resolved_by = '00000000-0000-0000-0000-00000000aa12' and reported_by = '00000000-0000-0000-0000-00000000aa12') then raise exception 'FAIL fixture'; end if;
  delete from auth.users where id = '00000000-0000-0000-0000-00000000aa12';
  if not exists (select 1 from maintenance_requests where id = v_r and status = 'resolved' and resolved_by is null and reported_by is null and assigned_to is null) then raise exception 'FAIL resolved request not kept after its worker was deleted'; end if;
  raise notice 'PASS deleting a worker keeps their resolved requests, with the person cleared';
end $$;

-- ---- race helpers (the pgbench scripts at the end of run.sh call these) ----
create table t24_ctx (label text primary key, id uuid not null);
create table t24_out (label text not null, val text);

-- A request nobody has, for clients to claim at once.
create function t24_race_setup() returns void language plpgsql as $$
begin
  insert into t24_ctx values ('claim', t24_report('00000000-0000-0000-0000-00000000aa04', '101', 'Race: radiator'));
end $$;

-- Odd clients are one technician, even clients the other: exactly one of them may end up with the request.
create function t24_try_claim(p_label text, p_n integer) returns boolean language plpgsql as $$
declare v_user text := case when p_n % 2 = 0 then '00000000-0000-0000-0000-00000000aa08' else '00000000-0000-0000-0000-00000000aa10' end; v_ok boolean;
begin
  perform t_as(v_user);
  begin perform claim_maintenance_request((select id from t24_ctx where label = 'claim')); v_ok := true;
  exception when sqlstate 'P0001' then v_ok := false; end;
  perform t_sys();
  insert into test_results (label, ok) values (p_label || case when p_n % 2 = 0 then '_a' else '_b' end, v_ok);
  return v_ok;
end $$;

-- The same report, same key, sent by many clients at once: one request, and every client gets the same answer.
create function t24_try_report(p_label text) returns boolean language plpgsql as $$
declare v_r jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  v_r := report_maintenance_request('00000000-0000-0000-0000-0000000000a2', t24_room('104'), null, 'Race: double tap', 'same words', 'normal', null, null, 'mt-race-key');
  perform t_sys();
  insert into t24_out values (p_label, v_r ->> 'request_id');
  return true;
end $$;
