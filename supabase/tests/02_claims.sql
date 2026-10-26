-- Behavioural tests for room_inventory_claims and claim_room (a2 = property, a3 = STD type, a4 = SOLO type, see 01_seed.sql).
\set ON_ERROR_STOP on

-- Back-to-back stays: departure day equals next arrival day
do $$ begin
  perform claim_room('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4', null, '2027-03-01', '2027-03-05', 'stay', gen_random_uuid());
  perform claim_room('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4', null, '2027-03-05', '2027-03-08', 'stay', gen_random_uuid());
  raise notice 'PASS back-to-back stays';
end $$;

-- Overlap rejected
do $$ begin
  begin
    perform claim_room('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4', null, '2027-03-04', '2027-03-06', 'stay', gen_random_uuid());
    raise exception 'FAIL overlap was accepted';
  exception when sqlstate 'P0001' then raise notice 'PASS overlap rejected';
  end;
end $$;

-- Stale hold does not block (cleanup job disabled)
do $$ declare v_id uuid; begin
  v_id := claim_room('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4', null, '2027-04-01', '2027-04-03', 'hold', gen_random_uuid(), now() - interval '1 minute');
  perform claim_room('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4', null, '2027-04-01', '2027-04-03', 'stay', gen_random_uuid());
  if (select status from room_inventory_claims where id = v_id) <> 'expired' then
    raise exception 'FAIL stale hold not expired';
  end if;
  raise notice 'PASS stale hold released by booking';
end $$;

-- Live hold blocks
do $$ begin
  perform claim_room('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4', null, '2027-05-01', '2027-05-03', 'hold', gen_random_uuid(), now() + interval '20 minutes');
  begin
    perform claim_room('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4', null, '2027-05-02', '2027-05-04', 'stay', gen_random_uuid());
    raise exception 'FAIL live hold did not block';
  exception when sqlstate 'P0001' then raise notice 'PASS live hold blocks';
  end;
end $$;

-- Block over an existing stay is rejected; block then stay is rejected too
do $$ begin
  begin
    perform claim_room('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4', null, '2027-03-02', '2027-03-03', 'block', null, null, 'repairs');
    raise exception 'FAIL block over stay accepted';
  exception when sqlstate 'P0001' then raise notice 'PASS block over stay rejected';
  end;
  perform claim_room('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4', null, '2027-06-01', '2027-06-04', 'block', null, null, 'repairs');
  begin
    perform claim_room('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4', null, '2027-06-02', '2027-06-03', 'stay', gen_random_uuid());
    raise exception 'FAIL stay over block accepted';
  exception when sqlstate 'P0001' then raise notice 'PASS stay over block rejected';
  end;
end $$;

-- Out-of-service and retired rooms are never candidates
do $$ begin
  update rooms set operational_status = 'out_of_service' where room_number = '201';
  begin
    perform claim_room('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a4', null, '2027-07-01', '2027-07-02', 'stay', gen_random_uuid());
    raise exception 'FAIL out-of-service room claimed';
  exception when sqlstate 'P0001' then raise notice 'PASS out-of-service excluded';
  end;
  update rooms set operational_status = 'active' where room_number = '201';
end $$;

-- A reservation room cannot occupy two rooms on the same night
do $$ declare rr uuid := gen_random_uuid(); begin
  perform claim_room('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', null, '2027-08-01', '2027-08-04', 'stay', rr);
  begin
    perform claim_room('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', null, '2027-08-03', '2027-08-05', 'stay', rr);
    raise exception 'FAIL self-overlap accepted';
  exception when exclusion_violation then raise notice 'PASS self-overlap rejected';
            when sqlstate 'P0001' then raise notice 'PASS self-overlap rejected';
  end;
end $$;
