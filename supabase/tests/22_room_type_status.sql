-- Switching a room type off and on, and hiding it from the website (the "Switch off" button and the "Guests can
-- book online" box on /app/settings/rooms). No migration is involved: these are plain updates, so this proves the
-- booking functions already honour room_types.status and is_public.
-- Uses its own room type and room, so no other test's dates or rooms are involved. Reuses t_book (05) and t06_hold /
-- t06_expect_err (06).
\set ON_ERROR_STOP on

create function t22_rooms(p_type uuid) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('room_type_id', p_type, 'adults', 1))
$$;
create function t22_guest() returns jsonb language sql as $$
  select '{"full_name":"Switch Guest","email":"t22-switch@example.com"}'::jsonb
$$;

do $$ declare v_type uuid; v_res uuid; r jsonb; begin
  insert into room_types (tenant_id, property_id, name, code, slug, max_adults, max_children, max_occupancy, base_rate_minor, is_public)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'Switch Test', 'T22', 'switch-test', 2, 0, 2, 100000, true)
  returning id into v_type;
  insert into rooms (tenant_id, property_id, room_type_id, room_number)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', v_type, 'T22-1');

  -- 1. On: staff can book it
  r := t_book(v_type, current_date + 40, current_date + 42, 't22-on');
  v_res := (r ->> 'reservation_id')::uuid;
  if v_res is null then raise exception 'FAIL staff booking of an active type %', r; end if;

  -- 2. Off: no new bookings, by staff or on the website
  update room_types set status = 'inactive' where id = v_type;
  perform t06_expect_err(format('select t_book(%L, current_date + 60, current_date + 62, ''t22-off'')', v_type), 'NOT_FOUND: room type%');
  perform t06_expect_err(format('select t06_hold(p_off => 60, p_nights => 2, p_rooms => %L::jsonb, p_guest => %L::jsonb)', t22_rooms(v_type), t22_guest()),
                         'NOT_FOUND: room type%');
  if (select reservation_status from reservations where id = v_res) in ('cancelled', 'expired', 'no_show')
     or (select count(*) from room_inventory_claims where status = 'active' and reservation_room_id in (select id from reservation_rooms where reservation_id = v_res)) <> 1
    then raise exception 'FAIL switching a type off disturbed an existing booking'; end if;
  if (select operational_status from rooms where room_type_id = v_type) <> 'active' then raise exception 'FAIL switching a type off changed its rooms'; end if;

  -- 3. On again: bookable again, by staff and online
  update room_types set status = 'active' where id = v_type;
  r := t_book(v_type, current_date + 60, current_date + 62, 't22-back');
  if (r ->> 'reservation_id') is null then raise exception 'FAIL staff booking after switching back on'; end if;
  r := t06_hold(p_off => 80, p_nights => 2, p_rooms => t22_rooms(v_type), p_guest => t22_guest());
  if (r ->> 'reservation_id') is null then raise exception 'FAIL online hold after switching back on %', r; end if;
  raise notice 'PASS a switched-off room type takes no new bookings, leaves existing ones alone, and works again when switched on';

  -- 4. Staff only: hidden from the website, still bookable by staff
  update room_types set is_public = false where id = v_type;
  perform t06_expect_err(format('select t06_hold(p_off => 100, p_nights => 2, p_rooms => %L::jsonb, p_guest => %L::jsonb)', t22_rooms(v_type), t22_guest()),
                         'NOT_FOUND: room type%');
  r := t_book(v_type, current_date + 100, current_date + 102, 't22-staff-only');
  if (r ->> 'reservation_id') is null then raise exception 'FAIL staff booking of a staff-only type'; end if;
  raise notice 'PASS a staff-only room type is refused online but staff can still book it';
end $$;
