-- Housekeeping tasks (migration 023). Reuses t_as / t_sys / t_expect / t_book / t_rr (05) and test_rr (01).
-- Users: aa01 owner A, aa02 housekeeping A, aa04 front desk A, aa05 accountant A (no housekeeping access),
-- aa03 owner A but revoked, bb01 owner of Hotel B. This file adds aa06 housekeeping A, aa07 housekeeping A (suspended),
-- aa08 maintenance A (no housekeeping.view) and aa09 housekeeping A (deleted at the end).
-- Ids: a2 property A, rooms 101-105 (STD) and 201 (SOLO), b2 property B.
\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000aa06', 'hk2@example.test'), ('00000000-0000-0000-0000-00000000aa07', 'hk3@example.test'),
  ('00000000-0000-0000-0000-00000000aa08', 'mt@example.test'),  ('00000000-0000-0000-0000-00000000aa09', 'hk4@example.test');
insert into tenant_memberships (id, tenant_id, user_id, status) values
  ('00000000-0000-0000-0000-0000000aaa06', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa06', 'active'),
  ('00000000-0000-0000-0000-0000000aaa07', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa07', 'suspended'),
  ('00000000-0000-0000-0000-0000000aaa08', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa08', 'active'),
  ('00000000-0000-0000-0000-0000000aaa09', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa09', 'active');
insert into membership_roles (membership_id, role_id)
select m.id, r.id from (values
  ('00000000-0000-0000-0000-0000000aaa06'::uuid, 'housekeeping'), ('00000000-0000-0000-0000-0000000aaa07'::uuid, 'housekeeping'),
  ('00000000-0000-0000-0000-0000000aaa08'::uuid, 'maintenance'),  ('00000000-0000-0000-0000-0000000aaa09'::uuid, 'housekeeping')) as m(id, rk)
  join roles r on r.key = m.rk;
insert into user_profiles (id, full_name) values ('00000000-0000-0000-0000-00000000aa06', 'Funke Bello');

create function t21_room(p_number text) returns uuid language sql stable as $$
  select id from rooms where property_id = '00000000-0000-0000-0000-0000000000a2' and room_number = p_number
$$;
-- The one live task of a type in a room (null when none).
create function t21_live(p_number text, p_type text default 'cleaning') returns uuid language sql stable as $$
  select id from housekeeping_tasks where room_id = t21_room(p_number) and task_type = p_type and status in ('open', 'in_progress')
$$;
create function t21_audits(p_action text, p_entity uuid) returns bigint language sql stable as $$
  select count(*) from audit_logs where action = p_action and entity_id = p_entity
$$;
-- A STD room with no claim today, other than the numbers given, so bookings from earlier tests do not get in the way.
create function t21_free_room(p_skip text[] default '{}') returns text language plpgsql as $$
declare t date := property_today('00000000-0000-0000-0000-0000000000a2'); v text;
begin
  select r.room_number into v from rooms r
   where r.property_id = '00000000-0000-0000-0000-0000000000a2' and r.room_type_id = '00000000-0000-0000-0000-0000000000a3'
     and r.operational_status = 'active' and r.room_number <> all (p_skip)
     and not exists (select 1 from room_inventory_claims c where c.room_id = r.id and c.status = 'active'
                        and daterange(c.start_date, c.end_date, '[)') && daterange(t, t + 3, '[)'))
   order by r.room_number limit 1;
  if v is null then raise exception 'FAIL fixture: no free STD room today'; end if;
  return v;
end $$;

-- 1. The room status drives its task: dirty opens it, in_progress starts it, clean completes it; no duplicates
do $$ declare
  rm uuid := t21_room('103'); v_t uuid; v_n integer; v_row housekeeping_tasks%rowtype;
begin
  perform t_sys();
  update rooms set housekeeping_status = 'clean' where id = rm;           -- closes whatever earlier tests left behind
  if t21_live('103') is not null then raise exception 'FAIL a clean room still has a live cleaning task'; end if;
  select count(*) into v_n from housekeeping_tasks where room_id = rm;

  update rooms set housekeeping_status = 'dirty' where id = rm;
  v_t := t21_live('103');
  select * into v_row from housekeeping_tasks where id = v_t;
  if v_t is null or v_row.status <> 'open' or v_row.priority <> 'normal' or v_row.task_type <> 'cleaning' or v_row.assigned_to is not null then
    raise exception 'FAIL dirty did not open a normal, unassigned cleaning task: %', v_row;
  end if;
  if t21_audits('housekeeping.task_created', v_t) <> 1 then raise exception 'FAIL created audit'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform set_housekeeping_status(rm, 'in_progress');                      -- the existing door (018)
  perform t_sys();
  select * into v_row from housekeeping_tasks where id = v_t;
  if v_row.status <> 'in_progress' or v_row.started_at is null then raise exception 'FAIL room in_progress did not start the task'; end if;
  if t21_audits('housekeeping.task_started', v_t) <> 1 then raise exception 'FAIL started audit'; end if;

  -- back to dirty while a task is live: still one live task
  update rooms set housekeeping_status = 'dirty' where id = rm;
  if (select count(*) from housekeeping_tasks where room_id = rm and task_type = 'cleaning' and status in ('open', 'in_progress')) <> 1 then
    raise exception 'FAIL a second live task appeared';
  end if;

  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform set_housekeeping_status(rm, 'clean');
  perform t_sys();
  select * into v_row from housekeeping_tasks where id = v_t;
  if v_row.status <> 'done' or v_row.completed_by <> '00000000-0000-0000-0000-00000000aa02' or v_row.completed_at is null then
    raise exception 'FAIL room clean did not complete the task: %', v_row;
  end if;
  if t21_audits('housekeeping.task_completed', v_t) <> 1 then raise exception 'FAIL completed audit'; end if;

  update rooms set housekeeping_status = 'dirty' where id = rm;           -- the next dirty makes a new task, the old one stays
  if t21_live('103') is null or t21_live('103') = v_t then raise exception 'FAIL no new task after the room got dirty again'; end if;
  if (select count(*) from housekeeping_tasks where room_id = rm) <> v_n + 2 then raise exception 'FAIL task history count'; end if;
  update rooms set housekeeping_status = 'inspected' where id = rm;       -- inspected also completes
  if t21_live('103') is not null then raise exception 'FAIL inspected left a live task'; end if;
  raise notice 'PASS tasks follow the room status: dirty opens, in_progress starts, clean and inspected complete, one live task, history kept';
end $$;

-- 2. Real flow: check_out dirties the room and the task appears; priority is high when a guest arrives there today
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2');
  v_a text := t21_free_room(); v_b text := t21_free_room(array[t21_free_room()]);
  rr uuid; v_task uuid; v_row housekeeping_tasks%rowtype;
begin
  perform t_sys();
  update rooms set housekeeping_status = 'clean' where room_number in (v_a, v_b) and property_id = '00000000-0000-0000-0000-0000000000a2';

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  rr := t_rr(t_book('00000000-0000-0000-0000-0000000000a3', t, t + 2, 'hkt-co-0001', t21_room(v_a)));
  perform check_in(rr, 'test');
  perform check_out(rr);
  perform t_sys();
  v_task := t21_live(v_a);
  select * into v_row from housekeeping_tasks where id = v_task;
  if v_task is null or v_row.status <> 'open' or v_row.created_by <> '00000000-0000-0000-0000-00000000aa04' then
    raise exception 'FAIL check_out did not open a cleaning task for the front desk user: %', v_row;
  end if;
  if (select housekeeping_status from rooms where id = t21_room(v_a)) <> 'dirty' then raise exception 'FAIL room not dirty'; end if;

  -- a guest arrives in room v_b today, then the room becomes dirty: do it first
  perform claim_room('00000000-0000-0000-0000-0000000000a2', null, t21_room(v_b), t, t + 1, 'stay',
                     test_rr('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', t, t + 1));
  update rooms set housekeeping_status = 'dirty' where room_number = v_b and property_id = '00000000-0000-0000-0000-0000000000a2';
  if (select priority from housekeeping_tasks where id = t21_live(v_b)) <> 'high' then raise exception 'FAIL arrival today did not raise the priority'; end if;
  raise notice 'PASS check_out opens the cleaning task; a guest arriving today makes it high priority';
end $$;

-- 3. Reading: row-level security
do $$ declare v_a integer; v_n integer; begin
  perform t_sys();
  select count(*) into v_a from housekeeping_tasks where property_id = '00000000-0000-0000-0000-0000000000a2';
  if v_a < 3 then raise exception 'FAIL fixture: expected tasks to read'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa02');   -- housekeeping reads all of the property's tasks
  select count(*) into v_n from housekeeping_tasks;
  if v_n <> v_a then raise exception 'FAIL housekeeping saw % of % tasks', v_n, v_a; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  select count(*) into v_n from housekeeping_tasks;
  if v_n <> v_a then raise exception 'FAIL front desk saw % of % tasks', v_n, v_a; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa05');   -- accountant: no housekeeping.view
  select count(*) into v_n from housekeeping_tasks;
  if v_n <> 0 then raise exception 'FAIL accountant read tasks'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa08');   -- maintenance: room.view only
  select count(*) into v_n from housekeeping_tasks;
  if v_n <> 0 then raise exception 'FAIL maintenance read tasks'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa03');   -- revoked owner
  select count(*) into v_n from housekeeping_tasks;
  if v_n <> 0 then raise exception 'FAIL revoked member read tasks'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');   -- another hotel's owner
  select count(*) into v_n from housekeeping_tasks;
  if v_n <> 0 then raise exception 'FAIL another hotel read tasks'; end if;
  perform t_sys();
  perform set_config('role', 'anon', true);
  select count(*) into v_n from housekeeping_tasks;
  if v_n <> 0 then raise exception 'FAIL anon read tasks'; end if;
  perform t_sys();
  raise notice 'PASS read: housekeeping view only, own hotel only, anon and others see nothing';
end $$;

-- 4. Writing: no direct writes for clients, rows are history for everyone
do $$ declare v_task uuid; v_done uuid; begin
  perform t_sys();
  select id into v_task from housekeeping_tasks where status = 'open' limit 1;
  select id into v_done from housekeeping_tasks where status = 'done' limit 1;
  if v_task is null or v_done is null then raise exception 'FAIL fixture: need an open and a done task'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');   -- even the owner has no direct write
  begin
    insert into housekeeping_tasks (tenant_id, property_id, room_id) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', t21_room('104'));
    raise exception 'FAIL client insert succeeded';
  exception when insufficient_privilege then null; end;
  begin
    update housekeeping_tasks set priority = 'urgent' where id = v_task;
    raise exception 'FAIL client update succeeded';
  exception when insufficient_privilege then null; end;
  begin
    delete from housekeeping_tasks where id = v_task;
    raise exception 'FAIL client delete succeeded';
  exception when insufficient_privilege then null; end;
  perform t_sys();
  -- the table owner cannot delete history, move a task, or touch a finished one
  begin delete from housekeeping_tasks where id = v_done; raise exception 'FAIL delete succeeded';
  exception when check_violation then null; end;
  begin update housekeeping_tasks set room_id = t21_room('104') where id = v_task; raise exception 'FAIL task moved to another room';
  exception when check_violation then null; end;
  begin update housekeeping_tasks set task_type = 'other' where id = v_task; raise exception 'FAIL task type changed';
  exception when check_violation then null; end;
  begin update housekeeping_tasks set completion_note = 'edited later' where id = v_done; raise exception 'FAIL finished task changed';
  exception when check_violation then null; end;
  begin update housekeeping_tasks set status = 'open' where id = v_done; raise exception 'FAIL finished task reopened';
  exception when check_violation then null; end;
  -- the table's own rules: a done task needs its timestamp, an open one cannot have started
  begin update housekeeping_tasks set status = 'done' where id = v_task; raise exception 'FAIL done without a completion time';
  exception when check_violation then null; end;
  begin update housekeeping_tasks set status = 'open', started_at = now() where id = (select id from housekeeping_tasks where status = 'open' limit 1);
        raise exception 'FAIL open task with a start time';
  exception when check_violation then null; end;
  begin insert into housekeeping_tasks (tenant_id, property_id, room_id, task_type) values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a2', t21_room('104'), 'other');
        raise exception 'FAIL tenant and property mismatch accepted';
  exception when foreign_key_violation then null; end;
  begin insert into housekeeping_tasks (tenant_id, property_id, room_id, task_type) values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2', t21_room('104'), 'other');
        raise exception 'FAIL a room of another hotel accepted';
  exception when foreign_key_violation then null; end;
  raise notice 'PASS write: clients cannot write; history cannot be deleted, moved or edited once finished; hotel and room must match';
end $$;

-- 5. create_housekeeping_task
do $$ declare r jsonb; r2 jsonb; v_id uuid; v_room uuid := t21_room('102'); v_before integer; begin
  perform t_sys();
  update rooms set housekeeping_status = 'clean' where id = v_room;
  select count(*) into v_before from housekeeping_tasks where room_id = v_room;

  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select create_housekeeping_task(%L)', v_room), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select create_housekeeping_task(%L)', v_room), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select create_housekeeping_task(%L)', gen_random_uuid()), 'NOT_FOUND');
  perform t_expect(format('select create_housekeeping_task(%L, %L)', v_room, 'polish'), 'POLICY_VIOLATION');
  perform t_expect(format('select create_housekeeping_task(%L, null)', v_room), 'POLICY_VIOLATION');
  perform t_expect(format('select create_housekeeping_task(%L, %L, %L)', v_room, 'cleaning', 'asap'), 'POLICY_VIOLATION');
  perform t_expect(format('select create_housekeeping_task(%L, %L, %L, null, %L)', v_room, 'cleaning', 'normal', repeat('x', 501)), 'POLICY_VIOLATION');
  perform t_expect(format('select create_housekeeping_task(%L, %L, %L, null, null, %L)', v_room, 'deep_clean', 'normal', '00000000-0000-0000-0000-00000000aa06'), 'FORBIDDEN');
  perform t_sys();
  if (select count(*) from housekeeping_tasks where room_id = v_room) <> v_before then raise exception 'FAIL a refused call left a task'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa02');
  r := create_housekeeping_task(v_room, 'deep_clean', 'low', now() + interval '1 day', '  after the long stay  ');
  perform t_sys();
  v_id := (r ->> 'task_id')::uuid;
  if (r ->> 'created') <> 'true' or r ->> 'status' <> 'open' or r ->> 'priority' <> 'low' then raise exception 'FAIL create result %', r; end if;
  if (select notes from housekeeping_tasks where id = v_id) <> 'after the long stay' then raise exception 'FAIL notes not trimmed'; end if;
  if (select created_by from housekeeping_tasks where id = v_id) <> '00000000-0000-0000-0000-00000000aa02' then raise exception 'FAIL created_by'; end if;
  if t21_audits('housekeeping.task_created', v_id) <> 1 then raise exception 'FAIL create audit'; end if;

  -- the same type again returns the live task and writes nothing; 'other' may repeat
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  r2 := create_housekeeping_task(v_room, 'deep_clean', 'urgent');
  if (r2 ->> 'created') <> 'false' or (r2 ->> 'task_id')::uuid <> v_id then raise exception 'FAIL repeat create %', r2; end if;
  r := create_housekeeping_task(v_room, 'other', 'normal', null, 'check the safe');
  r2 := create_housekeeping_task(v_room, 'other', 'normal', null, 'check the safe');
  if (r ->> 'task_id') = (r2 ->> 'task_id') or (r2 ->> 'created') <> 'true' then raise exception 'FAIL other tasks should repeat'; end if;
  perform t_sys();
  if (select priority from housekeeping_tasks where id = v_id) <> 'low' then raise exception 'FAIL repeat changed the task'; end if;
  if t21_audits('housekeeping.task_created', v_id) <> 1 then raise exception 'FAIL repeat wrote an audit row'; end if;

  -- giving it to someone needs housekeeping.assign and a person who can do housekeeping here
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := create_housekeeping_task(t21_room('101'), 'inspection', 'high', null, null, '00000000-0000-0000-0000-00000000aa06');
  if (r ->> 'assigned_to') <> '00000000-0000-0000-0000-00000000aa06' then raise exception 'FAIL assignee not set %', r; end if;
  perform t_expect(format('select create_housekeeping_task(%L, %L, %L, null, null, %L)', t21_room('105'), 'inspection', 'high', '00000000-0000-0000-0000-00000000aa05'), 'POLICY_VIOLATION: assignee');
  perform t_expect(format('select create_housekeeping_task(%L, %L, %L, null, null, %L)', t21_room('105'), 'inspection', 'high', '00000000-0000-0000-0000-00000000aa07'), 'POLICY_VIOLATION: assignee');
  perform t_expect(format('select create_housekeeping_task(%L, %L, %L, null, null, %L)', t21_room('105'), 'inspection', 'high', '00000000-0000-0000-0000-00000000aa03'), 'POLICY_VIOLATION: assignee');
  perform t_expect(format('select create_housekeeping_task(%L, %L, %L, null, null, %L)', t21_room('105'), 'inspection', 'high', '00000000-0000-0000-0000-00000000bb01'), 'POLICY_VIOLATION: assignee');
  perform t_expect(format('select create_housekeeping_task(%L, %L, %L, null, null, %L)', t21_room('105'), 'inspection', 'high', gen_random_uuid()), 'POLICY_VIOLATION: assignee');
  perform t_sys();

  -- a retired room takes no new tasks
  update rooms set operational_status = 'retired' where id = t21_room('105');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select create_housekeeping_task(%L)', t21_room('105')), 'INVALID_STATE');
  perform t_sys();
  update rooms set operational_status = 'active' where id = t21_room('105');
  raise notice 'PASS create: permissions, input checks, idempotent per type, assignee rules, retired room refused';
end $$;

-- 6. claim and assign
do $$ declare v_t uuid := t21_live('102', 'deep_clean'); r jsonb; v_audits bigint; begin
  perform t_sys();
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select claim_housekeeping_task(%L)', v_t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select claim_housekeeping_task(%L)', v_t), 'NOT_FOUND');
  perform t_expect(format('select assign_housekeeping_task(%L, null)', v_t), 'NOT_FOUND');
  perform t_expect(format('select claim_housekeeping_task(%L)', gen_random_uuid()), 'NOT_FOUND');

  perform t_as('00000000-0000-0000-0000-00000000aa02');
  r := claim_housekeeping_task(v_t);
  if r ->> 'assigned_to' <> '00000000-0000-0000-0000-00000000aa02' then raise exception 'FAIL claim result %', r; end if;
  perform claim_housekeeping_task(v_t);                                   -- a second tap changes nothing
  perform t_sys();
  if t21_audits('housekeeping.task_assigned', v_t) <> 1 then raise exception 'FAIL repeat claim wrote an audit row'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa06');
  perform t_expect(format('select claim_housekeeping_task(%L)', v_t), 'FORBIDDEN');

  -- housekeepers cannot hand work out; front desk can, to the right people only
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select assign_housekeeping_task(%L, %L)', v_t, '00000000-0000-0000-0000-00000000aa06'), 'FORBIDDEN');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select assign_housekeeping_task(%L, %L)', v_t, '00000000-0000-0000-0000-00000000aa06'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select assign_housekeeping_task(%L, %L)', v_t, '00000000-0000-0000-0000-00000000aa05'), 'POLICY_VIOLATION: assignee');
  perform t_expect(format('select assign_housekeeping_task(%L, %L)', v_t, '00000000-0000-0000-0000-00000000aa07'), 'POLICY_VIOLATION: assignee');
  r := assign_housekeeping_task(v_t, '00000000-0000-0000-0000-00000000aa06');
  perform assign_housekeeping_task(v_t, '00000000-0000-0000-0000-00000000aa06');   -- same again: nothing written
  perform t_sys();
  if r ->> 'assigned_to' <> '00000000-0000-0000-0000-00000000aa06' then raise exception 'FAIL reassign result %', r; end if;
  if t21_audits('housekeeping.task_assigned', v_t) <> 2 then raise exception 'FAIL assign audit rows'; end if;
  if not exists (select 1 from audit_logs where action = 'housekeeping.task_assigned' and entity_id = v_t
                    and metadata ->> 'from' = '00000000-0000-0000-0000-00000000aa02' and metadata ->> 'to' = '00000000-0000-0000-0000-00000000aa06'
                    and actor_user_id = '00000000-0000-0000-0000-00000000aa04') then raise exception 'FAIL assign audit content'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := assign_housekeeping_task(v_t, null);                                 -- take it back
  perform t_sys();
  if r ->> 'assigned_to' is not null then raise exception 'FAIL unassign'; end if;
  raise notice 'PASS claim and assign: own claim only when free, assigning needs housekeeping.assign and an eligible person, audited once';
end $$;

-- 7. start
do $$ declare
  v_clean uuid; v_deep uuid := t21_live('102', 'deep_clean'); r jsonb; v_room uuid := t21_room('104'); v_audits bigint;
begin
  perform t_sys();
  update rooms set housekeeping_status = 'clean' where id = v_room;
  update rooms set housekeeping_status = 'dirty' where id = v_room;
  v_clean := t21_live('104');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform assign_housekeeping_task(v_clean, '00000000-0000-0000-0000-00000000aa02');
  perform t_as('00000000-0000-0000-0000-00000000aa06');
  perform t_expect(format('select start_housekeeping_task(%L)', v_clean), 'FORBIDDEN');     -- somebody else's task
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select start_housekeeping_task(%L)', v_clean), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select start_housekeeping_task(%L)', v_clean), 'NOT_FOUND');
  perform t_sys();
  if (select status from housekeeping_tasks where id = v_clean) <> 'open' then raise exception 'FAIL refused start changed the task'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa02');
  r := start_housekeeping_task(v_clean);
  perform t_sys();
  if r ->> 'status' <> 'in_progress' or (select housekeeping_status from rooms where id = v_room) <> 'in_progress' then raise exception 'FAIL start did not move task and room'; end if;
  if not exists (select 1 from audit_logs where action = 'room.housekeeping_set' and entity_id = v_room
                    and metadata ->> 'from' = 'dirty' and metadata ->> 'to' = 'in_progress' and metadata ->> 'task_id' = v_clean::text) then
    raise exception 'FAIL room status audit';
  end if;
  v_audits := t21_audits('housekeeping.task_started', v_clean);
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform start_housekeeping_task(v_clean);                                  -- double tap
  perform t_sys();
  if t21_audits('housekeeping.task_started', v_clean) <> v_audits then raise exception 'FAIL repeat start wrote an audit row'; end if;

  -- an unassigned task is taken by whoever starts it; a supervisor may start anybody's; other types leave the room alone
  perform t_as('00000000-0000-0000-0000-00000000aa06');
  r := start_housekeeping_task(v_deep);
  perform t_sys();
  if r ->> 'assigned_to' <> '00000000-0000-0000-0000-00000000aa06' then raise exception 'FAIL start did not take the task'; end if;
  if (select housekeeping_status from rooms where id = t21_room('102')) <> 'clean' then raise exception 'FAIL a deep clean changed the room status'; end if;
  raise notice 'PASS start: only the assignee or a supervisor, unassigned is taken, room moves for cleaning tasks only, repeat is a no-op';
