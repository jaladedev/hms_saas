-- guest_room_types (migration 096). Hosts from 06: book.hotel-a.test (Hotel A: Standard 25,000 and Solo Suite 90,000, both with
-- rooms), hotel-b.test (Hotel B: Standard 20,000), draft.hotel-a.test (not verified).
\set ON_ERROR_STOP on

-- 1. the host's own bookable room types, cheapest first, with exactly the fields the homepage needs. (04 left a type with no rate,
--    "Unpriced", at Hotel A: it can never be booked, so it must not be advertised.)
do $$ declare r jsonb; begin
  r := guest_room_types('book.hotel-a.test');
  if r ->> 'currency' <> 'NGN' or jsonb_array_length(r -> 'room_types') <> 2 then raise exception 'FAIL room types %', r; end if;
  if r -> 'room_types' -> 0 ->> 'name' <> 'Standard' or r -> 'room_types' -> 1 ->> 'name' <> 'Solo Suite' then raise exception 'FAIL order %', r; end if;
  if (r -> 'room_types' -> 0 ->> 'from_rate_minor')::bigint <> 2500000 or (r -> 'room_types' -> 1 ->> 'from_rate_minor')::bigint <> 9000000 then
    raise exception 'FAIL from prices %', r; end if;
  if (select count(*) from jsonb_object_keys(r -> 'room_types' -> 0)) <> 10
     or not ((r -> 'room_types' -> 0) ?& array['room_type_id','name','description','bed_config','amenities','photos','max_adults','max_children','max_occupancy','from_rate_minor']) then
    raise exception 'FAIL keys %', r -> 'room_types' -> 0; end if;
  if r::text like '%00000000-0000-0000-0000-0000000000a1%' or r::text like '%00000000-0000-0000-0000-0000000000a2%' then raise exception 'FAIL tenant or property id leaked'; end if;
  if r -> 'room_types' -> 0 -> 'amenities' <> '[]'::jsonb or r -> 'room_types' -> 0 -> 'photos' <> '[]'::jsonb then raise exception 'FAIL empty lists %', r; end if;
  if r::text like '%Unpriced%' then raise exception 'FAIL a type with no rate was advertised'; end if;
  raise notice 'PASS guest_room_types: the hotel''s two bookable types, cheapest first, from the base rate, a type with no rate left out, no tenant or property id';
end $$;

-- 2. the host decides
do $$ declare r jsonb; begin
  r := guest_room_types('hotel-b.test');
  if jsonb_array_length(r -> 'room_types') <> 1 or r -> 'room_types' -> 0 ->> 'name' <> 'Standard'
     or (r -> 'room_types' -> 0 ->> 'from_rate_minor')::bigint <> 2000000 then raise exception 'FAIL hotel B %', r; end if;
  begin perform guest_room_types('draft.hotel-a.test'); raise exception 'FAIL unverified host';
  exception when sqlstate 'P0001' then null; end;
  begin perform guest_room_types('nowhere.test'); raise exception 'FAIL unknown host';
  exception when sqlstate 'P0001' then null; end;
  begin perform guest_room_types(null); raise exception 'FAIL null host';
  exception when sqlstate 'P0001' then null; end;
  update properties set status = 'inactive' where id = '00000000-0000-0000-0000-0000000000b2';
  begin perform guest_room_types('hotel-b.test'); raise exception 'FAIL inactive property';
  exception when sqlstate 'P0001' then null; end;
  update properties set status = 'active' where id = '00000000-0000-0000-0000-0000000000b2';
  raise notice 'PASS guest_room_types is scoped to the host: other hotel, unverified, unknown and switched-off hotels give nothing of this one';
end $$;

