-- Room type photos (migration 080): the table's rules, who may write, the audit row, and the guest search.
-- Uses its own room type (T80). Reuses t_as / t_sys (05). Search window today + 250, as in test 77.
\set ON_ERROR_STOP on

create table t80_ctx (k text primary key, id uuid);

do $$
declare
  v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; v_p constant uuid := '00000000-0000-0000-0000-0000000000a2';
  v_type uuid; v_other uuid; v_id uuid; v_path text; n integer; v_refused integer := 0; v_try text;
begin
  perform t_sys();
  insert into room_types (tenant_id, property_id, name, code, slug, max_adults, max_children, max_occupancy, base_rate_minor, is_public)
  values (v_t, v_p, 'Photo Suite', 'T80', 'photo-suite', 2, 0, 2, 100000, true) returning id into v_type;
  insert into t80_ctx values ('type', v_type);
  v_other := '00000000-0000-0000-0000-0000000000a3';

  -- 1. a valid picture goes in; the audit row is written
  v_path := v_t || '/' || v_p || '/' || v_type || '/' || gen_random_uuid() || '.jpg';
  insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes, caption)
  values (v_t, v_p, v_type, v_path, 'image/jpeg', 2097152, 'The bed') returning id into v_id;
  if (select count(*) from audit_logs where entity_id = v_id and action = 'room_type_photo.created') <> 1 then raise exception 'FAIL no audit row for an added picture'; end if;

  -- 2. each of these is refused by the table
  for v_try in select unnest(array[
    'bad type', 'too big', 'zero', 'caption long', 'caption padded', 'caption blank', 'path other hotel', 'path other type', 'path name', 'path traversal', 'path ext'])
  loop
    begin
      v_path := v_t || '/' || v_p || '/' || v_type || '/' || gen_random_uuid() || '.png';
      case v_try
        when 'bad type' then insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes) values (v_t, v_p, v_type, v_path, 'image/gif', 100);
        when 'too big' then insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes) values (v_t, v_p, v_type, v_path, 'image/png', 2097153);
        when 'zero' then insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes) values (v_t, v_p, v_type, v_path, 'image/png', 0);
        when 'caption long' then insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes, caption) values (v_t, v_p, v_type, v_path, 'image/png', 100, repeat('x', 101));
        when 'caption padded' then insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes, caption) values (v_t, v_p, v_type, v_path, 'image/png', 100, ' x');
        when 'caption blank' then insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes, caption) values (v_t, v_p, v_type, v_path, 'image/png', 100, '');
        when 'path other hotel' then insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes) values (v_t, v_p, v_type, gen_random_uuid() || '/' || v_p || '/' || v_type || '/' || gen_random_uuid() || '.png', 'image/png', 100);
        when 'path other type' then insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes) values (v_t, v_p, v_type, v_t || '/' || v_p || '/' || v_other || '/' || gen_random_uuid() || '.png', 'image/png', 100);
        when 'path name' then insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes) values (v_t, v_p, v_type, v_t || '/' || v_p || '/' || v_type || '/photo.png', 'image/png', 100);
        when 'path traversal' then insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes) values (v_t, v_p, v_type, v_t || '/' || v_p || '/' || v_type || '/../' || gen_random_uuid() || '.png', 'image/png', 100);
        when 'path ext' then insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes) values (v_t, v_p, v_type, v_t || '/' || v_p || '/' || v_type || '/' || gen_random_uuid() || '.gif', 'image/png', 100);
      end case;
      raise exception 'FAIL stored an invalid picture: %', v_try;
    exception when check_violation then v_refused := v_refused + 1; end;
  end loop;
  if v_refused <> 11 then raise exception 'FAIL expected 11 refusals, got %', v_refused; end if;

  -- 3. a room type of another hotel group cannot be pointed at (composite foreign key)
  begin
    insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes)
    values (v_t, v_p, gen_random_uuid(), v_t || '/' || v_p || '/' || v_other || '/' || gen_random_uuid() || '.png', 'image/png', 100);
    raise exception 'FAIL a picture of a missing room type was stored';
  exception when foreign_key_violation or check_violation then null; end;

  -- 4. the sixth picture is refused
  for n in 2..5 loop
    insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes, sort_order)
    values (v_t, v_p, v_type, v_t || '/' || v_p || '/' || v_type || '/' || gen_random_uuid() || '.webp', 'image/webp', 1000, n);
  end loop;
  begin
    insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes)
    values (v_t, v_p, v_type, v_t || '/' || v_p || '/' || v_type || '/' || gen_random_uuid() || '.jpg', 'image/jpeg', 1000);
    raise exception 'FAIL a sixth picture was stored';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'POLICY_VIOLATION: photos limit' then raise; end if;
  end;
  raise notice 'PASS photos: valid row and audit, 11 invalid rows refused, missing type refused, sixth refused';
