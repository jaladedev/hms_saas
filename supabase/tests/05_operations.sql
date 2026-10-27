-- Reservation operations: check-in, check-out, transfer, blocks, cancellation. Dates are relative
-- to today in the property's timezone. Requires users from 03_security.sql:
--   aa01 owner A, aa02 housekeeping A, bb01 owner B; this file adds aa04 front desk A.
-- Ids: a2 property, a3 STD (5 rooms), a4 SOLO (room 201), a5 guest A.
\set ON_ERROR_STOP on

insert into auth.users (id) values ('00000000-0000-0000-0000-00000000aa04');
insert into tenant_memberships (id, tenant_id, user_id, status)
values ('00000000-0000-0000-0000-0000000aaa04', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa04', 'active');
insert into membership_roles (membership_id, role_id)
select '00000000-0000-0000-0000-0000000aaa04', id from roles where key = 'front_desk';

create function t_as(u text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', u, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function t_sys() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('role', 'postgres', true);
end $$;
create function t_expect(p_sql text, p_msg text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when sqlstate 'P0001' then
    if sqlerrm not like p_msg || '%' then raise exception 'FAIL expected "%" but got "%"', p_msg, sqlerrm; end if;
    return;
  end;
  raise exception 'FAIL expected "%" but call succeeded: %', p_msg, p_sql;
end $$;
create function t_book(p_type uuid, p_arr date, p_dep date, p_key text, p_room uuid default null) returns jsonb
language sql as $$
  select create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'staff_entry', p_arr, p_dep,
    jsonb_build_array(jsonb_build_object('room_type_id', p_type, 'requested_room_id', p_room, 'adults', 1)), p_key)
$$;
create function t_rr(r jsonb) returns uuid language sql as $$ select (r -> 'rooms' -> 0 ->> 'reservation_room_id')::uuid $$;

-- Cancellation policy used for new bookings from here on
insert into property_policies (tenant_id, property_id, version, effective_from, config)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 1, '2026-01-01',
  '{"cancellation_rules":[{"within_hours":48,"charge":{"type":"nights","value":1}},{"within_hours":0,"charge":{"type":"percent","value":100}}]}');

-- 1. Check-in: permissions, state, readiness, early arrival
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2');
  rr uuid; r jsonb; web jsonb; fut uuid;
begin
  rr := t_rr(t_book('00000000-0000-0000-0000-0000000000a4', t, t + 3, 'ops-ci-0001'));
  perform t_as('00000000-0000-0000-0000-00000000aa02');   -- housekeeping
  perform t_expect(format('select check_in(%L)', rr), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');   -- other tenant
  perform t_expect(format('select check_in(%L)', rr), 'NOT_FOUND');
  perform t_sys();
  update rooms set housekeeping_status = 'dirty' where room_number = '201';
  perform t_as('00000000-0000-0000-0000-00000000aa04');   -- front desk
  perform t_expect(format('select check_in(%L)', rr), 'INVALID_STATE: ROOM_NOT_READY');
  r := check_in(rr, 'guest agreed to wait for cleaning');
  if r ->> 'status' <> 'checked_in' then raise exception 'FAIL check-in result %', r; end if;
  perform t_expect(format('select check_in(%L)', rr), 'INVALID_STATE');
  perform t_sys();
  if (select reservation_status from reservations where id = (select reservation_id from reservation_rooms where id = rr)) <> 'checked_in'
    then raise exception 'FAIL reservation not checked in'; end if;
  fut := t_rr(t_book('00000000-0000-0000-0000-0000000000a3', t + 5, t + 6, 'ops-ci-0002'));
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select check_in(%L)', fut), 'POLICY_VIOLATION');
  perform t_sys();
  web := create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'website', t, t + 1,
    '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":1}]'::jsonb, 'ops-ci-0003');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select check_in(%L)', t_rr(web)), 'INVALID_STATE');
  perform t_sys();
  raise notice 'PASS check-in: permissions, readiness override, early arrival and unpaid holds';
end $$;

-- 2. Early check-out releases the room; second check-out is rejected
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2');
  rr uuid; r jsonb;
begin
  select rr2.id into rr from reservation_rooms rr2 join reservations x on x.id = rr2.reservation_id
   where x.booking_reference is not null and rr2.room_status = 'checked_in' and x.arrival_date = t
     and rr2.room_type_id = '00000000-0000-0000-0000-0000000000a4';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := check_out(rr);
  if (r ->> 'early_departure')::boolean is not true then raise exception 'FAIL expected early departure %', r; end if;
  perform t_expect(format('select check_out(%L)', rr), 'INVALID_STATE');
  perform t_sys();
  if (select housekeeping_status from rooms where room_number = '201') <> 'dirty' then raise exception 'FAIL room not dirty'; end if;
  if (select reservation_status from reservations where id = (select reservation_id from reservation_rooms where id = rr)) <> 'checked_out'
    then raise exception 'FAIL reservation not checked out'; end if;
  perform t_book('00000000-0000-0000-0000-0000000000a4', t + 1, t + 2, 'ops-co-0001');   -- room is sellable again
  raise notice 'PASS early check-out frees the room and marks it dirty';
end $$;

-- 3. Check-out on the departure day leaves claims alone
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2');
  rr uuid; res uuid; r jsonb;
begin
  r := t_book('00000000-0000-0000-0000-0000000000a3', t, t + 2, 'ops-co-0002');
  rr := t_rr(r); res := (r ->> 'reservation_id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform check_in(rr);
  perform t_sys();
  -- shift the whole stay two days back so today is the departure day
  update room_inventory_claims set start_date = start_date - 2, end_date = end_date - 2 where reservation_room_id = rr;
  update reservation_nights set night_date = night_date - 2 where reservation_room_id = rr;
  update reservations set arrival_date = arrival_date - 2, departure_date = departure_date - 2 where id = res;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := check_out(rr);
  if (r ->> 'early_departure')::boolean then raise exception 'FAIL departure-day check-out treated as early'; end if;
  perform t_sys();
  if (select count(*) from room_inventory_claims where reservation_room_id = rr and status = 'active') <> 1
    then raise exception 'FAIL claims changed on normal check-out'; end if;
  raise notice 'PASS check-out on departure day';
end $$;

-- 4. Transfers
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2');
  fx uuid; rr uuid; r jsonb; old_room uuid; room105 uuid; room104 uuid; blocker uuid; x jsonb;
begin
  select id into room105 from rooms where room_number = '105' and property_id = '00000000-0000-0000-0000-0000000000a2';
  select id into room104 from rooms where room_number = '104' and property_id = '00000000-0000-0000-0000-0000000000a2';
  rr := t_rr(t_book('00000000-0000-0000-0000-0000000000a3', t + 10, t + 14, 'ops-tr-0001'));
  select room_id into old_room from room_inventory_claims where reservation_room_id = rr and status = 'active';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := transfer_room(rr, room105, t + 12, 'guest asked for a quieter room', 'ops-tr-key-1');
  if r ->> 'to_room_id' <> room105::text then raise exception 'FAIL transfer target %', r; end if;
  if transfer_room(rr, room105, t + 12, 'guest asked for a quieter room', 'ops-tr-key-1') <> r then raise exception 'FAIL transfer not idempotent'; end if;
  perform t_sys();
  if (select count(*) from room_inventory_claims where reservation_room_id = rr and status = 'active') <> 2
     or not exists (select 1 from room_inventory_claims where reservation_room_id = rr and status = 'active' and room_id = old_room and end_date = t + 12)
     or not exists (select 1 from room_inventory_claims where reservation_room_id = rr and status = 'active' and room_id = room105 and start_date = t + 12 and end_date = t + 14)
    then raise exception 'FAIL transfer claims'; end if;

  -- target taken: nothing changes
  blocker := t_rr(t_book('00000000-0000-0000-0000-0000000000a3', t + 12, t + 14, 'ops-tr-0002', room104));
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select transfer_room(%L, %L, %L, %L, %L)', rr, room104, t + 13, 'try', 'ops-tr-key-2'), 'ROOM_UNAVAILABLE');
  perform t_expect(format('select transfer_room(%L, %L, %L, %L, %L)', rr, room104, t + 12, 'try', 'ops-tr-key-3'), 'ROOM_UNAVAILABLE');
  perform t_sys();
  if (select count(*) from room_inventory_claims where reservation_room_id = rr and status = 'active') <> 2
     or not exists (select 1 from room_inventory_claims where reservation_room_id = rr and status = 'active' and room_id = room105 and end_date = t + 14)
    then raise exception 'FAIL failed transfer changed claims'; end if;

  -- validation and permissions
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select transfer_room(%L, null, %L, %L, %L)', rr, t + 20, 'x', 'ops-tr-key-4'), 'POLICY_VIOLATION');
  perform t_expect(format('select transfer_room(%L, null, %L, %L, %L)', rr, t - 1, 'x', 'ops-tr-key-5'), 'POLICY_VIOLATION');
  perform t_expect(format('select transfer_room(%L, null, %L, %L, %L)', rr, t + 13, '', 'ops-tr-key-6'), 'POLICY_VIOLATION');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select transfer_room(%L, null, %L, %L, %L)', rr, t + 13, 'x', 'ops-tr-key-7'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select transfer_room(%L, null, %L, %L, %L)', rr, t + 13, 'x', 'ops-tr-key-8'), 'NOT_FOUND');
  perform t_sys();

  -- effective on the arrival day with automatic target releases the old claim entirely
  fx := t_rr(t_book('00000000-0000-0000-0000-0000000000a3', t + 30, t + 32, 'ops-tr-0003'));
  select room_id into old_room from room_inventory_claims where reservation_room_id = fx and status = 'active';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  x := transfer_room(fx, null, t + 30, 'room maintenance', 'ops-tr-key-9');
  perform t_sys();
  if x ->> 'to_room_id' = old_room::text or (select count(*) from room_inventory_claims where reservation_room_id = fx and status = 'active') <> 1
    then raise exception 'FAIL auto transfer %', x; end if;
  raise notice 'PASS transfers: split stay, idempotency, conflicts leave state intact, validation, permissions, auto target';
