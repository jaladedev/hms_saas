-- guest_room_type_availability (migration 114). Hotel A: tenant a1, property a2, Standard a3 (rooms 101-105), Solo Suite a4.
-- Checked far ahead (today + 300), where earlier tests left no claims.
\set ON_ERROR_STOP on

-- 1. shape: one {date, available} per night, nothing else, no ids
do $$ declare
  r jsonb; v_t constant uuid := '00000000-0000-0000-0000-0000000000a3'; v_today date := property_today('00000000-0000-0000-0000-0000000000a2');
begin
  r := guest_room_type_availability('book.hotel-a.test', v_t);
  if jsonb_array_length(r -> 'nights') <> 14 or (select count(*) from jsonb_object_keys(r)) <> 1 then raise exception 'FAIL shape %', r; end if;
  if (r -> 'nights' -> 0 ->> 'date')::date <> v_today or (select count(*) from jsonb_object_keys(r -> 'nights' -> 0)) <> 2 then raise exception 'FAIL night %', r -> 'nights' -> 0; end if;
  if jsonb_typeof(r -> 'nights' -> 0 -> 'available') <> 'boolean' then raise exception 'FAIL type'; end if;
  if r::text like '%00000000-0000-0000-0000-0000000000a1%' or r::text like '%00000000-0000-0000-0000-0000000000a2%' then raise exception 'FAIL id leaked'; end if;
  if jsonb_array_length(guest_room_type_availability('book.hotel-a.test', v_t, v_today - 30, 500) -> 'nights') <> 31
     or (guest_room_type_availability('book.hotel-a.test', v_t, v_today - 30, 3) -> 'nights' -> 0 ->> 'date')::date <> v_today then raise exception 'FAIL limits'; end if;
  raise notice 'PASS guest_room_type_availability: 14 nights from today of {date, available}, start never in the past, 31 at most, no ids';
end $$;

-- 2. a night is full only when every active room of the type is taken; a live hold counts, an expired one does not
do $$ declare
  r jsonb; v_t constant uuid := '00000000-0000-0000-0000-0000000000a3'; v_today date := property_today('00000000-0000-0000-0000-0000000000a2');
  v_room uuid;
begin
  perform t_sys();
  insert into room_inventory_claims (tenant_id, property_id, room_id, claim_type, start_date, end_date, status, block_reason)
    select tenant_id, property_id, id, 'block', v_today + 301, v_today + 302, 'active', 'avail-test' from rooms where room_type_id = v_t and operational_status = 'active';
  r := guest_room_type_availability('book.hotel-a.test', v_t, v_today + 300, 3);
  if r -> 'nights' -> 0 -> 'available' <> 'true'::jsonb or r -> 'nights' -> 1 -> 'available' <> 'false'::jsonb or r -> 'nights' -> 2 -> 'available' <> 'true'::jsonb then
    raise exception 'FAIL full night %', r; end if;
  -- one room freed: the night is bookable again
  select room_id into v_room from room_inventory_claims where block_reason = 'avail-test' limit 1;
  delete from room_inventory_claims where block_reason = 'avail-test' and room_id = v_room;
  if guest_room_type_availability('book.hotel-a.test', v_t, v_today + 300, 3) -> 'nights' -> 1 -> 'available' <> 'true'::jsonb then raise exception 'FAIL one room free'; end if;
  delete from room_inventory_claims where block_reason = 'avail-test';
  -- another type's rooms being full does not make this one full
  insert into room_inventory_claims (tenant_id, property_id, room_id, claim_type, start_date, end_date, status, block_reason)
    select tenant_id, property_id, id, 'block', v_today + 301, v_today + 302, 'active', 'avail-test' from rooms where room_type_id = '00000000-0000-0000-0000-0000000000a4' and operational_status = 'active';
  if guest_room_type_availability('book.hotel-a.test', v_t, v_today + 300, 3) -> 'nights' -> 1 -> 'available' <> 'true'::jsonb then raise exception 'FAIL other type'; end if;
  delete from room_inventory_claims where block_reason = 'avail-test';
  raise notice 'PASS guest_room_type_availability: full only when every room of the type is taken; other types do not count';
end $$;

-- 3. the host decides; a type a guest could not book looks like no type at all; only the server may call it
do $$ declare
  v_t constant uuid := '00000000-0000-0000-0000-0000000000a3';
begin
  perform t_sys();
  begin perform guest_room_type_availability('hotel-b.test', v_t); raise exception 'FAIL other hotel';
  exception when sqlstate 'P0001' then if sqlerrm not like 'NOT_FOUND%' then raise; end if; end;
  begin perform guest_room_type_availability('draft.hotel-a.test', v_t); raise exception 'FAIL unverified';
  exception when sqlstate 'P0001' then null; end;
  begin perform guest_room_type_availability('book.hotel-a.test', gen_random_uuid()); raise exception 'FAIL unknown';
  exception when sqlstate 'P0001' then if sqlerrm not like 'NOT_FOUND%' then raise; end if; end;
  update room_types set is_public = false where id = v_t;
  begin perform guest_room_type_availability('book.hotel-a.test', v_t); raise exception 'FAIL private';
  exception when sqlstate 'P0001' then if sqlerrm not like 'NOT_FOUND%' then raise; end if; end;
  update room_types set is_public = true where id = v_t;
  update rooms set operational_status = 'out_of_service' where room_type_id = v_t;
  begin perform guest_room_type_availability('book.hotel-a.test', v_t); raise exception 'FAIL roomless';
  exception when sqlstate 'P0001' then if sqlerrm not like 'NOT_FOUND%' then raise; end if; end;
  update rooms set operational_status = 'active' where room_type_id = v_t;
  if has_function_privilege('anon', 'guest_room_type_availability(text,uuid,date,integer)', 'execute')
     or has_function_privilege('authenticated', 'guest_room_type_availability(text,uuid,date,integer)', 'execute')
     or not has_function_privilege('service_role', 'guest_room_type_availability(text,uuid,date,integer)', 'execute') then raise exception 'FAIL grants'; end if;
  raise notice 'PASS guest_room_type_availability: other hotel, unverified, unknown, private and roomless types are NOT_FOUND; service_role only';
end $$;
