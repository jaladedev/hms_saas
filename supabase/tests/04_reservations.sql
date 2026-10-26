-- create_reservation: pricing, tax, multi-room, all-or-nothing, idempotency, permissions,
-- online holds, tiling, audit. Requires the users created in 03_security.sql:
--   aa01 owner of Hotel A, aa02 housekeeping at A, bb01 owner of Hotel B, aa03 revoked at A.
-- Ids: a2 property A, a3 STD type (5 rooms, base 2,500,000), a4 SOLO type, a5 guest A, a6 default plan.
\set ON_ERROR_STOP on

-- Fixtures (superuser): 7.5% tax rule, a 3,000,000 rate for one night, a zero-rate type with a room
insert into tax_rules (tenant_id, property_id, name, basis, rate_value, effective_from)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'Test VAT', 'percent', 7.5, '2027-01-01');
insert into daily_rates (tenant_id, property_id, room_type_id, rate_plan_id, business_date, amount_minor)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
        '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a6', '2027-12-02', 3000000);
insert into room_types (id, tenant_id, property_id, name, code, slug, max_adults, max_occupancy, base_rate_minor)
values ('00000000-0000-0000-0000-0000000000a7', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'Unpriced', 'FREE', 'unpriced', 2, 2, 0);
insert into rooms (tenant_id, property_id, room_type_id, room_number)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a7', '301');

-- Tax rounding: 1,234,567 x 7.5% = 92,592.525 rounds half up to 92,593
do $$ begin
  if calc_night_tax('00000000-0000-0000-0000-0000000000a2', '2027-12-01', 1234567) <> 92593 then
    raise exception 'FAIL tax rounding got %', calc_night_tax('00000000-0000-0000-0000-0000000000a2', '2027-12-01', 1234567);
  end if;
  if calc_night_tax('00000000-0000-0000-0000-0000000000a2', '2026-12-01', 1000000) <> 0 then
    raise exception 'FAIL tax applied before effective date';
  end if;
  raise notice 'PASS tax rounding and effective dates';
end $$;

-- 1. Staff single-room booking: totals, sources, claim, audit
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ declare r jsonb; v_res uuid; begin
  r := create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'staff_entry',
        '2027-12-01', '2027-12-04',
        '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":2,"children":0}]'::jsonb, 'key-single-0001');
  v_res := (r ->> 'reservation_id')::uuid;
  if (r ->> 'subtotal_minor')::bigint <> 8000000 or (r ->> 'tax_minor')::bigint <> 600000 or (r ->> 'total_minor')::bigint <> 8600000
    then raise exception 'FAIL totals %', r; end if;
  if r ->> 'status' <> 'confirmed' or (r ->> 'booking_reference') not like 'BK-%' then raise exception 'FAIL status/ref %', r; end if;
  if (select string_agg(rate_source, ',' order by night_date) from reservation_nights n
        join reservation_rooms rr on rr.id = n.reservation_room_id where rr.reservation_id = v_res) <> 'base_rate,daily_rate,base_rate'
    then raise exception 'FAIL rate sources'; end if;
  if (select count(*) from room_inventory_claims c join reservation_rooms rr on rr.id = c.reservation_room_id
       where rr.reservation_id = v_res and c.claim_type = 'stay' and c.status = 'active') <> 1 then raise exception 'FAIL claim'; end if;
  if (select count(*) from audit_logs where entity_id = v_res and action = 'reservation.created') <> 1 then raise exception 'FAIL audit'; end if;
  raise notice 'PASS single-room booking prices, taxes, claims and audits';
end $$;
commit;

-- 2. Idempotency: same key and request returns the stored result; changed request is rejected
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ declare r jsonb; before_count int; begin
  select count(*) into before_count from reservations;
  r := create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'staff_entry',
        '2027-12-01', '2027-12-04',
        '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":2,"children":0}]'::jsonb, 'key-single-0001');
  if (select count(*) from reservations) <> before_count then raise exception 'FAIL retry created a second reservation'; end if;
  if (r ->> 'total_minor')::bigint <> 8600000 then raise exception 'FAIL retry result differs'; end if;
  begin
    perform create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'staff_entry',
        '2027-12-01', '2027-12-05',
        '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":2,"children":0}]'::jsonb, 'key-single-0001');
    raise exception 'FAIL key reuse with different request accepted';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'IDEMPOTENCY_MISMATCH' then raise; end if;
  end;
  raise notice 'PASS idempotent retry and key mismatch';
