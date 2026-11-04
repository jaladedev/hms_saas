-- Helper for the race "a block that moves the guest, against new bookings of the same room type" (end of run.sh).
-- Needs the fixtures of 19: room 101 of STD (a3) holds one guest for two nights; 102 to 105 are free for those nights.
\set ON_ERROR_STOP on

-- One client's attempt. p_kind 0 blocks room 101 and asks for the guest in it to be moved; anything else books one STD room as
-- staff. The label carries the kind ("<label>:<kind>"). True when the call blocked the room or got a room. Deadlocks are
-- retried, as a caller should; a third one is raised, which fails the run.
create function t45_try(p_label text, p_kind integer, p_off integer) returns boolean language plpgsql as $$
declare
  prop constant uuid := '00000000-0000-0000-0000-0000000000a2'; std constant uuid := '00000000-0000-0000-0000-0000000000a3';
  t date := property_today(prop); v_room uuid; r jsonb; attempt integer := 0; v_label text := p_label || ':' || least(p_kind, 1);
  v_rooms jsonb := jsonb_build_array(jsonb_build_object('room_type_id', std, 'adults', 2));
begin
  select id into v_room from rooms where property_id = prop and room_number = '101';
  loop
    attempt := attempt + 1;
    begin
      if p_kind = 0 then
        r := create_room_block(v_room, t + p_off, t + p_off + 2, 'race', 'move', gen_random_uuid()::text);
        insert into test_results (label, ok) values (v_label, (r ->> 'created')::boolean);
        return (r ->> 'created')::boolean;
      end if;
      perform create_reservation(prop, '00000000-0000-0000-0000-0000000000a5', 'staff_entry', t + p_off, t + p_off + 2, v_rooms, gen_random_uuid()::text);
      insert into test_results (label, ok) values (v_label, true);
      return true;
    exception
      when deadlock_detected or serialization_failure then
        if attempt >= 3 then insert into test_results (label, ok) values (p_label || '_gave_up', false); raise; end if;
      when sqlstate 'P0001' then
        if sqlerrm like 'ROOM_UNAVAILABLE%' then insert into test_results (label, ok) values (v_label, false); return false; end if;
        raise;
    end;
  end loop;
end $$;

-- After the race. The final state must be one of two shapes and nothing in between:
--   the block won:  room 101 is blocked, the guest is in another room for both nights, and the three rooms left were all booked (3 bookings);
--   the block lost: no block, the guest is still in 101 for both nights, and all four free rooms were booked (4 bookings).
-- A block can only lose when the rooms really ran out, so a block that is missing with a free room left is a failure too.
create function t45_check(p_label text, p_off integer) returns void language plpgsql as $$
declare
  prop constant uuid := '00000000-0000-0000-0000-0000000000a2'; std constant uuid := '00000000-0000-0000-0000-0000000000a3';
  t date := property_today(prop); v_rr uuid := (select rr from t19_rr where label = p_label and n = 0);
  v_blocks integer; v_bookings integer; v_in_101 boolean; v_stays integer;
begin
  select count(*) into v_blocks from room_inventory_claims c join rooms r on r.id = c.room_id
   where r.room_number = '101' and c.claim_type = 'block' and c.status = 'active' and c.start_date = t + p_off;
  select count(*) into v_bookings from test_results where label = p_label || ':1' and ok;
  select exists (select 1 from room_inventory_claims c join rooms r on r.id = c.room_id
                  where c.reservation_room_id = v_rr and c.status = 'active' and r.room_number = '101') into v_in_101;
  select count(*) into v_stays from room_inventory_claims c join rooms r on r.id = c.room_id
   where r.room_type_id = std and c.status = 'active' and c.claim_type = 'stay' and c.start_date = t + p_off and c.end_date = t + p_off + 2;

  if (select count(*) from test_results where label in (p_label || ':0', p_label || ':1')) <> 12 then raise exception 'FAIL a client got no clean answer'; end if;
  if exists (select 1 from test_results where label like '%gave_up') then raise exception 'FAIL deadlock retries exhausted'; end if;
  if v_blocks > 1 then raise exception 'FAIL % blocks on one room', v_blocks; end if;
  if (select count(*) from test_results where label = p_label || ':0' and ok) <> v_blocks then raise exception 'FAIL clients that report a block disagree with the claims'; end if;
  if (select coalesce(sum(end_date - start_date), 0) from room_inventory_claims where reservation_room_id = v_rr and status = 'active') <> 2
     or (select count(*) from room_inventory_claims where reservation_room_id = v_rr and status = 'active') <> 1 then
    raise exception 'FAIL the guest does not hold exactly two nights in one room';
  end if;
  if v_blocks = 1 then
    if v_in_101 then raise exception 'FAIL the guest is still in the blocked room'; end if;
    if v_bookings <> 3 then raise exception 'FAIL block won but % bookings (expected 3)', v_bookings; end if;
  else
    if not v_in_101 then raise exception 'FAIL no block, yet the guest was moved out of 101'; end if;
    if v_bookings <> 4 then raise exception 'FAIL block lost with a room still free: % bookings (expected 4)', v_bookings; end if;
  end if;
  if v_stays <> 1 + v_bookings then raise exception 'FAIL % stays for % bookings and one guest', v_stays, v_bookings; end if;
end $$;