-- 3. a type a guest could not book is not advertised
do $$ declare r jsonb; begin
  update room_types set is_public = false where id = '00000000-0000-0000-0000-0000000000a4';
  r := guest_room_types('book.hotel-a.test');
  if jsonb_array_length(r -> 'room_types') <> 1 or r -> 'room_types' -> 0 ->> 'name' <> 'Standard' then raise exception 'FAIL private type shown %', r; end if;
  update room_types set is_public = true, status = 'inactive' where id = '00000000-0000-0000-0000-0000000000a4';
  if jsonb_array_length(guest_room_types('book.hotel-a.test') -> 'room_types') <> 1 then raise exception 'FAIL inactive type shown'; end if;
  update room_types set status = 'active' where id = '00000000-0000-0000-0000-0000000000a4';
  -- no active room at all
  update rooms set operational_status = 'out_of_service' where room_type_id = '00000000-0000-0000-0000-0000000000a4';
  r := guest_room_types('book.hotel-a.test');
  if jsonb_array_length(r -> 'room_types') <> 1 or r -> 'room_types' -> 0 ->> 'name' <> 'Standard' then raise exception 'FAIL type with no active room shown %', r; end if;
  update rooms set operational_status = 'active' where room_type_id = '00000000-0000-0000-0000-0000000000a4';
  if jsonb_array_length(guest_room_types('book.hotel-a.test') -> 'room_types') <> 2 then raise exception 'FAIL restore'; end if;
  raise notice 'PASS guest_room_types leaves out private, inactive and roomless types';
end $$;

-- 4. amenities and pictures come through, pictures in the hotel's order
do $$ declare
  r jsonb; v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_rt constant uuid := '00000000-0000-0000-0000-0000000000a3';
  p1 text := v_t || '/' || v_p || '/' || v_rt || '/' || gen_random_uuid() || '.png';
  p2 text := v_t || '/' || v_p || '/' || v_rt || '/' || gen_random_uuid() || '.jpg';
begin
  update room_types set amenities = array['Air conditioning', 'Wi-Fi'], description = 'Quiet and bright.' where id = v_rt;
  insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes, caption, sort_order)
  values (v_t, v_p, v_rt, p1, 'image/png', 1000, 'Second', 2), (v_t, v_p, v_rt, p2, 'image/jpeg', 1000, 'First', 1);
  r := guest_room_types('book.hotel-a.test') -> 'room_types' -> 0;
  if r -> 'amenities' <> '["Air conditioning", "Wi-Fi"]'::jsonb or r ->> 'description' <> 'Quiet and bright.' then raise exception 'FAIL amenities %', r; end if;
  if jsonb_array_length(r -> 'photos') <> 2 or r -> 'photos' -> 0 ->> 'path' <> p2 or r -> 'photos' -> 1 ->> 'path' <> p1 or r -> 'photos' -> 0 ->> 'caption' <> 'First' then
    raise exception 'FAIL photos %', r -> 'photos'; end if;
  delete from room_type_photos where room_type_id = v_rt;
  update room_types set amenities = '{}', description = null where id = v_rt;
  raise notice 'PASS guest_room_types carries amenities, description and pictures in the hotel''s order';
end $$;

-- 5. the "from" price is tonight's rate on the default plan: a daily rate wins over the base rate
do $$ declare
  r jsonb; v_today date; v_plan uuid;
begin
  v_today := property_today('00000000-0000-0000-0000-0000000000a2');
  select id into v_plan from rate_plans where property_id = '00000000-0000-0000-0000-0000000000a2' and is_default;
  insert into daily_rates (tenant_id, property_id, room_type_id, rate_plan_id, business_date, amount_minor)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', v_plan, v_today, 3100000);
  r := guest_room_types('book.hotel-a.test');
  if (r -> 'room_types' -> 0 ->> 'from_rate_minor')::bigint <> 3100000 then raise exception 'FAIL tonight''s rate not used %', r; end if;
  if r -> 'room_types' -> 0 ->> 'name' <> 'Standard' then raise exception 'FAIL order should follow the base rate, not the nightly rate'; end if;
  delete from daily_rates where room_type_id = '00000000-0000-0000-0000-0000000000a3' and business_date = v_today;
  -- no default plan: nothing can be priced, so nothing is advertised (search_availability finds nothing either)
  update rate_plans set is_default = false where id = v_plan;
  r := guest_room_types('book.hotel-a.test');
  if jsonb_array_length(r -> 'room_types') <> 0 then raise exception 'FAIL types shown with no default plan %', r; end if;
  update rate_plans set is_default = true where id = v_plan;
  raise notice 'PASS guest_room_types: from price is tonight''s default-plan rate, and nothing is advertised without a default plan';
end $$;

-- 6. closed to everyone but service_role
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ begin
  begin perform guest_room_types('book.hotel-a.test'); raise exception 'FAIL authenticated guest_room_types';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
begin;
set local role anon;
do $$ begin
  begin perform guest_room_types('book.hotel-a.test'); raise exception 'FAIL anon guest_room_types';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
do $$ begin raise notice 'PASS guest_room_types is closed to authenticated and anonymous callers'; end $$;