end $$;
commit;

-- 3. Multi-room booking claims three distinct rooms
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ declare r jsonb; begin
  r := create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'phone',
        '2027-12-10', '2027-12-12',
        '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":2},
          {"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":1},
          {"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":2,"children":0}]'::jsonb, 'key-multi-0001');
  if jsonb_array_length(r -> 'rooms') <> 3 then raise exception 'FAIL room count'; end if;
  if (select count(distinct x ->> 'room_id') from jsonb_array_elements(r -> 'rooms') x) <> 3 then raise exception 'FAIL rooms not distinct'; end if;
  if (r ->> 'subtotal_minor')::bigint <> 15000000 then raise exception 'FAIL multi subtotal %', r ->> 'subtotal_minor'; end if;
  raise notice 'PASS multi-room booking';
end $$;
commit;

-- 4. All-or-nothing: only 2 STD rooms remain for those dates, so 3 rooms books nothing
do $$ declare c_res int; c_claims int; begin
  select count(*) into c_res from reservations;
  select count(*) into c_claims from room_inventory_claims;
  begin
    perform create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'phone',
        '2027-12-10', '2027-12-12',
        '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":2},
          {"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":2},
          {"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":2}]'::jsonb, 'key-multi-0002');
    raise exception 'FAIL oversold multi-room accepted';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'ROOM_UNAVAILABLE' then raise; end if;
  end;
  if (select count(*) from reservations) <> c_res or (select count(*) from room_inventory_claims) <> c_claims
     or exists (select 1 from idempotency_keys where idempotency_key = 'key-multi-0002')
    then raise exception 'FAIL partial state left behind'; end if;
  raise notice 'PASS multi-room is all-or-nothing';
end $$;

-- 5. Specific room: honoured once, then unavailable even though other rooms of the type are free
do $$ declare v_room uuid; begin
  select id into v_room from rooms where property_id = '00000000-0000-0000-0000-0000000000a2' and room_number = '101';
  perform create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'staff_entry',
    '2027-12-20', '2027-12-22',
    jsonb_build_array(jsonb_build_object('room_type_id','00000000-0000-0000-0000-0000000000a3','requested_room_id',v_room,'adults',2)),
    'key-specific-01');
  begin
    perform create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'staff_entry',
      '2027-12-21', '2027-12-23',
      jsonb_build_array(jsonb_build_object('room_type_id','00000000-0000-0000-0000-0000000000a3','requested_room_id',v_room,'adults',2)),
      'key-specific-02');
    raise exception 'FAIL requested room double booked';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'ROOM_UNAVAILABLE' then raise; end if;
  end;
  raise notice 'PASS specific-room booking honoured and protected';
end $$;

-- 6. Validation errors
do $$ declare msg text; begin
  begin
    perform create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'staff_entry', '2028-03-01', '2028-03-03',
      '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":3}]'::jsonb, 'key-cap-000001');
    raise exception 'FAIL capacity';
  exception when sqlstate 'P0001' then if sqlerrm <> 'CAPACITY_EXCEEDED' then raise; end if; end;
  begin
    perform create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'staff_entry', '2028-03-01', '2028-03-03',
      '[{"room_type_id":"00000000-0000-0000-0000-0000000000a7","adults":1}]'::jsonb, 'key-rate-000001');
    raise exception 'FAIL missing rate booked at zero';
  exception when sqlstate 'P0001' then if sqlerrm <> 'RATE_MISSING' then raise; end if; end;
  begin
    perform create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'staff_entry', '2020-01-01', '2020-01-03',
      '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":1}]'::jsonb, 'key-past-000001');
    raise exception 'FAIL past arrival';
  exception when sqlstate 'P0001' then if sqlerrm not like 'POLICY_VIOLATION%' then raise; end if; end;
  begin
    perform create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b5', 'staff_entry', '2028-03-01', '2028-03-03',
      '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":1}]'::jsonb, 'key-guest-00001');
    raise exception 'FAIL guest from another tenant accepted';
  exception when sqlstate 'P0001' then if sqlerrm not like 'NOT_FOUND%' then raise; end if; end;
  raise notice 'PASS capacity, missing rate, past arrival and foreign guest rejected';
