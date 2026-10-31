-- Housekeeping status (migration 018). Reuses t_as / t_sys / t_expect (05).
-- Users: aa02 housekeeping A, aa04 front desk A, aa05 accountant A (no housekeeping access), bb01 owner of Hotel B.
\set ON_ERROR_STOP on

do $$ declare v_room uuid; v_before integer; r jsonb; begin
  select id into v_room from rooms where property_id = '00000000-0000-0000-0000-0000000000a2' and room_number = '101';
  update rooms set housekeeping_status = 'dirty', operational_status = 'active' where id = v_room;
  select count(*) into v_before from audit_logs where action = 'room.housekeeping_set';

  -- housekeeping and front desk may set it; the change and its audit row land together
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  r := set_housekeeping_status(v_room, 'in_progress');
  if r ->> 'housekeeping_status' <> 'in_progress' or (select housekeeping_status from rooms where id = v_room) <> 'in_progress' then
    raise exception 'FAIL status not changed';
  end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform set_housekeeping_status(v_room, 'inspected');
  perform t_sys();
  if (select count(*) from audit_logs where action = 'room.housekeeping_set') <> v_before + 2 then raise exception 'FAIL audit rows'; end if;
  if not exists (select 1 from audit_logs where action = 'room.housekeeping_set' and entity_id = v_room
                   and metadata = '{"from":"in_progress","to":"inspected"}'::jsonb and actor_user_id = '00000000-0000-0000-0000-00000000aa04') then
    raise exception 'FAIL audit content';
  end if;

  -- setting the same status again changes nothing and writes nothing
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform set_housekeeping_status(v_room, 'inspected');
  perform t_sys();
  if (select count(*) from audit_logs where action = 'room.housekeeping_set') <> v_before + 2 then raise exception 'FAIL repeat wrote an audit row'; end if;
  raise notice 'PASS housekeeping: allowed roles change the status, audited once, repeat is a no-op';
end $$;

do $$ declare v_room uuid; begin
  select id into v_room from rooms where property_id = '00000000-0000-0000-0000-0000000000a2' and room_number = '102';
  update rooms set housekeeping_status = 'clean' where id = v_room;

  -- no permission, or another hotel: the room looks like it does not exist
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select set_housekeeping_status(%L, %L)', v_room, 'dirty'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select set_housekeeping_status(%L, %L)', v_room, 'dirty'), 'NOT_FOUND');
  perform t_sys();
  if (select housekeeping_status from rooms where id = v_room) <> 'clean' then raise exception 'FAIL refused call changed the room'; end if;

  -- bad input, unknown room, retired room
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select set_housekeeping_status(%L, %L)', v_room, 'spotless'), 'POLICY_VIOLATION');
  perform t_expect(format('select set_housekeeping_status(%L, null)', v_room), 'POLICY_VIOLATION');
  perform t_expect(format('select set_housekeeping_status(%L, %L)', gen_random_uuid(), 'dirty'), 'NOT_FOUND');
  perform t_sys();
  update rooms set operational_status = 'retired' where id = v_room;
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select set_housekeeping_status(%L, %L)', v_room, 'dirty'), 'INVALID_STATE');
  perform t_sys();
  update rooms set operational_status = 'active' where id = v_room;

  -- anon cannot call it, and clients still cannot write rooms directly
  perform set_config('role', 'anon', true);
  begin
    perform set_housekeeping_status(v_room, 'dirty');
    raise exception 'FAIL anon call succeeded';
  exception when insufficient_privilege then null;
  end;
  perform t_sys();
  raise notice 'PASS housekeeping: no permission or other hotel is NOT_FOUND, bad input refused, retired refused, anon refused';
end $$;
