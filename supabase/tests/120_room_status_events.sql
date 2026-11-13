-- room_status_events and room_status_history (migration 120). Hotel A: tenant a1, property a2; owner aa01. Another hotel's owner bb01.
\set ON_ERROR_STOP on

-- 1. a change made by a person is recorded with who, from and to; a repeat of the same status adds nothing
do $$ declare
  v_room uuid; v_before integer; r record; n integer;
begin
  perform t_sys();
  select id into v_room from rooms where property_id = '00000000-0000-0000-0000-0000000000a2' and room_number = '103';
  update rooms set housekeeping_status = 'clean' where id = v_room;
  select count(*) into v_before from room_status_events where room_id = v_room;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_housekeeping_status(v_room, 'dirty');
  perform set_housekeeping_status(v_room, 'dirty');
  perform set_housekeeping_status(v_room, 'in_progress');
  perform t_sys();
  select count(*) into n from room_status_events where room_id = v_room;
  if n <> v_before + 2 then raise exception 'FAIL expected two new events, got %', n - v_before; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  select * into r from room_status_history(v_room, 5);
  if r.field <> 'housekeeping_status' or r.from_value <> 'dirty' or r.to_value <> 'in_progress' or r.actor_name is null then raise exception 'FAIL newest row %', r; end if;
  perform t_sys();
  raise notice 'PASS room_status_events: each real change is one row with who, from and to; a repeat adds nothing; newest first with a name';
end $$;

-- 2. a change with no signed-in person has no name; an operational change is recorded too
do $$ declare
  v_room uuid; r record;
begin
  perform t_sys();
  select id into v_room from rooms where property_id = '00000000-0000-0000-0000-0000000000a2' and room_number = '104';
  update rooms set operational_status = 'out_of_service' where id = v_room;
  update rooms set operational_status = 'active' where id = v_room;
  select * into r from room_status_events where room_id = v_room order by created_at desc, id limit 1;
  if r.field <> 'operational_status' or r.to_value <> 'active' or r.actor_user_id is not null then raise exception 'FAIL system row %', r; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  select * into r from room_status_history(v_room, 1);
  if r.actor_name is not null then raise exception 'FAIL a system change should have no name %', r; end if;
  perform t_sys();
  raise notice 'PASS room_status_events: operational changes recorded; a change with no person has no name';
end $$;

-- 3. only people who may see the room read its history; the table itself is closed; the log cannot be rewritten
do $$ declare
  v_room uuid; n integer;
begin
  perform t_sys();
  select id into v_room from rooms where property_id = '00000000-0000-0000-0000-0000000000a2' and room_number = '103';
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  select count(*) into n from room_status_history(v_room, 50);
  if n <> 0 then raise exception 'FAIL another hotel read % rows', n; end if;
  select count(*) into n from room_status_history(gen_random_uuid(), 50);
  if n <> 0 then raise exception 'FAIL unknown room'; end if;
  begin perform 1 from room_status_events; raise exception 'FAIL table readable by a signed-in user';
  exception when insufficient_privilege then null; end;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if (select count(*) from room_status_history(v_room, 500)) > 50 then raise exception 'FAIL limit'; end if;
  perform t_sys();
  begin update room_status_events set to_value = 'x' where room_id = v_room; raise exception 'FAIL rewritten';
  exception when sqlstate '23514' then null; end;
  if has_function_privilege('anon', 'room_status_history(uuid,integer)', 'execute') then raise exception 'FAIL anon grant'; end if;
  raise notice 'PASS room_status_history: another hotel and unknown rooms read nothing, the table is closed, 50 rows at most, append-only';
end $$;
