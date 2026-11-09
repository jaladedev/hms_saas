-- Moving pictures (migration 081). Own room type T81. Reuses t_as / t_sys / t_expect (05).
\set ON_ERROR_STOP on

create table t81_ctx (n integer primary key, id uuid, type uuid);

do $$
declare
  v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; v_p constant uuid := '00000000-0000-0000-0000-0000000000a2';
  v_type uuid; i integer; v_id uuid;
begin
  perform t_sys();
  insert into room_types (tenant_id, property_id, name, code, slug, max_adults, max_children, max_occupancy, base_rate_minor, is_public)
  values (v_t, v_p, 'Order Suite', 'T81', 'order-suite', 2, 0, 2, 100000, true) returning id into v_type;
  -- three pictures, all with the same order number (as left by deletions or ties)
  for i in 1..3 loop
    insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes, caption, sort_order, created_at)
    values (v_t, v_p, v_type, v_t || '/' || v_p || '/' || v_type || '/' || gen_random_uuid() || '.jpg', 'image/jpeg', 100, 'P' || i, 0, now() + i * interval '1 second') returning id into v_id;
    insert into t81_ctx values (i, v_id, v_type);
  end loop;
end $$;

create function t81_order() returns text language sql as $$
  select string_agg(p.caption, ',' order by p.sort_order, p.created_at) from room_type_photos p where p.room_type_id = (select type from t81_ctx where n = 1) $$;

-- 1. ties are cleaned up and a move works
do $$
declare v_p3 uuid := (select id from t81_ctx where n = 3); r integer;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := move_room_type_photo(v_p3, 'up');
  if r <> 1 or t81_order() <> 'P1,P3,P2' then raise exception 'FAIL move up gave % / %', r, t81_order(); end if;
  r := move_room_type_photo(v_p3, 'up');
  if r <> 0 or t81_order() <> 'P3,P1,P2' then raise exception 'FAIL second move up gave % / %', r, t81_order(); end if;
  r := move_room_type_photo(v_p3, 'up');
  if r <> 0 or t81_order() <> 'P3,P1,P2' then raise exception 'FAIL the first picture moved up %', t81_order(); end if;
  r := move_room_type_photo(v_p3, 'down');
  if r <> 1 or t81_order() <> 'P1,P3,P2' then raise exception 'FAIL move down gave % / %', r, t81_order(); end if;
  r := move_room_type_photo((select id from t81_ctx where n = 2), 'down');
  if r <> 2 or t81_order() <> 'P1,P3,P2' then raise exception 'FAIL the last picture moved down %', t81_order(); end if;
  raise notice 'PASS photo order: ties are renumbered, moves swap with the neighbour, the ends stay put';
end $$;

-- 2. the audit trail records the changed order and a caption edit
do $$
declare v_p1 uuid := (select id from t81_ctx where n = 1);
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  update room_type_photos set caption = 'First' where id = v_p1;
  if not exists (select 1 from audit_logs where entity_id = v_p1 and action = 'room_type_photo.updated' and metadata -> 'changed' ? 'caption') then raise exception 'FAIL caption edit not audited'; end if;
  if not exists (select 1 from audit_logs where entity_id = v_p1 and action = 'room_type_photo.updated' and metadata -> 'changed' ? 'sort_order') then raise exception 'FAIL order change not audited'; end if;
  update room_type_photos set caption = 'P1' where id = v_p1;
  raise notice 'PASS photo order: caption edits and order changes are audited';
end $$;

-- 3. refusals: a bad direction, an unknown picture, a person without hotel setup permission, another hotel, anon
do $$
declare v_p1 uuid := (select id from t81_ctx where n = 1); v_state text; v_before text;
begin
  v_before := (select t81_order());
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select move_room_type_photo(%L, %L)', v_p1, 'sideways'), 'INVALID_INPUT');
  perform t_expect(format('select move_room_type_photo(%L, %L)', gen_random_uuid(), 'up'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');   -- front desk
  perform t_expect(format('select move_room_type_photo(%L, %L)', v_p1, 'down'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');   -- owner of another hotel
  perform t_expect(format('select move_room_type_photo(%L, %L)', v_p1, 'down'), 'NOT_FOUND');
  perform t_sys();
  if t81_order() <> v_before then raise exception 'FAIL a refused move changed the order'; end if;
  begin
    set local role anon;
    perform move_room_type_photo(v_p1, 'down');
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could call move_room_type_photo'; end if;
  raise notice 'PASS photo order: bad input, unknown picture, missing permission, other hotel and anon are all refused';
end $$;

-- 4. cleanup
do $$ begin
  perform t_sys();
  delete from room_type_photos where room_type_id = (select type from t81_ctx where n = 1);
  raise notice 'PASS photo order: cleaned up';
end $$;