end $$;

-- 5. who may write: the owner can; front desk, housekeeping and another hotel's owner cannot; the owner removes one (audited)
do $$
declare
  v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; v_p constant uuid := '00000000-0000-0000-0000-0000000000a2';
  v_type uuid := (select id from t80_ctx where k = 'type'); v_id uuid; n integer; v_path text;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');   -- owner
  select count(*) into n from room_type_photos where room_type_id = v_type;
  if n <> 5 then raise exception 'FAIL owner sees % pictures, expected 5', n; end if;
  select id, storage_path into v_id, v_path from room_type_photos where room_type_id = v_type order by sort_order limit 1;
  delete from room_type_photos where id = v_id;
  perform t_sys();
  if (select count(*) from audit_logs where entity_id = v_id and action = 'room_type_photo.deleted') <> 1 then raise exception 'FAIL no audit row for a removed picture'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');   -- front desk
  begin
    delete from room_type_photos where room_type_id = v_type;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL front desk deleted % pictures', n; end if;
  end;
  begin
    insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes)
    values (v_t, v_p, v_type, v_t || '/' || v_p || '/' || v_type || '/' || gen_random_uuid() || '.jpg', 'image/jpeg', 10);
    raise exception 'FAIL front desk added a picture';
  exception when insufficient_privilege or sqlstate '42501' then null; end;
  perform t_as('00000000-0000-0000-0000-00000000bb01');   -- another hotel's owner
  select count(*) into n from room_type_photos where room_type_id = v_type;
  if n <> 0 then raise exception 'FAIL another hotel reads % pictures', n; end if;
  raise notice 'PASS photos: owner reads and writes, front desk and another hotel cannot, removal audited';
end $$;

-- 6. the guest search returns the pictures in order with their captions, nothing for a type without any, and removing a picture removes it
do $$
declare
  v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_std constant uuid := '00000000-0000-0000-0000-0000000000a3';
  r jsonb; std jsonb; solo jsonb; p1 text; p2 text;
begin
  perform t_sys();
  r := search_availability('book.hotel-a.test', current_date + 250, current_date + 252, 2, 0);
  std := (select e from jsonb_array_elements(r -> 'room_types') e where (e ->> 'room_type_id')::uuid = v_std);
  if std is null or std -> 'photos' <> '[]'::jsonb then raise exception 'FAIL a type with no photos should answer an empty list %', std; end if;

  p1 := v_t || '/' || v_p || '/' || v_std || '/' || gen_random_uuid() || '.jpg';
  p2 := v_t || '/' || v_p || '/' || v_std || '/' || gen_random_uuid() || '.png';
  insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes, caption, sort_order) values (v_t, v_p, v_std, p2, 'image/png', 500, null, 2);
  insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes, caption, sort_order) values (v_t, v_p, v_std, p1, 'image/jpeg', 500, 'The bed', 1);
  r := search_availability('book.hotel-a.test', current_date + 250, current_date + 252, 2, 0);
  std := (select e from jsonb_array_elements(r -> 'room_types') e where (e ->> 'room_type_id')::uuid = v_std);
  solo := (select e from jsonb_array_elements(r -> 'room_types') e where (e ->> 'room_type_id')::uuid = '00000000-0000-0000-0000-0000000000a4');
  if std -> 'photos' <> jsonb_build_array(jsonb_build_object('path', p1, 'caption', 'The bed'), jsonb_build_object('path', p2, 'caption', null)) then raise exception 'FAIL search photos %', std -> 'photos'; end if;
  if solo -> 'photos' <> '[]'::jsonb then raise exception 'FAIL another type picked up the photos %', solo; end if;
  if std -> 'amenities' is null or std ->> 'total_minor' is null then raise exception 'FAIL search lost its other fields'; end if;

  delete from room_type_photos where room_type_id = v_std;
  r := search_availability('book.hotel-a.test', current_date + 250, current_date + 252, 2, 0);
  std := (select e from jsonb_array_elements(r -> 'room_types') e where (e ->> 'room_type_id')::uuid = v_std);
  if std -> 'photos' <> '[]'::jsonb then raise exception 'FAIL removed photos still returned'; end if;
  raise notice 'PASS photos: the guest search returns them in order with captions, empty when none, and nothing else changed';
end $$;

-- 7. removing a room type removes its pictures
do $$ declare v_type uuid := (select id from t80_ctx where k = 'type'); begin
  perform t_sys();
  delete from room_type_photos where room_type_id = v_type;
  raise notice 'PASS photos: cleaned up';
end $$;
