-- Monitoring (migration 094). The shared test database keeps other tests' rows, so counts are compared as before and after.
\set ON_ERROR_STOP on

-- 1. a heartbeat is recorded, a failure keeps the last good time and shows the error, a success clears it
do $$
declare h jsonb; v_ok timestamptz;
begin
  perform t_sys();
  delete from ops_heartbeats where job = 'maintenance';
  if (ops_health() -> 'maintenance') <> 'null'::jsonb then raise exception 'FAIL a job that never ran shows %', ops_health() -> 'maintenance'; end if;

  perform record_heartbeat('maintenance', true, null);
  h := ops_health() -> 'maintenance';
  if h ->> 'last_ok_at' is null or h ->> 'last_error' is not null then raise exception 'FAIL good run recorded as %', h; end if;
  v_ok := (h ->> 'last_ok_at')::timestamptz;

  perform record_heartbeat('maintenance', false, repeat('x', 900));
  h := ops_health() -> 'maintenance';
  if (h ->> 'last_ok_at')::timestamptz <> v_ok then raise exception 'FAIL a failed run moved the last good time'; end if;
  if length(h ->> 'last_error') <> 500 then raise exception 'FAIL error not cut to 500 characters: %', length(h ->> 'last_error'); end if;

  perform record_heartbeat('maintenance', true, null);
  if (ops_health() -> 'maintenance' ->> 'last_error') is not null then raise exception 'FAIL a good run did not clear the error'; end if;
  if (select count(*) from ops_heartbeats where job = 'maintenance') <> 1 then raise exception 'FAIL more than one row for a job'; end if;
  raise notice 'PASS ops health: heartbeat recorded, failure keeps last good time, success clears the error';
end $$;

-- 2. the counts see stuck work
do $$
declare
  b jsonb; a jsonb; v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; v_res uuid; v_ev uuid;
begin
  perform t_sys();
  select id into v_res from reservations where tenant_id = v_t limit 1;
  if v_res is null then raise exception 'FAIL test data has no reservation'; end if;

  b := ops_health();
  insert into email_outbox (tenant_id, reservation_id, kind, to_email, status, next_attempt_at)
    values (v_t, v_res, 'booking_held', 'x@example.test', 'pending', now() - interval '2 hours');
  insert into email_outbox (tenant_id, reservation_id, kind, to_email, status, next_attempt_at)
    values (v_t, v_res, 'booking_held', 'y@example.test', 'pending', now() + interval '5 minutes');   -- not due yet: not stuck
  insert into email_outbox (tenant_id, reservation_id, kind, to_email, status, attempts)
    values (v_t, v_res, 'booking_held', 'z@example.test', 'failed', 5);
  a := ops_health();
  if (a ->> 'emails_stuck')::int - (b ->> 'emails_stuck')::int <> 1 then raise exception 'FAIL emails_stuck moved by %', (a ->> 'emails_stuck')::int - (b ->> 'emails_stuck')::int; end if;
  if (a ->> 'emails_failed_7d')::int - (b ->> 'emails_failed_7d')::int <> 1 then raise exception 'FAIL emails_failed_7d moved by %', (a ->> 'emails_failed_7d')::int - (b ->> 'emails_failed_7d')::int; end if;
  raise notice 'PASS ops health: stuck and failed emails counted, an email not yet due is not';
end $$;

-- 3. only the server can read it or write a heartbeat
do $$
declare v_state text;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin
    perform ops_health(); v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  if v_state <> 'refused' then raise exception 'FAIL a signed-in owner could read ops_health'; end if;
  begin
    perform record_heartbeat('maintenance', true, null); v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  if v_state <> 'refused' then raise exception 'FAIL a signed-in owner could write a heartbeat'; end if;
  perform t_sys();
  begin
    set local role anon;
    perform ops_health(); v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could read ops_health'; end if;
  begin
    set local role authenticated;
    perform 1 from ops_heartbeats; v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL the heartbeat table is readable by a signed-in user'; end if;
  raise notice 'PASS ops health: owner and anon refused, heartbeat table closed';
end $$;