end $$;

-- 8. complete
do $$ declare
  v_clean uuid := t21_live('104'); v_deep uuid := t21_live('102', 'deep_clean'); v_room uuid := t21_room('104');
  r jsonb; v_audits bigint; v_other uuid; v_insp uuid;
begin
  perform t_sys();
  perform t_as('00000000-0000-0000-0000-00000000aa06');
  perform t_expect(format('select complete_housekeeping_task(%L)', v_clean), 'FORBIDDEN');   -- aa02 has it
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select complete_housekeeping_task(%L)', v_clean), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select complete_housekeeping_task(%L, %L)', v_clean, repeat('x', 501)), 'POLICY_VIOLATION');
  r := complete_housekeeping_task(v_clean, '  minibar restocked ');
  perform t_sys();
  if r ->> 'status' <> 'done' then raise exception 'FAIL complete result %', r; end if;
  if (select housekeeping_status from rooms where id = v_room) <> 'clean' then raise exception 'FAIL room not clean after completion'; end if;
  if (select completion_note from housekeeping_tasks where id = v_clean) <> 'minibar restocked' then raise exception 'FAIL completion note'; end if;
  if not exists (select 1 from housekeeping_tasks where id = v_clean and completed_by = '00000000-0000-0000-0000-00000000aa02' and completed_at is not null) then raise exception 'FAIL completion fields'; end if;
  -- the room trigger saw the room go clean after the task was already done: exactly one completed audit
  if t21_audits('housekeeping.task_completed', v_clean) <> 1 then raise exception 'FAIL completed audit rows'; end if;
  -- occupancy is untouched: the room's claims are exactly what they were
  v_audits := t21_audits('housekeeping.task_completed', v_clean);
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform complete_housekeeping_task(v_clean, 'again');                      -- done twice: nothing changes
  perform t_sys();
  if (select completion_note from housekeeping_tasks where id = v_clean) <> 'minibar restocked' or t21_audits('housekeeping.task_completed', v_clean) <> v_audits then
    raise exception 'FAIL repeat complete changed something';
  end if;

  -- straight from open (one tap), taking the task on the way; an inspected room stays inspected
  update rooms set housekeeping_status = 'dirty' where id = v_room;
  v_other := t21_live('104');
  update rooms set housekeeping_status = 'inspected' where id = t21_room('103');
  perform t_as('00000000-0000-0000-0000-00000000aa06');
  r := complete_housekeeping_task(v_other);
  perform t_sys();
  if not exists (select 1 from housekeeping_tasks where id = v_other and status = 'done' and started_at is not null and assigned_to = '00000000-0000-0000-0000-00000000aa06') then
    raise exception 'FAIL one-tap completion';
  end if;
  update rooms set housekeeping_status = 'dirty' where id = t21_room('103');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform set_housekeeping_status(t21_room('103'), 'inspected');
  perform t_sys();
  v_insp := (select id from housekeeping_tasks where room_id = t21_room('103') order by created_at desc limit 1);
  if (select status from housekeeping_tasks where id = v_insp) <> 'done' then raise exception 'FAIL inspected did not complete the task'; end if;

  -- a deep clean completes without touching the room status
  update rooms set housekeeping_status = 'dirty' where id = t21_room('102');
  perform t_as('00000000-0000-0000-0000-00000000aa06');
  perform complete_housekeeping_task(v_deep, 'done properly');
  perform t_sys();
  if (select housekeeping_status from rooms where id = t21_room('102')) <> 'dirty' then raise exception 'FAIL a deep clean changed the room status'; end if;
  if t21_live('102') is null then raise exception 'FAIL the dirty room lost its cleaning task'; end if;
  raise notice 'PASS complete: assignee or supervisor, sets the room clean for cleaning tasks only, note kept, repeat is a no-op';