end $$;

-- 7. Permissions: housekeeping, other tenant, revoked staff, and website source from a client
do $$ declare u text; begin
  foreach u in array array['00000000-0000-0000-0000-00000000aa02','00000000-0000-0000-0000-00000000bb01','00000000-0000-0000-0000-00000000aa03'] loop
    perform set_config('request.jwt.claim.sub', u, true);
    perform set_config('role', 'authenticated', true);
    begin
      perform create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'staff_entry', '2028-04-01', '2028-04-03',
        '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":1}]'::jsonb, 'key-perm-' || right(u, 4));
      raise exception 'FAIL user % could create a reservation', u;
    exception when sqlstate 'P0001' then if sqlerrm <> 'FORBIDDEN' then raise; end if; end;
  end loop;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000aa01', true);
  begin
    perform create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'website', '2028-04-01', '2028-04-03',
      '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":1}]'::jsonb, 'key-web-000001');
    raise exception 'FAIL staff client created a website booking';
  exception when sqlstate 'P0001' then if sqlerrm <> 'FORBIDDEN' then raise; end if; end;
  perform set_config('role', 'postgres', true);
  raise notice 'PASS housekeeping, other tenant, revoked staff and website-from-client are forbidden';
end $$;

-- 8. Online booking made by the system creates a pending reservation with a timed hold
do $$ declare r jsonb; c record; begin
  r := create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'website', '2028-05-01', '2028-05-03',
    '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":2}]'::jsonb, 'key-online-0001');
  select * into c from room_inventory_claims where id = ((r -> 'rooms' -> 0) ->> 'claim_id')::uuid;
  if r ->> 'status' <> 'pending' or c.claim_type <> 'hold' or c.hold_expires_at < now() + interval '19 minutes'
     or c.hold_expires_at > now() + interval '21 minutes' then raise exception 'FAIL online hold %', r; end if;
  raise notice 'PASS online booking is pending with a 20 minute hold';
end $$;

-- 9. Clients cannot write reservations directly
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ begin
  begin
    insert into reservations (tenant_id, property_id, booking_reference, primary_guest_id, source, arrival_date, departure_date)
    values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'HACK', '00000000-0000-0000-0000-0000000000a5', 'staff_entry', '2028-06-01', '2028-06-02');
    raise exception 'FAIL direct reservation insert allowed';
  exception when insufficient_privilege then raise notice 'PASS direct reservation insert denied'; end;
end $$;
commit;

-- 10. Tiling: shrinking a claim so the stay is no longer fully covered fails the commit check
do $$ begin
  begin
    update room_inventory_claims set end_date = end_date - 1
     where reservation_room_id in (select rr.id from reservation_rooms rr join reservations r on r.id = rr.reservation_id
                                    where r.arrival_date = '2027-12-01' and r.departure_date = '2027-12-04');
    set constraints claims_tiling immediate;
    raise exception 'FAIL partial coverage accepted';
  exception when check_violation then
    if sqlerrm not like 'CLAIM_TILING%' then raise; end if;
    raise notice 'PASS tiling rejects partial coverage';
  end;
end $$;

-- 11. Audit log is append-only
do $$ begin
  begin
    update audit_logs set action = 'tampered';
    raise exception 'FAIL audit log edited';
  exception when check_violation then raise notice 'PASS audit log is append-only'; end;
  begin
    delete from audit_logs;
    raise exception 'FAIL audit log deleted';
  exception when check_violation then null; end;
end $$;
