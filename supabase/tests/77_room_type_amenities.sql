-- Amenities on room types (migration 077): the CHECK on the column, the audit row, and the guest search.
-- Uses its own room type for the constraint and audit blocks; the search block sets amenities on the standard type
-- (a3) and puts them back, using the search window today + 250 that 11_guest_booking.sql also uses.
-- Reuses t_as / t_sys (05). Each block is its own transaction.
\set ON_ERROR_STOP on

create table t77_ctx (k text primary key, id uuid);

-- 1. The column starts empty and the CHECK refuses anything amenities_valid refuses
do $$ declare v_type uuid; v_try text[]; v_case jsonb; v_refused integer := 0; begin
  insert into room_types (tenant_id, property_id, name, code, slug, max_adults, max_children, max_occupancy, base_rate_minor, is_public)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'Amenity Suite', 'T77', 'amenity-suite', 2, 0, 2, 100000, true)
  returning id into v_type;
  insert into t77_ctx values ('type', v_type);
  if (select amenities from room_types where id = v_type) <> '{}'::text[] then raise exception 'FAIL default is not an empty list'; end if;

  update room_types set amenities = array['Wi-Fi', 'Air conditioning', 'Breakfast included'] where id = v_type;
  update room_types set amenities = array(select 'Item ' || g from generate_series(1, 20) g) where id = v_type;
  update room_types set amenities = array[repeat('x', 40)] where id = v_type;
  update room_types set amenities = '{}' where id = v_type;

  -- each of these must be refused
  for v_case in select * from jsonb_array_elements(jsonb_build_array(
    to_jsonb(array(select 'Item ' || g from generate_series(1, 21) g)),   -- 21 items
    jsonb_build_array(repeat('x', 41)),                                    -- 41 characters
    jsonb_build_array(''),                                                 -- blank
    jsonb_build_array('  padded'),                                         -- leading space
    jsonb_build_array('padded  '),                                         -- trailing space
    jsonb_build_array('Wi-Fi', 'wi-fi'),                                   -- repeat ignoring case
    jsonb_build_array('Wi-Fi', null)                                       -- a null item
  )) loop
    v_try := array(select jsonb_array_elements_text(v_case));
    begin
      update room_types set amenities = v_try where id = v_type;
      raise exception 'FAIL stored an invalid list: %', v_try;
    exception when check_violation then v_refused := v_refused + 1; end;
  end loop;
  if v_refused <> 7 then raise exception 'FAIL expected 7 refusals, got %', v_refused; end if;

  begin
    update room_types set amenities = array[array['a', 'b'], array['c', 'd']] where id = v_type;
    raise exception 'FAIL stored a two-dimensional list';
  exception when check_violation then null; end;
  begin
    update room_types set amenities = null where id = v_type;
    raise exception 'FAIL stored null';
  exception when not_null_violation then null; end;

  if (select amenities from room_types where id = v_type) <> '{}'::text[] then raise exception 'FAIL a refused write changed the list'; end if;
  raise notice 'PASS amenities: empty by default, 20 items of 40 characters allowed, too many, too long, blank, padded, repeated, null and nested lists refused';
end $$;

-- 2. The audit row records the old and new list, and a repeat of the same list writes nothing
do $$ declare v_type uuid; v_before integer; a audit_logs%rowtype; begin
  select id into v_type from t77_ctx where k = 'type';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  update room_types set amenities = array['Wi-Fi', 'Safe'] where id = v_type;
  perform t_sys();
  select * into a from audit_logs where action = 'room_type.updated' and entity_id = v_type order by created_at desc, id desc limit 1;
  if a.id is null or a.actor_user_id is distinct from '00000000-0000-0000-0000-00000000aa01'
     or a.metadata #> '{changed,amenities,from}' <> '[]'::jsonb or a.metadata #> '{changed,amenities,to}' <> '["Wi-Fi", "Safe"]'::jsonb
     or (a.metadata -> 'changed') - 'amenities' <> '{}'::jsonb then
    raise exception 'FAIL amenities audit %', a;
  end if;

  select count(*) into v_before from audit_logs where entity_id = v_type;
  update room_types set amenities = array['Wi-Fi', 'Safe'] where id = v_type;
  if (select count(*) from audit_logs where entity_id = v_type) <> v_before then raise exception 'FAIL an unchanged list wrote an audit row'; end if;

  -- both updates share one transaction, so their rows share a timestamp: find the clearing row by what it says
  update room_types set amenities = '{}' where id = v_type;
  if not exists (select 1 from audit_logs where action = 'room_type.updated' and entity_id = v_type
                    and metadata #> '{changed,amenities,from}' = '["Wi-Fi", "Safe"]'::jsonb and metadata #> '{changed,amenities,to}' = '[]'::jsonb)
    then raise exception 'FAIL clearing the list is not audited'; end if;
  raise notice 'PASS an amenities change is audited with the old and new list, the actor, and nothing else; a repeat writes nothing';
end $$;

-- 3. The guest search returns the list with the type, empty when there is none, and the rest of the answer is unchanged
do $$ declare r jsonb; std jsonb; solo jsonb; plain jsonb; begin
  plain := search_availability('book.hotel-a.test', current_date + 250, current_date + 252, 2, 0);
  std := (select e from jsonb_array_elements(plain -> 'room_types') e where (e ->> 'room_type_id')::uuid = '00000000-0000-0000-0000-0000000000a3');
  if std is null or std -> 'amenities' <> '[]'::jsonb then raise exception 'FAIL a type with no amenities should answer an empty list %', std; end if;

  update room_types set amenities = array['Air conditioning', 'Wi-Fi'] where id = '00000000-0000-0000-0000-0000000000a3';
  r := search_availability('book.hotel-a.test', current_date + 250, current_date + 252, 2, 0);
  std := (select e from jsonb_array_elements(r -> 'room_types') e where (e ->> 'room_type_id')::uuid = '00000000-0000-0000-0000-0000000000a3');
  solo := (select e from jsonb_array_elements(r -> 'room_types') e where (e ->> 'room_type_id')::uuid = '00000000-0000-0000-0000-0000000000a4');
  if std -> 'amenities' <> '["Air conditioning", "Wi-Fi"]'::jsonb then raise exception 'FAIL search amenities %', std; end if;
  if solo -> 'amenities' <> '[]'::jsonb then raise exception 'FAIL another type picked up the list %', solo; end if;

  -- prices, counts and the other fields are what they were
  if (std ->> 'total_minor') <> (select e ->> 'total_minor' from jsonb_array_elements(plain -> 'room_types') e where (e ->> 'room_type_id')::uuid = '00000000-0000-0000-0000-0000000000a3')
     or (std ->> 'rooms_available') <> (select e ->> 'rooms_available' from jsonb_array_elements(plain -> 'room_types') e where (e ->> 'room_type_id')::uuid = '00000000-0000-0000-0000-0000000000a3')
     or r ->> 'property_name' is distinct from plain ->> 'property_name' then
    raise exception 'FAIL search changed more than the amenities';
  end if;

  update room_types set amenities = '{}' where id = '00000000-0000-0000-0000-0000000000a3';
  raise notice 'PASS the guest search returns each type''s amenities (empty when none) and changes nothing else';
end $$;
