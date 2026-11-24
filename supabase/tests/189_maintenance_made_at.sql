-- Repair changes keep the time they were made (migration 189). Reuses t_as / t_sys / t_expect (05).
-- Hotel A: tenant a1, property a2, rooms 101-105. Users: aa08 maintenance A (maintenance.manage), aa02 housekeeping A (view only).
-- A block is one transaction, so now() is the same everywhere inside it: every time below is compared exactly, not within a margin.
-- Requests are inserted directly with a created_at in the past, because the function must not record a time before the request was reported.
\set ON_ERROR_STOP on

create function t189_req(p_created_ago interval) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into maintenance_requests (tenant_id, property_id, room_id, title, created_at)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
          (select id from rooms where property_id = '00000000-0000-0000-0000-0000000000a2' and room_number = '101'),
          'Tap drips', now() - p_created_ago)
  returning id into v;
  return v;
end $$;
create function t189_audit(p_action text, p_req uuid) returns jsonb language sql stable as $$
  select metadata from audit_logs where action = p_action and entity_id = p_req order by created_at desc limit 1
$$;
create function t189_audits(p_action text, p_req uuid) returns bigint language sql stable as $$
  select count(*) from audit_logs where action = p_action and entity_id = p_req
$$;

-- 1. The API: one function of each name, the old signatures gone, authenticated only
do $$ begin
  perform t_sys();
  if (select count(*) from pg_proc where proname in ('claim_maintenance_request', 'start_maintenance_request', 'resolve_maintenance_request')) <> 3 then
    raise exception 'FAIL there is not exactly one function of each repair name';
  end if;
  if to_regprocedure('claim_maintenance_request(uuid)') is not null or to_regprocedure('start_maintenance_request(uuid)') is not null
     or to_regprocedure('resolve_maintenance_request(uuid, text)') is not null then
    raise exception 'FAIL an old signature is still there';
  end if;
  if not has_function_privilege('authenticated', 'claim_maintenance_request(uuid, timestamptz)', 'execute')
     or not has_function_privilege('authenticated', 'start_maintenance_request(uuid, timestamptz)', 'execute')
     or not has_function_privilege('authenticated', 'resolve_maintenance_request(uuid, text, timestamptz)', 'execute') then
    raise exception 'FAIL authenticated cannot call a repair function';
  end if;
  if has_function_privilege('anon', 'claim_maintenance_request(uuid, timestamptz)', 'execute')
     or has_function_privilege('anon', 'start_maintenance_request(uuid, timestamptz)', 'execute')
     or has_function_privilege('anon', 'resolve_maintenance_request(uuid, text, timestamptz)', 'execute')
     or has_function_privilege('public', 'start_maintenance_request(uuid, timestamptz)', 'execute') then
    raise exception 'FAIL anon or public can call a repair function';
  end if;
  raise notice 'PASS 189 api: one function per name, old signatures gone, authenticated only';
end $$;

-- 2. No time given: exactly as before (now), and no made_at in the audit
do $$ declare v uuid;
begin
  perform t_sys();
  v := t189_req(interval '5 hours');
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform start_maintenance_request(v);
  perform resolve_maintenance_request(v, 'ok');
  perform t_sys();
  if (select started_at from maintenance_requests where id = v) <> now() or (select resolved_at from maintenance_requests where id = v) <> now() then
    raise exception 'FAIL without a time the request was not stamped now()';
  end if;
  if t189_audit('maintenance.request_started', v) ? 'made_at' or t189_audit('maintenance.request_resolved', v) ? 'made_at' then
    raise exception 'FAIL an online change wrote made_at to the audit';
  end if;
  raise notice 'PASS 189 no time given: stamped now() and no made_at in the audit, as before';
end $$;

-- 3. A change made earlier keeps its time; the audit shows both times
do $$ declare v uuid; r jsonb; a jsonb;
begin
  perform t_sys();
  v := t189_req(interval '5 hours');
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform start_maintenance_request(v, now() - interval '3 hours');
  perform t_sys();
  if (select started_at from maintenance_requests where id = v) <> now() - interval '3 hours' then raise exception 'FAIL start did not keep its time'; end if;
  a := t189_audit('maintenance.request_started', v);
  if (a ->> 'made_at')::timestamptz <> now() - interval '3 hours' or (a ->> 'received_at')::timestamptz <> now() then
    raise exception 'FAIL start audit times %', a;
  end if;

  perform t_as('00000000-0000-0000-0000-00000000aa08');
  r := resolve_maintenance_request(v, 'washer replaced', now() - interval '1 hour');
  perform t_sys();
  if (select resolved_at from maintenance_requests where id = v) <> now() - interval '1 hour' then raise exception 'FAIL resolve did not keep its time'; end if;
  if (select started_at from maintenance_requests where id = v) <> now() - interval '3 hours' then raise exception 'FAIL resolve moved started_at'; end if;
  if (select status from maintenance_requests where id = v) <> 'resolved' or r ->> 'status' <> 'resolved' then raise exception 'FAIL resolve result %', r; end if;
  a := t189_audit('maintenance.request_resolved', v);
  if (a ->> 'made_at')::timestamptz <> now() - interval '1 hour' or (a ->> 'received_at')::timestamptz <> now() then
    raise exception 'FAIL resolve audit times %', a;
  end if;
  raise notice 'PASS 189 made time kept: started_at and resolved_at are the times the changes were made, audit shows made_at and received_at';
end $$;

