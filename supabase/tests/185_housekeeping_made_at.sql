-- Housekeeping changes keep the time they were made (migration 185). Reuses t_as / t_sys / t_expect (05).
-- Hotel A: tenant a1, property a2, rooms 101-105. Users: aa02 housekeeping A, aa05 accountant A (no housekeeping access).
-- A block is one transaction, so now() is the same everywhere inside it: every time below is compared exactly, not within a margin.
-- Tasks are inserted directly as 'other' tasks (several may be live for one room and they never touch the room's status), with a
-- created_at in the past, because the function must not record a time before the task existed and a fresh task is created "now".
\set ON_ERROR_STOP on

create function t185_room(p_number text) returns uuid language sql stable as $$
  select id from rooms where property_id = '00000000-0000-0000-0000-0000000000a2' and room_number = p_number
$$;
create function t185_task(p_room text, p_created_ago interval) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into housekeeping_tasks (tenant_id, property_id, room_id, task_type, created_at)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', t185_room(p_room), 'other', now() - p_created_ago)
  returning id into v;
  return v;
end $$;
create function t185_audit(p_action text, p_task uuid) returns jsonb language sql stable as $$
  select metadata from audit_logs where action = p_action and entity_id = p_task order by created_at desc limit 1
$$;
create function t185_audits(p_action text, p_task uuid) returns bigint language sql stable as $$
  select count(*) from audit_logs where action = p_action and entity_id = p_task
$$;

-- 1. The API: one function of each name, the old signatures gone, authenticated may call it and anon may not, the helper is private
do $$ begin
  perform t_sys();
  if (select count(*) from pg_proc where proname in ('claim_housekeeping_task', 'start_housekeeping_task', 'complete_housekeeping_task')) <> 3 then
    raise exception 'FAIL there is not exactly one function of each housekeeping name';
  end if;
  if to_regprocedure('start_housekeeping_task(uuid)') is not null or to_regprocedure('claim_housekeeping_task(uuid)') is not null
     or to_regprocedure('complete_housekeeping_task(uuid, text)') is not null then
    raise exception 'FAIL an old signature is still there';
  end if;
  if not has_function_privilege('authenticated', 'start_housekeeping_task(uuid, timestamptz)', 'execute')
     or not has_function_privilege('authenticated', 'claim_housekeeping_task(uuid, timestamptz)', 'execute')
     or not has_function_privilege('authenticated', 'complete_housekeeping_task(uuid, text, timestamptz)', 'execute') then
    raise exception 'FAIL authenticated cannot call a housekeeping function';
  end if;
  if has_function_privilege('anon', 'start_housekeeping_task(uuid, timestamptz)', 'execute')
     or has_function_privilege('anon', 'claim_housekeeping_task(uuid, timestamptz)', 'execute')
     or has_function_privilege('anon', 'complete_housekeeping_task(uuid, text, timestamptz)', 'execute')
     or has_function_privilege('public', 'start_housekeeping_task(uuid, timestamptz)', 'execute') then
    raise exception 'FAIL anon or public can call a housekeeping function';
  end if;
  if has_function_privilege('authenticated', 'hk_effective_time(timestamptz, timestamptz)', 'execute')
     or has_function_privilege('anon', 'hk_effective_time(timestamptz, timestamptz)', 'execute') then
    raise exception 'FAIL the time helper is callable by clients';
  end if;
  raise notice 'PASS 185 api: one function per name, old signatures gone, authenticated only, helper private';
end $$;

-- 2. No time given: exactly as before (now)
do $$ declare v uuid; r jsonb;
begin
  perform t_sys();
  v := t185_task('101', interval '5 hours');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform start_housekeeping_task(v);
  perform complete_housekeeping_task(v, 'ok');
  perform t_sys();
  if (select started_at from housekeeping_tasks where id = v) <> now() or (select completed_at from housekeeping_tasks where id = v) <> now() then
    raise exception 'FAIL without a time the task was not stamped now()';
  end if;
  if t185_audit('housekeeping.task_started', v) ? 'made_at' or t185_audit('housekeeping.task_completed', v) ? 'made_at' then
    raise exception 'FAIL an online change wrote made_at to the audit';
  end if;
  raise notice 'PASS 185 no time given: stamped now() and no made_at in the audit, as before';
end $$;

-- 3. A change made earlier keeps its time: start, then complete, both inside the bounds; the audit shows both times
do $$ declare v uuid; r jsonb; a jsonb;
begin
  perform t_sys();
  v := t185_task('102', interval '5 hours');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  r := start_housekeeping_task(v, now() - interval '3 hours');
  perform t_sys();
  if (select started_at from housekeeping_tasks where id = v) <> now() - interval '3 hours' then raise exception 'FAIL start did not keep its time'; end if;
  a := t185_audit('housekeeping.task_started', v);
  if (a ->> 'made_at')::timestamptz <> now() - interval '3 hours' or (a ->> 'received_at')::timestamptz <> now() then
    raise exception 'FAIL start audit times %', a;
  end if;

  perform t_as('00000000-0000-0000-0000-00000000aa02');
  r := complete_housekeeping_task(v, 'minibar restocked', now() - interval '1 hour');
  perform t_sys();
  if (select completed_at from housekeeping_tasks where id = v) <> now() - interval '1 hour' then raise exception 'FAIL complete did not keep its time'; end if;
  if (select started_at from housekeeping_tasks where id = v) <> now() - interval '3 hours' then raise exception 'FAIL complete moved started_at'; end if;
  if r ->> 'status' <> 'done' then raise exception 'FAIL complete result %', r; end if;
  a := t185_audit('housekeeping.task_completed', v);
  if (a ->> 'made_at')::timestamptz <> now() - interval '1 hour' or (a ->> 'received_at')::timestamptz <> now() then
    raise exception 'FAIL complete audit times %', a;
  end if;
  raise notice 'PASS 185 made time kept: started_at and completed_at are the times the changes were made, audit shows made_at and received_at';
end $$;

-- 4. The bounds: moved to the nearest bound, never refused
do $$ declare v uuid;
begin
  perform t_sys();
  -- in the future: now
  v := t185_task('103', interval '5 hours');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform start_housekeeping_task(v, now() + interval '1 day');
  perform t_sys();
  if (select started_at from housekeeping_tasks where id = v) <> now() then raise exception 'FAIL a future time was kept'; end if;

  -- older than two days: two days ago
  v := t185_task('103', interval '10 days');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform start_housekeeping_task(v, now() - interval '5 days');
  perform t_sys();
  if (select started_at from housekeeping_tasks where id = v) <> now() - interval '2 days' then raise exception 'FAIL a time older than two days was kept'; end if;

  -- before the task existed: when it was created
  v := t185_task('103', interval '5 hours');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform start_housekeeping_task(v, now() - interval '9 hours');
  perform t_sys();
  if (select started_at from housekeeping_tasks where id = v) <> (select created_at from housekeeping_tasks where id = v) then
    raise exception 'FAIL a time before the task existed was kept';
  end if;

  -- a completion before the start: the start
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform complete_housekeeping_task(v, null, now() - interval '9 hours');
  perform t_sys();
  if (select completed_at from housekeeping_tasks where id = v) <> (select started_at from housekeeping_tasks where id = v) then
    raise exception 'FAIL a completion before the start was kept';
  end if;

  -- complete with no earlier start and a time: both are that time
  v := t185_task('104', interval '5 hours');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform complete_housekeeping_task(v, null, now() - interval '30 minutes');
  perform t_sys();
  if (select started_at from housekeeping_tasks where id = v) <> now() - interval '30 minutes'
     or (select completed_at from housekeeping_tasks where id = v) <> now() - interval '30 minutes' then
    raise exception 'FAIL a completion with no start did not use its time for both';
  end if;
  raise notice 'PASS 185 bounds: future becomes now, older than two days becomes two days, before creation or start becomes creation or start';
end $$;

-- 5. Sending the same change again changes nothing, whatever time it carries
do $$ declare v uuid; s timestamptz; c timestamptz; n bigint;
begin
  perform t_sys();
  v := t185_task('105', interval '5 hours');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform start_housekeeping_task(v, now() - interval '3 hours');
  perform complete_housekeeping_task(v, 'first', now() - interval '2 hours');
  perform t_sys();
  select started_at, completed_at into s, c from housekeeping_tasks where id = v;
  n := t185_audits('housekeeping.task_completed', v);

  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform complete_housekeeping_task(v, 'second', now() - interval '10 minutes');   -- a repeat of the completion
  perform t_expect(format('select start_housekeeping_task(%L, now() - interval ''1 hour'')', v), 'INVALID_STATE');   -- a start after done: refused as before
  perform t_sys();
  if (select started_at from housekeeping_tasks where id = v) <> s or (select completed_at from housekeeping_tasks where id = v) <> c then
    raise exception 'FAIL a repeated change moved the times';
  end if;
  if (select completion_note from housekeeping_tasks where id = v) <> 'first' then raise exception 'FAIL a repeated completion changed the note'; end if;
  if t185_audits('housekeeping.task_completed', v) <> n then raise exception 'FAIL a repeated completion wrote an audit row'; end if;

  -- a repeated start on a task already in progress
  v := t185_task('101', interval '5 hours');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform start_housekeeping_task(v, now() - interval '3 hours');
  perform t_sys();
  select started_at into s from housekeeping_tasks where id = v;
  n := t185_audits('housekeeping.task_started', v);
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform start_housekeeping_task(v, now() - interval '1 hour');
  perform t_sys();
  if (select started_at from housekeeping_tasks where id = v) <> s then raise exception 'FAIL a repeated start moved started_at'; end if;
  if t185_audits('housekeeping.task_started', v) <> n then raise exception 'FAIL a repeated start wrote an audit row'; end if;
  raise notice 'PASS 185 repeats: a second start or completion, with any time, changes nothing and writes no audit row';
end $$;

-- 6. Claim: the time appears in the audit only; permissions are unchanged by the new argument
do $$ declare v uuid; v2 uuid; a jsonb;
begin
  perform t_sys();
  v := t185_task('102', interval '5 hours');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform claim_housekeeping_task(v, now() - interval '2 hours');
  perform t_sys();
  if (select assigned_to from housekeeping_tasks where id = v) <> '00000000-0000-0000-0000-00000000aa02' then raise exception 'FAIL claim did not assign'; end if;
  a := t185_audit('housekeeping.task_assigned', v);
  if (a ->> 'made_at')::timestamptz <> now() - interval '2 hours' or (a ->> 'received_at')::timestamptz <> now() or (a ->> 'claimed')::boolean is not true then
    raise exception 'FAIL claim audit %', a;
  end if;

  v2 := t185_task('102', interval '5 hours');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform claim_housekeeping_task(v2);
  perform t_sys();
  if t185_audit('housekeeping.task_assigned', v2) ? 'made_at' then raise exception 'FAIL an online claim wrote made_at'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa05');                       -- the accountant has no housekeeping access
  perform t_expect(format('select claim_housekeeping_task(%L, now())', v2), 'NOT_FOUND');
  perform t_expect(format('select start_housekeeping_task(%L, now())', v2), 'NOT_FOUND');
  perform t_expect(format('select complete_housekeeping_task(%L, null, now())', v2), 'NOT_FOUND');
  perform t_sys();
  raise notice 'PASS 185 claim: the time is only in the audit, and the new argument opens no way round the permission check';
end $$;

-- 7. A cleaning task completed with a time still sets the room clean (the room rules are untouched)
do $$ declare rm uuid := t185_room('103'); v uuid;
begin
  perform t_sys();
  update rooms set housekeeping_status = 'clean' where id = rm;
  update rooms set housekeeping_status = 'dirty' where id = rm;
  select id into v from housekeeping_tasks where room_id = rm and task_type = 'cleaning' and status in ('open', 'in_progress');
  if v is null then raise exception 'FAIL dirty did not open a cleaning task'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform start_housekeeping_task(v, now() - interval '1 hour');
  if (select housekeeping_status from rooms where id = rm) <> 'in_progress' then raise exception 'FAIL start with a time did not move the room'; end if;
  perform complete_housekeeping_task(v, null, now() - interval '30 minutes');
  perform t_sys();
  if (select housekeeping_status from rooms where id = rm) <> 'clean' then raise exception 'FAIL complete with a time did not clean the room'; end if;
  if (select status from housekeeping_tasks where id = v) <> 'done' then raise exception 'FAIL task not done'; end if;
  raise notice 'PASS 185 room rules: start and complete with a time still move the room to in progress and clean';
end $$;
