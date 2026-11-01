-- Helpers for the block-versus-booking race in run.sh (after the block and transfer races). Loaded once; the race
-- itself is a pgbench script. Hotel A, property a2: the SOLO type (a4) has exactly one room, 201, so a block on
-- that room and a hold or a staff reservation for the type fight over the same single room.
-- Dates come from one stored value, so the block (which counts days from the property's today) and the hold
-- (which counts from the database's current date) always aim at the same two nights, whatever the time zones say.
\set ON_ERROR_STOP on

create table t27_ctx (id boolean primary key default true check (id), d date not null);

-- Finds the first two-night window from today + p_from on where room 201 has no active claim and no reservation
-- arrives, stores its first night, and returns how many days from today that is.
create function t27_setup(p_from integer) returns integer language plpgsql as $$
declare
  prop constant uuid := '00000000-0000-0000-0000-0000000000a2';
  base date := greatest(property_today(prop), current_date); v_room uuid; o integer;
begin
  select id into v_room from rooms where property_id = prop and room_number = '201';
  if v_room is null then raise exception 'FAIL fixture: room 201 is missing'; end if;
  for o in p_from .. 330 loop
    if not exists (select 1 from room_inventory_claims c where c.room_id = v_room and c.status = 'active'
                    and daterange(c.start_date, c.end_date, '[)') && daterange(base + o, base + o + 2, '[)'))
       and not exists (select 1 from reservations where arrival_date = base + o) then
      insert into t27_ctx values (true, base + o) on conflict (id) do update set d = excluded.d;
      return o;
    end if;
  end loop;
  raise exception 'FAIL fixture: no free window for the block race';
end $$;

-- One client's attempt on the stored window. p_kind 0 blocks room 201, 1 asks for a hold on the SOLO type (the way
-- the website does), 2 books it as staff. Returns true when this call got the room. The label carries the kind
-- ("<label>:0") so the check afterwards can say who won. Deadlocks are retried, as a caller should; a third one is
-- raised, which fails the run.
create function t27_try(p_label text, p_kind integer) returns boolean language plpgsql as $$
declare
  prop constant uuid := '00000000-0000-0000-0000-0000000000a2'; solo constant uuid := '00000000-0000-0000-0000-0000000000a4';
  v_d date := (select d from t27_ctx); v_room uuid; r jsonb; attempt integer := 0; v_label text := p_label || ':' || p_kind;
  v_rooms jsonb := jsonb_build_array(jsonb_build_object('room_type_id', solo, 'adults', 2));
begin
  select id into v_room from rooms where property_id = prop and room_number = '201';
  loop
    attempt := attempt + 1;
    begin
      if p_kind = 0 then
        r := create_room_block(v_room, v_d, v_d + 2, 'race', 'fail', gen_random_uuid()::text);
        insert into test_results (label, ok) values (v_label, (r ->> 'created')::boolean);
        return (r ->> 'created')::boolean;
      elsif p_kind = 1 then
        perform create_hold('book.hotel-a.test', v_d, v_d + 2, v_rooms,
                            jsonb_build_object('full_name', 'T27 Race Guest', 'email', 't27-' || gen_random_uuid() || '@example.com'),
                            gen_random_uuid()::text);
      else
        perform create_reservation(prop, '00000000-0000-0000-0000-0000000000a5', 'staff_entry', v_d, v_d + 2, v_rooms, gen_random_uuid()::text);
      end if;
      insert into test_results (label, ok) values (v_label, true);
      return true;
    exception
      when deadlock_detected or serialization_failure then
        if attempt >= 3 then raise; end if;
      when sqlstate 'P0001' then
        if sqlerrm like 'ROOM_UNAVAILABLE%' then insert into test_results (label, ok) values (v_label, false); return false; end if;
        raise;
    end;
  end loop;
end $$;