-- 4. The bounds: moved to the nearest bound, never refused
do $$ declare v uuid;
begin
  perform t_sys();
  -- in the future: now
  v := t189_req(interval '5 hours');
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform start_maintenance_request(v, now() + interval '1 day');
  perform t_sys();
  if (select started_at from maintenance_requests where id = v) <> now() then raise exception 'FAIL a future time was kept'; end if;

  -- older than two days: two days ago
  v := t189_req(interval '10 days');
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform start_maintenance_request(v, now() - interval '5 days');
  perform t_sys();
  if (select started_at from maintenance_requests where id = v) <> now() - interval '2 days' then raise exception 'FAIL a time older than two days was kept'; end if;

  -- before the request was reported: when it was reported
  v := t189_req(interval '5 hours');
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform start_maintenance_request(v, now() - interval '9 hours');
  perform t_sys();
  if (select started_at from maintenance_requests where id = v) <> (select created_at from maintenance_requests where id = v) then
    raise exception 'FAIL a time before the request was reported was kept';
  end if;

  -- a resolve before the start: the start
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform resolve_maintenance_request(v, null, now() - interval '9 hours');
  perform t_sys();
  if (select resolved_at from maintenance_requests where id = v) <> (select started_at from maintenance_requests where id = v) then
    raise exception 'FAIL a resolve before the start was kept';
  end if;

  -- resolve with no earlier start and a time: both are that time
  v := t189_req(interval '5 hours');
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform resolve_maintenance_request(v, null, now() - interval '30 minutes');
  perform t_sys();
  if (select started_at from maintenance_requests where id = v) <> now() - interval '30 minutes'
     or (select resolved_at from maintenance_requests where id = v) <> now() - interval '30 minutes' then
    raise exception 'FAIL a resolve with no start did not use its time for both';
  end if;
  raise notice 'PASS 189 bounds: future becomes now, older than two days becomes two days, before reported or started becomes reported or started';
end $$;

-- 5. Sending the same change again changes nothing, whatever time it carries
do $$ declare v uuid; s timestamptz; c timestamptz; n bigint;
begin
  perform t_sys();
  v := t189_req(interval '5 hours');
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform start_maintenance_request(v, now() - interval '3 hours');
  perform resolve_maintenance_request(v, 'first', now() - interval '2 hours');
  perform t_sys();
  select started_at, resolved_at into s, c from maintenance_requests where id = v;
  n := t189_audits('maintenance.request_resolved', v);

  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform resolve_maintenance_request(v, 'second', now() - interval '10 minutes');   -- a repeat of the resolve
  perform t_expect(format('select start_maintenance_request(%L, now() - interval ''1 hour'')', v), 'INVALID_STATE');   -- a start after it is fixed: refused as before
  perform t_sys();
  if (select started_at from maintenance_requests where id = v) <> s or (select resolved_at from maintenance_requests where id = v) <> c then
    raise exception 'FAIL a repeated change moved the times';
  end if;
  if (select resolution_note from maintenance_requests where id = v) <> 'first' then raise exception 'FAIL a repeated resolve changed the note'; end if;
  if t189_audits('maintenance.request_resolved', v) <> n then raise exception 'FAIL a repeated resolve wrote an audit row'; end if;

  -- a repeated start on a request already in progress
  v := t189_req(interval '5 hours');
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform start_maintenance_request(v, now() - interval '3 hours');
  perform t_sys();
  select started_at into s from maintenance_requests where id = v;
  n := t189_audits('maintenance.request_started', v);
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform start_maintenance_request(v, now() - interval '1 hour');
  perform t_sys();
  if (select started_at from maintenance_requests where id = v) <> s then raise exception 'FAIL a repeated start moved started_at'; end if;
  if t189_audits('maintenance.request_started', v) <> n then raise exception 'FAIL a repeated start wrote an audit row'; end if;
  raise notice 'PASS 189 repeats: a second start or resolve, with any time, changes nothing and writes no audit row';
end $$;

-- 6. Claim: the time appears in the audit only; the new argument opens no way round the permission check
do $$ declare v uuid; v2 uuid; a jsonb;
begin
  perform t_sys();
  v := t189_req(interval '5 hours');
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform claim_maintenance_request(v, now() - interval '2 hours');
  perform t_sys();
  if (select assigned_to from maintenance_requests where id = v) <> '00000000-0000-0000-0000-00000000aa08' then raise exception 'FAIL claim did not assign'; end if;
  a := t189_audit('maintenance.request_assigned', v);
  if (a ->> 'made_at')::timestamptz <> now() - interval '2 hours' or (a ->> 'received_at')::timestamptz <> now() or (a ->> 'claimed')::boolean is not true then
    raise exception 'FAIL claim audit %', a;
  end if;

  v2 := t189_req(interval '5 hours');
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  perform claim_maintenance_request(v2);
  perform t_sys();
  if t189_audit('maintenance.request_assigned', v2) ? 'made_at' then raise exception 'FAIL an online claim wrote made_at'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa02');                       -- housekeeping may view repairs but not work on them
  perform t_expect(format('select claim_maintenance_request(%L, now())', v2), 'NOT_FOUND');
  perform t_expect(format('select start_maintenance_request(%L, now())', v2), 'NOT_FOUND');
  perform t_expect(format('select resolve_maintenance_request(%L, null, now())', v2), 'NOT_FOUND');
  perform t_sys();
  raise notice 'PASS 189 claim: the time is only in the audit, and the new argument opens no way round the permission check';
end $$;