end $$;

-- 5. Room blocks
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2');
  solo uuid; r103 uuid; rr uuid; res uuid; r jsonb; before_claims int; blk uuid;
begin
  select id into solo from rooms where room_number = '201' and property_id = '00000000-0000-0000-0000-0000000000a2';
  select id into r103 from rooms where room_number = '103' and property_id = '00000000-0000-0000-0000-0000000000a2';
  rr := t_rr(t_book('00000000-0000-0000-0000-0000000000a4', t + 40, t + 43, 'ops-bl-0001'));
  select count(*) into before_claims from room_inventory_claims;

  perform t_as('00000000-0000-0000-0000-00000000aa01');   -- owner
  r := create_room_block(solo, t + 41, t + 42, 'repairs', 'fail', 'ops-bl-key-1');
  if (r ->> 'created')::boolean or jsonb_array_length(r -> 'conflicts') <> 1 then raise exception 'FAIL block conflict report %', r; end if;
  perform t_expect(format('select create_room_block(%L, %L, %L, %L, %L, %L)', solo, t + 41, t + 42, 'repairs', 'move', 'ops-bl-key-2'), 'ROOM_UNAVAILABLE');
  perform t_sys();
  if (select count(*) from room_inventory_claims) <> before_claims then raise exception 'FAIL block attempts changed claims'; end if;

  -- a stay that can move: specific room 103, block overlaps its middle
  rr := t_rr(t_book('00000000-0000-0000-0000-0000000000a3', t + 50, t + 53, 'ops-bl-0002', r103));
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := create_room_block(r103, t + 51, t + 52, 'plumbing', 'move', 'ops-bl-key-3');
  if not (r ->> 'created')::boolean or jsonb_array_length(r -> 'moved') <> 1 then raise exception 'FAIL block with move %', r; end if;
  blk := (r ->> 'block_id')::uuid;
  if create_room_block(r103, t + 51, t + 52, 'plumbing', 'move', 'ops-bl-key-3') <> r then raise exception 'FAIL block not idempotent'; end if;
  perform t_sys();
  if not exists (select 1 from room_inventory_claims where id = blk and claim_type = 'block' and room_id = r103 and status = 'active')
     or exists (select 1 from room_inventory_claims where reservation_room_id = rr and status = 'active' and room_id = r103 and end_date > t + 51)
    then raise exception 'FAIL block or move state'; end if;

  -- permissions and validation
  perform t_as('00000000-0000-0000-0000-00000000aa04');   -- front desk lacks room.block
  perform t_expect(format('select create_room_block(%L, %L, %L, %L, %L, %L)', r103, t + 60, t + 61, 'x', 'fail', 'ops-bl-key-4'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select create_room_block(%L, %L, %L, %L, %L, %L)', r103, t - 2, t + 1, 'x', 'fail', 'ops-bl-key-5'), 'POLICY_VIOLATION');
  perform t_expect(format('select create_room_block(%L, %L, %L, %L, %L, %L)', r103, t + 61, t + 60, 'x', 'fail', 'ops-bl-key-6'), 'POLICY_VIOLATION');
  -- release, then the dates can be booked
  perform release_room_block(blk);
  perform t_sys();
  perform t_book('00000000-0000-0000-0000-0000000000a3', t + 51, t + 52, 'ops-bl-0003', r103);
  raise notice 'PASS blocks: conflicts reported, move is all-or-nothing, idempotent, permissions, release';
end $$;

-- 6. Cancellation charges, state rules and permissions
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2');
  far jsonb; near jsonb; r jsonb; ci jsonb; expected bigint; res uuid; rr uuid;
begin
  far := t_book('00000000-0000-0000-0000-0000000000a3', t + 70, t + 72, 'ops-ca-0001');
  near := t_book('00000000-0000-0000-0000-0000000000a3', t + 1, t + 3, 'ops-ca-0002');
  perform t_as('00000000-0000-0000-0000-00000000aa04');   -- front desk has no reservation.cancel
  perform t_expect(format('select cancel_reservation(%L, %L, %L)', far ->> 'reservation_id', 'x', 'ops-ca-key-0'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select cancel_reservation(%L, %L, %L)', far ->> 'reservation_id', 'x', 'ops-ca-key-0b'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');   -- owner
  r := cancel_reservation((far ->> 'reservation_id')::uuid, 'guest changed plans', 'ops-ca-key-1');
  if (r ->> 'cancellation_charge_minor')::bigint <> 0 then raise exception 'FAIL early cancellation charged %', r; end if;
  if cancel_reservation((far ->> 'reservation_id')::uuid, 'guest changed plans', 'ops-ca-key-1') <> r then raise exception 'FAIL cancel not idempotent'; end if;
  perform t_expect(format('select cancel_reservation(%L, %L, %L)', far ->> 'reservation_id', 'again', 'ops-ca-key-1b'), 'INVALID_STATE');
  perform t_expect(format('select cancel_reservation(%L, %L, %L)', far ->> 'reservation_id', 'different reason', 'ops-ca-key-1'), 'IDEMPOTENCY_MISMATCH');

  perform t_sys();
  select coalesce(sum(n.rate_minor + n.tax_minor), 0) into expected from reservation_nights n
    where n.reservation_room_id = t_rr(near) and n.night_date = t + 1;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := cancel_reservation((near ->> 'reservation_id')::uuid, 'late cancellation', 'ops-ca-key-2');
  if (r ->> 'cancellation_charge_minor')::bigint <> expected or expected = 0 then raise exception 'FAIL late charge % vs expected %', r, expected; end if;
  perform t_sys();
  if exists (select 1 from room_inventory_claims where reservation_room_id = t_rr(near) and status = 'active')
    then raise exception 'FAIL cancelled reservation still holds inventory'; end if;
  if (select count(*) from audit_logs where action = 'reservation.cancelled') <> 2 then raise exception 'FAIL cancel audit rows'; end if;

  -- a checked-in reservation cannot be cancelled
  ci := t_book('00000000-0000-0000-0000-0000000000a3', t, t + 1, 'ops-ca-0003');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform check_in(t_rr(ci), 'override for test');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select cancel_reservation(%L, %L, %L)', ci ->> 'reservation_id', 'too late', 'ops-ca-key-3'), 'INVALID_STATE');
  perform t_sys();
  raise notice 'PASS cancellation: charge rules, idempotency, state, permissions, inventory released';
end $$;