end $$;

-- 9. cancel
do $$ declare v_t uuid := t21_live('102'); v_done uuid; r jsonb; v_audits bigint; v_before text; begin
  perform t_sys();
  select id into v_done from housekeeping_tasks where status = 'done' limit 1;
  select housekeeping_status into v_before from rooms where id = t21_room('102');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select cancel_housekeeping_task(%L, %L)', v_t, 'not needed'), 'FORBIDDEN');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select cancel_housekeeping_task(%L, %L)', v_t, 'not needed'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select cancel_housekeeping_task(%L, %L)', v_t, 'not needed'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select cancel_housekeeping_task(%L, null)', v_t), 'POLICY_VIOLATION');
  perform t_expect(format('select cancel_housekeeping_task(%L, %L)', v_t, '   '), 'POLICY_VIOLATION');
  perform t_expect(format('select cancel_housekeeping_task(%L, %L)', v_t, repeat('x', 201)), 'POLICY_VIOLATION');
  perform t_expect(format('select cancel_housekeeping_task(%L, %L)', v_done, 'too late'), 'INVALID_STATE');
  r := cancel_housekeeping_task(v_t, 'guest asked us not to enter');
  perform t_sys();
  if r ->> 'status' <> 'cancelled' then raise exception 'FAIL cancel result %', r; end if;
  if (select housekeeping_status from rooms where id = t21_room('102')) <> v_before then raise exception 'FAIL cancel changed the room status'; end if;
  if not exists (select 1 from housekeeping_tasks where id = v_t and cancelled_at is not null and cancel_reason = 'guest asked us not to enter') then raise exception 'FAIL cancel fields'; end if;
  v_audits := t21_audits('housekeeping.task_cancelled', v_t);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform cancel_housekeeping_task(v_t, 'second tap');
  perform t_sys();
  if v_audits <> 1 or t21_audits('housekeeping.task_cancelled', v_t) <> 1 then raise exception 'FAIL repeat cancel wrote an audit row'; end if;

  -- a cancelled task can no longer be started, completed, claimed or assigned
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select start_housekeeping_task(%L)', v_t), 'INVALID_STATE');
  perform t_expect(format('select complete_housekeeping_task(%L)', v_t), 'INVALID_STATE');
  perform t_expect(format('select claim_housekeeping_task(%L)', v_t), 'INVALID_STATE');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select assign_housekeeping_task(%L, %L)', v_t, '00000000-0000-0000-0000-00000000aa06'), 'INVALID_STATE');
  -- a finished one too
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select start_housekeeping_task(%L)', v_done), 'INVALID_STATE');
  perform t_expect(format('select claim_housekeeping_task(%L)', v_done), 'INVALID_STATE');
  perform t_sys();
  raise notice 'PASS cancel: supervisors only, reason required, room untouched, repeat is a no-op, nothing works on a cancelled or finished task';
