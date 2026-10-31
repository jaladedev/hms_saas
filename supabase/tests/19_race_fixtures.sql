-- Helpers for the transfer and block concurrency tests at the end of run.sh. Loaded once; the races themselves are pgbench scripts.
-- Hotel A, property a2, type STD (a3) has five rooms 101 to 105.
\set ON_ERROR_STOP on

create table t19_rr (label text not null, n integer not null, rr uuid not null, primary key (label, n));

-- p_occupied booked reservations of two nights from today + p_off, one in each of rooms 101, 102, ... in turn.
create function t19_setup(p_label text, p_off integer, p_occupied integer) returns void language plpgsql as $$
declare
  prop constant uuid := '00000000-0000-0000-0000-0000000000a2'; typ constant uuid := '00000000-0000-0000-0000-0000000000a3';
  t date := property_today(prop); v_rr uuid; r record; i integer := 0;
begin
  if (select count(*) from rooms where property_id = prop and room_type_id = typ and operational_status = 'active') <> 5 then
    raise exception 'FAIL fixture: expected five active STD rooms';
  end if;
  for r in select id from rooms where property_id = prop and room_type_id = typ and operational_status = 'active' order by room_number limit p_occupied loop
    v_rr := test_rr(prop, typ, t + p_off, t + p_off + 2);
    perform claim_room(prop, null, r.id, t + p_off, t + p_off + 2, 'stay', v_rr);
    insert into t19_rr values (p_label, i, v_rr);
    i := i + 1;
  end loop;
end $$;

-- A client moves "its" reservation (client number modulo the fixture size). p_target is a room number or null for
-- the first free room; p_shift is how many nights into the stay the move starts. True when the move happened,
-- false when no room was free (the guest then keeps the old one). Deadlocks are retried, as a caller should.
create function t19_try_transfer(p_label text, p_n integer, p_target text, p_shift integer) returns boolean
language plpgsql as $$
declare
  prop constant uuid := '00000000-0000-0000-0000-0000000000a2';
  v_rr uuid; v_cnt integer; v_room uuid; v_start date; attempt integer := 0;
begin
  select count(*) into v_cnt from t19_rr where label = p_label;
  select rr into v_rr from t19_rr where label = p_label and n = p_n % v_cnt;
  select r.arrival_date into v_start from reservations r join reservation_rooms x on x.reservation_id = r.id where x.id = v_rr;
  if p_target is not null then select id into v_room from rooms where property_id = prop and room_number = p_target; end if;
  loop
    attempt := attempt + 1;
    begin
      perform transfer_room(v_rr, v_room, v_start + p_shift, 'race', gen_random_uuid()::text);
      insert into test_results (label, ok) values (p_label, true);
      return true;
    exception
      when deadlock_detected or serialization_failure then
        if attempt >= 3 then insert into test_results (label, ok) values (p_label || '_gave_up', false); raise; end if;
      when sqlstate 'P0001' then
        if sqlerrm like 'ROOM_UNAVAILABLE%' then insert into test_results (label, ok) values (p_label, false); return false; end if;
        -- Two clients moving the same guest from the same night: the first move ended the claim the second one was
        -- waiting on, so the second is refused cleanly. Counted separately from "no room free".
        if sqlerrm like 'POLICY_VIOLATION: effective date is outside the stay%' then
          insert into test_results (label, ok) values (p_label || '_stale', false); return false;
        end if;
        raise;
    end;
  end loop;
end $$;

-- A client blocks a room for the two nights from today + p_off. True when this call created the block.
create function t19_try_block(p_label text, p_room text, p_off integer, p_resolution text) returns boolean
language plpgsql as $$
declare
  prop constant uuid := '00000000-0000-0000-0000-0000000000a2';
  t date := property_today(prop); v_room uuid; r jsonb; attempt integer := 0;
begin
  select id into v_room from rooms where property_id = prop and room_number = p_room;
  loop
    attempt := attempt + 1;
    begin
      r := create_room_block(v_room, t + p_off, t + p_off + 2, 'race', p_resolution, gen_random_uuid()::text);
      insert into test_results (label, ok) values (p_label, (r ->> 'created')::boolean);
      return (r ->> 'created')::boolean;
    exception when deadlock_detected or serialization_failure then
      if attempt >= 3 then insert into test_results (label, ok) values (p_label || '_gave_up', false); raise; end if;
    end;
  end loop;
end $$;
