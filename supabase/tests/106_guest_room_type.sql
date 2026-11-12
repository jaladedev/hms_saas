-- guest_room_type (migration 106). Hosts from 06: book.hotel-a.test (Hotel A: Standard a3 at 25,000, Solo Suite a4 at 90,000),
-- hotel-b.test (Hotel B: Standard at 20,000), draft.hotel-a.test (not verified).
\set ON_ERROR_STOP on

-- 1. one bookable type with the fields of the homepage card plus its nights; default 14, from today, on the base rate
do $$ declare r jsonb; v_today date := property_today('00000000-0000-0000-0000-0000000000a2'); begin
  r := guest_room_type('book.hotel-a.test', '00000000-0000-0000-0000-0000000000a3');
  if r -> 'room_type' ->> 'name' <> 'Standard' or r ->> 'currency' <> 'NGN' then raise exception 'FAIL type %', r; end if;
  if jsonb_array_length(r -> 'nights') <> 14 then raise exception 'FAIL nights %', jsonb_array_length(r -> 'nights'); end if;
  if (r -> 'nights' -> 0 ->> 'date')::date <> v_today or (r -> 'nights' -> 13 ->> 'date')::date <> v_today + 13 then raise exception 'FAIL dates %', r -> 'nights'; end if;
  if exists (select 1 from jsonb_array_elements(r -> 'nights') n where (n ->> 'rate_minor')::bigint <> 2500000) then raise exception 'FAIL base rate %', r -> 'nights'; end if;
  if (r -> 'room_type' ->> 'from_rate_minor')::bigint <> 2500000 then raise exception 'FAIL from rate'; end if;
  if r::text like '%00000000-0000-0000-0000-0000000000a1%' or r::text like '%00000000-0000-0000-0000-0000000000a2%' then raise exception 'FAIL tenant or property id leaked'; end if;
  raise notice 'PASS guest_room_type: the type and 14 nights from today on the base rate, no tenant or property id';
end $$;

-- 2. a daily rate shows on its night; from_date is never earlier than today; nights is limited to 1..31
do $$ declare
  r jsonb; v_today date := property_today('00000000-0000-0000-0000-0000000000a2'); v_plan uuid;
begin
  select id into v_plan from rate_plans where property_id = '00000000-0000-0000-0000-0000000000a2' and is_default;
  insert into daily_rates (tenant_id, property_id, room_type_id, rate_plan_id, business_date, amount_minor)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', v_plan, v_today + 2, 3100000);
  r := guest_room_type('book.hotel-a.test', '00000000-0000-0000-0000-0000000000a3', v_today - 30, 5);
  if jsonb_array_length(r -> 'nights') <> 5 or (r -> 'nights' -> 0 ->> 'date')::date <> v_today then raise exception 'FAIL past from_date %', r -> 'nights'; end if;
  if (r -> 'nights' -> 2 ->> 'rate_minor')::bigint <> 3100000 or (r -> 'nights' -> 1 ->> 'rate_minor')::bigint <> 2500000 then raise exception 'FAIL daily rate %', r -> 'nights'; end if;
  if jsonb_array_length(guest_room_type('book.hotel-a.test', '00000000-0000-0000-0000-0000000000a3', null, 500) -> 'nights') <> 31 then raise exception 'FAIL upper limit'; end if;
  if jsonb_array_length(guest_room_type('book.hotel-a.test', '00000000-0000-0000-0000-0000000000a3', null, 0) -> 'nights') <> 1 then raise exception 'FAIL lower limit'; end if;
  r := guest_room_type('book.hotel-a.test', '00000000-0000-0000-0000-0000000000a3', v_today + 10, 3);
  if (r -> 'nights' -> 0 ->> 'date')::date <> v_today + 10 then raise exception 'FAIL future from_date'; end if;
  delete from daily_rates where room_type_id = '00000000-0000-0000-0000-0000000000a3' and business_date = v_today + 2;
  raise notice 'PASS guest_room_type: a nightly rate shows on its night, past start becomes today, nights limited to 1..31';
end $$;

-- 3. no default plan: the type still shows, every night is null
do $$ declare r jsonb; v_plan uuid; begin
  select id into v_plan from rate_plans where property_id = '00000000-0000-0000-0000-0000000000a2' and is_default;
  update rate_plans set is_default = false where id = v_plan;
  r := guest_room_type('book.hotel-a.test', '00000000-0000-0000-0000-0000000000a3', null, 3);
  update rate_plans set is_default = true where id = v_plan;
  if exists (select 1 from jsonb_array_elements(r -> 'nights') n where (n -> 'rate_minor') <> 'null'::jsonb) or (r -> 'room_type' -> 'from_rate_minor') <> 'null'::jsonb then raise exception 'FAIL rates without a plan %', r; end if;
  raise notice 'PASS guest_room_type: with no default plan every night is null';
end $$;

