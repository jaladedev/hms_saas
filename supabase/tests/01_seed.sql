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

-- Helper for concurrency tests: returns true on success, false on ROOM_UNAVAILABLE.
create table test_results (id bigserial primary key, label text, ok boolean);
create function test_try_claim(p_label text, p_property uuid, p_type uuid, p_start date, p_end date)
returns boolean language plpgsql as $$
declare ok boolean := true;
begin
  perform claim_room(p_property, p_type, null, p_start, p_end, 'stay', gen_random_uuid());
  insert into test_results (label, ok) values (p_label, true);
  return true;
exception when sqlstate 'P0001' then
  insert into test_results (label, ok) values (p_label, false);
  return false;
end $$;