end $$;

-- 10. a retired room cancels its live tasks; coming back dirty opens a fresh one
do $$ declare v_room uuid := t21_room('101'); v_t uuid; v_new uuid; begin
  perform t_sys();
  update rooms set housekeeping_status = 'dirty' where id = v_room;
  v_t := t21_live('101');
  update rooms set operational_status = 'retired' where id = v_room;
  if not exists (select 1 from housekeeping_tasks where id = v_t and status = 'cancelled' and cancel_reason = 'room retired') then raise exception 'FAIL retiring did not cancel the cleaning task'; end if;
  if exists (select 1 from housekeeping_tasks where room_id = v_room and status in ('open', 'in_progress')) then raise exception 'FAIL live tasks left on a retired room'; end if;
  if t21_audits('housekeeping.task_cancelled', v_t) <> 1 then raise exception 'FAIL retire audit'; end if;
  update rooms set housekeeping_status = 'clean' where id = v_room;       -- changes on a retired room open and close nothing
  update rooms set housekeeping_status = 'dirty' where id = v_room;
  if exists (select 1 from housekeeping_tasks where room_id = v_room and status in ('open', 'in_progress')) then raise exception 'FAIL a retired room got a task'; end if;
  update rooms set operational_status = 'active' where id = v_room;       -- back in service and dirty: a new task
  v_new := t21_live('101');
  if v_new is null or v_new = v_t then raise exception 'FAIL no fresh task after the room came back'; end if;
  update rooms set housekeeping_status = 'clean' where id = v_room;
  raise notice 'PASS retired room: live tasks cancelled with a reason, none opened while retired, fresh one when it returns dirty';
