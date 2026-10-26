-- Fixtures shared by the tests: two tenants, one property each, rooms for claims tests.
insert into tenants (id, name, slug) values
  ('00000000-0000-0000-0000-0000000000a1', 'Hotel A', 'hotel-a'),
  ('00000000-0000-0000-0000-0000000000b1', 'Hotel B', 'hotel-b');
insert into properties (id, tenant_id, name, code) values
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a1', 'Hotel A Ibadan', 'HA'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000b1', 'Hotel B Ibadan', 'HB');

-- Property A: type STD with 5 rooms, type SOLO with 1 room
insert into room_types (id, tenant_id, property_id, name, code, slug, max_adults, max_occupancy, base_rate_minor) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'Standard', 'STD', 'standard', 2, 2, 2500000),
  ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'Solo Suite', 'SOLO', 'solo-suite', 2, 2, 9000000);
insert into rooms (tenant_id, property_id, room_type_id, room_number, floor)
select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
       '00000000-0000-0000-0000-0000000000a3', (100 + g)::text, 1 from generate_series(1,5) g;
insert into rooms (tenant_id, property_id, room_type_id, room_number, floor)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2',
        '00000000-0000-0000-0000-0000000000a4', '201', 2);

-- Property B: one standard room (for cross-tenant checks)
insert into room_types (id, tenant_id, property_id, name, code, slug, max_adults, max_occupancy, base_rate_minor) values
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2', 'Standard', 'STD', 'standard', 2, 2, 2000000);
insert into rooms (tenant_id, property_id, room_type_id, room_number)
values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2',
        '00000000-0000-0000-0000-0000000000b3', '101');

-- Default rate plans and guests
insert into rate_plans (id, tenant_id, property_id, name, code, is_default) values
  ('00000000-0000-0000-0000-0000000000a6', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'Standard Rate', 'STD-RATE', true),
  ('00000000-0000-0000-0000-0000000000b6', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2', 'Standard Rate', 'STD-RATE', true);
insert into guests (id, tenant_id, full_name, phone) values
  ('00000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-0000000000a1', 'Ada Okafor', '+2348000000001'),
  ('00000000-0000-0000-0000-0000000000b5', '00000000-0000-0000-0000-0000000000b1', 'Bola Adeyemi', '+2348000000002');

-- Helpers. test_rr creates a guest, reservation and reservation room so claims have a real owner.
create function test_rr(p_property uuid, p_type uuid, p_start date, p_end date)
returns uuid language plpgsql as $$
declare v_tenant uuid; v_guest uuid := gen_random_uuid(); v_res uuid := gen_random_uuid(); v_rr uuid := gen_random_uuid();
begin
  select tenant_id into v_tenant from properties where id = p_property;
  insert into guests (id, tenant_id, full_name) values (v_guest, v_tenant, 'Test Guest');
  insert into reservations (id, tenant_id, property_id, booking_reference, primary_guest_id, source,
                            reservation_status, arrival_date, departure_date)
  values (v_res, v_tenant, p_property, upper(substr(replace(gen_random_uuid()::text,'-',''),1,10)),
          v_guest, 'staff_entry', 'pending', p_start, p_end);
  insert into reservation_rooms (id, tenant_id, property_id, reservation_id, room_type_id, rate_plan_id, adults)
  values (v_rr, v_tenant, p_property, v_res, p_type,
          (select id from rate_plans where property_id = p_property and is_default), 1);
  return v_rr;
end $$;

create table test_results (id bigserial primary key, label text, ok boolean);
grant usage on all sequences in schema public to authenticated;

-- Direct claim race helper: true on success, false on ROOM_UNAVAILABLE. The reservation is
-- created inside the same sub-transaction, so a lost race leaves nothing behind.
create function test_try_claim(p_label text, p_property uuid, p_type uuid, p_start date, p_end date)
returns boolean language plpgsql as $$
begin
  begin
    perform claim_room(p_property, p_type, null, p_start, p_end, 'stay', test_rr(p_property, p_type, p_start, p_end));
  exception when sqlstate 'P0001' then
    insert into test_results (label, ok) values (p_label, false);
    return false;
  end;
  insert into test_results (label, ok) values (p_label, true);
  return true;
end $$;

-- Full-path race helper: calls create_reservation, retrying on deadlock as the caller should.
create function test_try_reserve(p_label text, p_property uuid, p_guest uuid, p_arrival date, p_departure date, p_rooms jsonb)
returns boolean language plpgsql as $$
declare attempt int := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      perform create_reservation(p_property, p_guest, 'staff_entry', p_arrival, p_departure, p_rooms,
                                 gen_random_uuid()::text);
      insert into test_results (label, ok) values (p_label, true);
      return true;
    exception
      when deadlock_detected or serialization_failure then
        if attempt >= 3 then raise; end if;
      when sqlstate 'P0001' then
        if sqlerrm like 'ROOM_UNAVAILABLE%' then
          insert into test_results (label, ok) values (p_label, false);
          return false;
        end if;
        raise;
    end;
  end loop;
end $$;
