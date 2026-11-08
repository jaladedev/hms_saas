-- Blocking a room with bookings: the 'cancel' resolution (migration 068). Rooms T69-1..5 of type a3.
-- They are retired at the end, so the room-count races see no extras. Reuses t_as / t_sys / t_expect / t_book / t_rr (05).
\set ON_ERROR_STOP on

do $$ declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2'; tenant uuid := '00000000-0000-0000-0000-0000000000a1'; t date;
  owner text := '00000000-0000-0000-0000-00000000aa01'; hk text := '00000000-0000-0000-0000-00000000aa02';
  fd text := '00000000-0000-0000-0000-00000000aa04'; ob text := '00000000-0000-0000-0000-00000000bb01';
  rooms_ uuid[]; r jsonb; res1 uuid; res2 uuid; res3 uuid; rr3 uuid; pay uuid; n integer; blk uuid;
begin
  perform t_sys();
  t := property_today(prop);
  insert into rooms (tenant_id, property_id, room_type_id, room_number, floor)
    select tenant_id, id, '00000000-0000-0000-0000-0000000000a3', 'T69-' || g, 9 from properties, generate_series(1, 5) g where id = prop;
  select array_agg(id order by room_number) into rooms_ from rooms where property_id = prop and room_number like 'T69-%';
  update rooms set housekeeping_status = 'clean' where id = any (rooms_);

  -- A. two bookings on room 1 overlap the block; one has money paid
  perform t_as(owner);
  r := t_book('00000000-0000-0000-0000-0000000000a3', t + 20, t + 23, 't69-a1', rooms_[1]); res1 := (r ->> 'reservation_id')::uuid;
  r := t_book('00000000-0000-0000-0000-0000000000a3', t + 25, t + 27, 't69-a2', rooms_[1]); res2 := (r ->> 'reservation_id')::uuid;
  perform t_sys();
  insert into payments (tenant_id, property_id, reservation_id, payment_provider, payment_method, provider_reference, internal_reference, amount_minor, currency)
    select tenant, prop, res1, 'paystack', 'card', 't69-ref', 't69-int', 5000, currency from reservations where id = res1 returning id into pay;

  -- 'fail' still only reports; unknown resolutions are refused; people without the right see nothing
  perform t_as(owner);
  r := create_room_block(rooms_[1], t + 21, t + 26, 'repairs', 'fail', 't69-fail');
  if (r ->> 'created')::boolean or jsonb_array_length(r -> 'conflicts') <> 2 then raise exception 'FAIL fail resolution: %', r; end if;
  perform t_expect(format('select create_room_block(%L, %L, %L, %L, %L, %L)', rooms_[1], t + 21, t + 26, 'x', 'delete', 't69-bad'), 'POLICY_VIOLATION');
  perform t_as(hk);
  perform t_expect(format('select create_room_block(%L, %L, %L, %L, %L, %L)', rooms_[1], t + 21, t + 26, 'x', 'cancel', 't69-hk'), 'NOT_FOUND');
  perform t_as(fd);
  perform t_expect(format('select create_room_block(%L, %L, %L, %L, %L, %L)', rooms_[1], t + 21, t + 26, 'x', 'cancel', 't69-fd'), 'NOT_FOUND');
  perform t_as(ob);
  perform t_expect(format('select create_room_block(%L, %L, %L, %L, %L, %L)', rooms_[1], t + 21, t + 26, 'x', 'cancel', 't69-ob'), 'NOT_FOUND');
  perform t_sys();
  if (select count(*) from reservations where id in (res1, res2) and reservation_status = 'cancelled') <> 0 then raise exception 'FAIL a refused request cancelled something'; end if;

  -- B. cancel: both bookings go, no charge, one refund request for the money paid, the block exists
  perform t_as(owner);
  r := create_room_block(rooms_[1], t + 21, t + 26, 'repairs', 'cancel', 't69-cancel');
  if not (r ->> 'created')::boolean or jsonb_array_length(r -> 'cancelled') <> 2 or jsonb_array_length(r -> 'moved') <> 0 then raise exception 'FAIL cancel result: %', r; end if;
  blk := (r ->> 'block_id')::uuid;
  perform t_sys();
  if (select count(*) from reservations where id in (res1, res2) and reservation_status = 'cancelled' and cancellation_charge_minor = 0
        and cancel_reason = 'Room blocked by the hotel: repairs') <> 2 then raise exception 'FAIL cancelled state, charge or reason'; end if;
  if exists (select 1 from room_inventory_claims where room_id = rooms_[1] and claim_type in ('stay','hold') and status = 'active' and start_date < t + 26 and end_date > t + 21) then
    raise exception 'FAIL a stay claim survived'; end if;
  if not exists (select 1 from room_inventory_claims where id = blk and claim_type = 'block' and status = 'active') then raise exception 'FAIL block missing'; end if;
  if (select count(*) from refunds where reservation_id = res1 and amount_minor = 5000 and refund_status = 'requested') <> 1 then raise exception 'FAIL refund request for money paid'; end if;
  if exists (select 1 from refunds where reservation_id = res2) then raise exception 'FAIL refund for an unpaid booking'; end if;
  if (select count(*) from audit_logs where action = 'reservation.cancelled' and entity_id in (res1, res2) and (metadata ->> 'charge_waived')::boolean) <> 2 then raise exception 'FAIL audit of waived cancellations'; end if;
  if (select (metadata ->> 'cancelled')::int from audit_logs where action = 'room.blocked' and entity_id = rooms_[1] order by created_at desc limit 1) <> 2 then raise exception 'FAIL room.blocked audit'; end if;

  -- C. the same key again changes nothing
  perform t_as(owner);
  r := create_room_block(rooms_[1], t + 21, t + 26, 'repairs', 'cancel', 't69-cancel');
  perform t_sys();
  if (select count(*) from room_inventory_claims where room_id = rooms_[1] and claim_type = 'block' and status = 'active') <> 1 then raise exception 'FAIL replay made a second block'; end if;

  -- D. an existing block in the way still stops 'cancel', and nothing is cancelled
  perform t_as(owner);
  r := t_book('00000000-0000-0000-0000-0000000000a3', t + 30, t + 32, 't69-d1', rooms_[2]); res3 := (r ->> 'reservation_id')::uuid;
  perform create_room_block(rooms_[2], t + 33, t + 36, 'first block', 'fail', 't69-d-blk');
  r := create_room_block(rooms_[2], t + 31, t + 35, 'second block', 'cancel', 't69-d2');
  if (r ->> 'created')::boolean then raise exception 'FAIL block over a block was created'; end if;
  perform t_sys();
  if (select reservation_status from reservations where id = res3) = 'cancelled' then raise exception 'FAIL cancelled although a block stopped it'; end if;

  -- E. a guest in the house is never cancelled: nothing changes, and the result says why
  perform t_as(owner);
  r := t_book('00000000-0000-0000-0000-0000000000a3', t, t + 3, 't69-e1', rooms_[3]); rr3 := t_rr(r);
  perform check_in(rr3, null);
  r := create_room_block(rooms_[3], t + 1, t + 2, 'inspection', 'cancel', 't69-e2');
  if (r ->> 'created')::boolean or not coalesce((r ->> 'in_house')::boolean, false) then raise exception 'FAIL in-house guest result: %', r; end if;
  perform t_sys();
  if (select room_status from reservation_rooms where id = rr3) <> 'checked_in' then raise exception 'FAIL in-house guest touched'; end if;

  -- F. a multi-night overlap of a booking that only partly overlaps cancels the whole booking
  perform t_as(owner);
  r := t_book('00000000-0000-0000-0000-0000000000a3', t + 40, t + 45, 't69-f1', rooms_[4]); res3 := (r ->> 'reservation_id')::uuid;
  r := create_room_block(rooms_[4], t + 44, t + 46, 'deep clean', 'cancel', 't69-f2');
  perform t_sys();
  if not (r ->> 'created')::boolean or (select reservation_status from reservations where id = res3) <> 'cancelled' then raise exception 'FAIL partial overlap: %', r; end if;

  -- G. 'move' still works as before and reports no cancellations
  perform t_as(owner);
  r := t_book('00000000-0000-0000-0000-0000000000a3', t + 50, t + 52, 't69-g1', rooms_[5]); res3 := (r ->> 'reservation_id')::uuid;
  r := create_room_block(rooms_[5], t + 50, t + 52, 'move test', 'move', 't69-g2');
  perform t_sys();
  if not (r ->> 'created')::boolean or jsonb_array_length(r -> 'moved') <> 1 or jsonb_array_length(r -> 'cancelled') <> 0
     or (select reservation_status from reservations where id = res3) = 'cancelled' then raise exception 'FAIL move resolution: %', r; end if;

  update rooms set operational_status = 'retired' where id = any (rooms_);
  raise notice 'PASS test 69: block cancel-resolution';
end $$;