-- 4. amenities, description and pictures (in the hotel's order) come through
do $$ declare
  r jsonb; v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_rt constant uuid := '00000000-0000-0000-0000-0000000000a3';
  p1 text := v_t || '/' || v_p || '/' || v_rt || '/' || gen_random_uuid() || '.png';
  p2 text := v_t || '/' || v_p || '/' || v_rt || '/' || gen_random_uuid() || '.jpg';
begin
  update room_types set amenities = array['Air conditioning', 'Wi-Fi'], description = 'Quiet and bright.' where id = v_rt;
  insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes, caption, sort_order)
  values (v_t, v_p, v_rt, p1, 'image/png', 1000, 'Second', 2), (v_t, v_p, v_rt, p2, 'image/jpeg', 1000, 'First', 1);
  r := guest_room_type('book.hotel-a.test', v_rt) -> 'room_type';
  if r -> 'amenities' <> '["Air conditioning", "Wi-Fi"]'::jsonb or r ->> 'description' <> 'Quiet and bright.' then raise exception 'FAIL amenities %', r; end if;
  if jsonb_array_length(r -> 'photos') <> 2 or r -> 'photos' -> 0 ->> 'path' <> p2 or r -> 'photos' -> 1 ->> 'path' <> p1 then raise exception 'FAIL photos %', r -> 'photos'; end if;
  delete from room_type_photos where room_type_id = v_rt;
  update room_types set amenities = '{}', description = null where id = v_rt;
  raise notice 'PASS guest_room_type: amenities, description and pictures in the hotel''s order';
end $$;

-- 5. NOT_FOUND for another hotel's type, a private, inactive or roomless type, a made-up id, and every host that does not answer
do $$ declare v_n int := 0; v_try uuid; begin
  begin perform guest_room_type('book.hotel-a.test', (select id from room_types where property_id = '00000000-0000-0000-0000-0000000000b2' limit 1)); raise exception 'FAIL other hotel''s type';
  exception when sqlstate 'P0001' then if sqlerrm <> 'NOT_FOUND' then raise; end if; end;
  begin perform guest_room_type('book.hotel-a.test', gen_random_uuid()); raise exception 'FAIL made-up id';
  exception when sqlstate 'P0001' then if sqlerrm <> 'NOT_FOUND' then raise; end if; end;
  update room_types set is_public = false where id = '00000000-0000-0000-0000-0000000000a4';
  begin perform guest_room_type('book.hotel-a.test', '00000000-0000-0000-0000-0000000000a4'); raise exception 'FAIL private type';
  exception when sqlstate 'P0001' then if sqlerrm <> 'NOT_FOUND' then raise; end if; end;
  update room_types set is_public = true, status = 'inactive' where id = '00000000-0000-0000-0000-0000000000a4';
  begin perform guest_room_type('book.hotel-a.test', '00000000-0000-0000-0000-0000000000a4'); raise exception 'FAIL inactive type';
  exception when sqlstate 'P0001' then if sqlerrm <> 'NOT_FOUND' then raise; end if; end;
  update room_types set status = 'active' where id = '00000000-0000-0000-0000-0000000000a4';
  update rooms set operational_status = 'out_of_service' where room_type_id = '00000000-0000-0000-0000-0000000000a4';
  begin perform guest_room_type('book.hotel-a.test', '00000000-0000-0000-0000-0000000000a4'); raise exception 'FAIL roomless type';
  exception when sqlstate 'P0001' then if sqlerrm <> 'NOT_FOUND' then raise; end if; end;
  update rooms set operational_status = 'active' where room_type_id = '00000000-0000-0000-0000-0000000000a4';
  perform guest_room_type('book.hotel-a.test', '00000000-0000-0000-0000-0000000000a4');
  foreach v_try in array array['00000000-0000-0000-0000-0000000000a3'::uuid] loop
    begin perform guest_room_type('draft.hotel-a.test', v_try); raise exception 'FAIL unverified host';
    exception when sqlstate 'P0001' then null; end;
    begin perform guest_room_type('nowhere.test', v_try); raise exception 'FAIL unknown host';
    exception when sqlstate 'P0001' then null; end;
    begin perform guest_room_type(null, v_try); raise exception 'FAIL null host';
    exception when sqlstate 'P0001' then null; end;
    begin perform guest_room_type('hotel-b.test', v_try); raise exception 'FAIL type read through another hotel''s host';
    exception when sqlstate 'P0001' then null; end;
  end loop;
  raise notice 'PASS guest_room_type: only this hotel''s bookable types, nothing for other hosts';
end $$;

-- 6. closed to everyone but service_role
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ begin
  begin perform guest_room_type('book.hotel-a.test', '00000000-0000-0000-0000-0000000000a3'); raise exception 'FAIL authenticated guest_room_type';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
begin;
set local role anon;
do $$ begin
  begin perform guest_room_type('book.hotel-a.test', '00000000-0000-0000-0000-0000000000a3'); raise exception 'FAIL anon guest_room_type';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
do $$ begin raise notice 'PASS guest_room_type is closed to authenticated and anonymous callers'; end $$;