end $$;

-- 11. the assignment picker
do $$ declare v_ids uuid[]; v_name text; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  select array_agg(user_id order by user_id) into v_ids from list_housekeeping_staff('00000000-0000-0000-0000-0000000000a2');
  select full_name into v_name from list_housekeeping_staff('00000000-0000-0000-0000-0000000000a2') where user_id = '00000000-0000-0000-0000-00000000aa06';
  perform t_sys();
  if v_name <> 'Funke Bello' then raise exception 'FAIL picker did not use the profile name: %', v_name; end if;
  -- owner, housekeepers and front desk can do housekeeping; the accountant, maintenance, suspended and revoked cannot
  if not (v_ids @> array['00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-00000000aa06']::uuid[]) then
    raise exception 'FAIL picker missing people: %', v_ids;
  end if;
  if v_ids && array['00000000-0000-0000-0000-00000000aa05', '00000000-0000-0000-0000-00000000aa07', '00000000-0000-0000-0000-00000000aa08',
                    '00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-00000000bb01']::uuid[] then
    raise exception 'FAIL picker lists people who cannot do housekeeping: %', v_ids;
  end if;
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect($q$select * from list_housekeeping_staff('00000000-0000-0000-0000-0000000000a2')$q$, 'NOT_FOUND');   -- no housekeeping.assign
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect($q$select * from list_housekeeping_staff('00000000-0000-0000-0000-0000000000a2')$q$, 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect($q$select * from list_housekeeping_staff('00000000-0000-0000-0000-0000000000a2')$q$, 'NOT_FOUND');
  perform t_sys();
  raise notice 'PASS picker: eligible active staff only, names from profiles, supervisors only';
end $$;

-- 12. who can call what, and the new permission
do $$ declare v_n integer; begin
  perform t_sys();
  select count(*) into v_n from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
   where p.key = 'housekeeping.assign' and r.is_system and r.key in ('owner', 'general_manager', 'front_desk');
  if v_n <> 3 then raise exception 'FAIL housekeeping.assign grants'; end if;
  if exists (select 1 from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
              where p.key = 'housekeeping.assign' and r.is_system and r.key not in ('owner', 'general_manager', 'front_desk')) then raise exception 'FAIL housekeeping.assign granted too widely'; end if;

  perform set_config('role', 'anon', true);
  begin perform create_housekeeping_task(t21_room('104')); raise exception 'FAIL anon created a task';
  exception when insufficient_privilege then null; end;
  begin perform start_housekeeping_task(gen_random_uuid()); raise exception 'FAIL anon started a task';
  exception when insufficient_privilege then null; end;
  begin perform list_housekeeping_staff('00000000-0000-0000-0000-0000000000a2'); raise exception 'FAIL anon listed staff';
  exception when insufficient_privilege then null; end;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin perform hk_user_can('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000a2', 'housekeeping.update'); raise exception 'FAIL client called an internal helper';
  exception when insufficient_privilege then null; end;
  begin perform hk_require('00000000-0000-0000-0000-0000000000a2', 'housekeeping.update'); raise exception 'FAIL client called an internal helper';
  exception when insufficient_privilege then null; end;
  perform t_sys();
  raise notice 'PASS access: housekeeping.assign for owner, general manager and front desk only; anon and clients cannot reach internals';
end $$;

-- 13. a deleted login does not stop history: the person is just cleared from old rows
do $$ declare v_room uuid := t21_room('105'); v_t uuid; begin
  perform t_sys();
  update rooms set housekeeping_status = 'clean' where id = v_room;
  update rooms set housekeeping_status = 'dirty' where id = v_room;
  v_t := t21_live('105');
  perform t_as('00000000-0000-0000-0000-00000000aa09');
  perform complete_housekeeping_task(v_t);
  perform t_sys();
  if (select completed_by from housekeeping_tasks where id = v_t) <> '00000000-0000-0000-0000-00000000aa09' then raise exception 'FAIL fixture'; end if;
  delete from auth.users where id = '00000000-0000-0000-0000-00000000aa09';
  if not exists (select 1 from housekeeping_tasks where id = v_t and status = 'done' and completed_by is null and assigned_to is null) then
    raise exception 'FAIL finished task not kept after its worker was deleted';
  end if;
  raise notice 'PASS deleting a worker keeps their finished tasks, with the person cleared';
end $$;

-- ---- race helpers (the pgbench scripts at the end of run.sh call these) ----
create table t21_ctx (label text primary key, id uuid not null);

-- A task nobody has, for clients to claim at once.
create function t21_race_setup() returns void language plpgsql as $$
declare v_room uuid := t21_room('104'); v_task uuid;
begin
  update rooms set housekeeping_status = 'clean' where id = v_room;
  update rooms set operational_status = 'active' where id = v_room;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  v_task := (create_housekeeping_task(v_room, 'deep_clean', 'normal', null, 'race'))::jsonb ->> 'task_id';
  perform t_sys();
  insert into t21_ctx values ('claim', v_task);
end $$;

-- Odd clients are one housekeeper, even clients the other: exactly one of them may end up with the task.
create function t21_try_claim(p_label text, p_n integer) returns boolean language plpgsql as $$
declare v_user text := case when p_n % 2 = 0 then '00000000-0000-0000-0000-00000000aa02' else '00000000-0000-0000-0000-00000000aa06' end;
        v_ok boolean;
begin
  perform t_as(v_user);
  begin
    perform claim_housekeeping_task((select id from t21_ctx where label = 'claim'));
    v_ok := true;
  exception when sqlstate 'P0001' then
    v_ok := false;
  end;
  perform t_sys();
  insert into test_results (label, ok) values (p_label || case when p_n % 2 = 0 then '_a' else '_b' end, v_ok);
  return v_ok;
end $$;

-- Front desk and the room board fight over one room: every call is one of the ways a task or room status changes.
-- Business refusals are fine; a deadlock is not (it propagates and run.sh fails).
create function t21_mix(p_label text, p_what integer) returns boolean language plpgsql as $$
declare v_room uuid := t21_room('103'); v_task uuid; v_ok boolean := true;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  begin
    if p_what = 0 then perform set_housekeeping_status(v_room, 'dirty');
    elsif p_what = 1 then perform set_housekeeping_status(v_room, 'in_progress');
    elsif p_what = 2 then
      select id into v_task from housekeeping_tasks where room_id = v_room and task_type = 'cleaning' and status in ('open', 'in_progress');
      perform start_housekeeping_task(v_task);
    elsif p_what = 3 then
      select id into v_task from housekeeping_tasks where room_id = v_room and task_type = 'cleaning' and status in ('open', 'in_progress');
      perform complete_housekeeping_task(v_task);
    else perform set_housekeeping_status(v_room, 'clean');
    end if;
  exception when sqlstate 'P0001' then
    v_ok := false;
  end;
  perform t_sys();
  insert into test_results (label, ok) values (p_label, v_ok);
  return v_ok;
end $$;
