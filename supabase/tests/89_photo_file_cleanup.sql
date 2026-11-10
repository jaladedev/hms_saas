-- Photo file cleanup queue (migration 088). Own room type T89. Reuses t_as / t_sys / t_expect (05).
\set ON_ERROR_STOP on

create table t89_ctx (k text primary key, v text);

-- 1. every way a picture row goes queues its path: a plain delete, and a room type removed with its pictures
do $$
declare
  v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; v_p constant uuid := '00000000-0000-0000-0000-0000000000a2';
  v_type uuid; v_path1 text; v_path2 text; v_path3 text;
begin
  perform t_sys();
  insert into room_types (tenant_id, property_id, name, code, slug, max_adults, max_children, max_occupancy, base_rate_minor, is_public)
  values (v_t, v_p, 'Cleanup Suite', 'T89', 'cleanup-suite', 2, 0, 2, 100000, true) returning id into v_type;
  v_path1 := v_t || '/' || v_p || '/' || v_type || '/' || gen_random_uuid() || '.jpg';
  v_path2 := v_t || '/' || v_p || '/' || v_type || '/' || gen_random_uuid() || '.png';
  v_path3 := v_t || '/' || v_p || '/' || v_type || '/' || gen_random_uuid() || '.webp';
  insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes) values
    (v_t, v_p, v_type, v_path1, 'image/jpeg', 100), (v_t, v_p, v_type, v_path2, 'image/png', 100), (v_t, v_p, v_type, v_path3, 'image/webp', 100);
  insert into t89_ctx values ('p1', v_path1), ('p2', v_path2), ('p3', v_path3);
  delete from room_photo_cleanup;   -- earlier tests (80, 81) deleted pictures too, so their paths are queued

  delete from room_type_photos where storage_path = v_path1;
  if (select array_agg(path) from room_photo_cleanup) <> array[v_path1] then raise exception 'FAIL a removed picture was not queued'; end if;

  delete from room_types where id = v_type;   -- cascades to the two pictures left
  if (select count(*) from room_photo_cleanup where path in (v_path1, v_path2, v_path3)) <> 3 then raise exception 'FAIL room type delete did not queue its pictures'; end if;
  raise notice 'PASS photo cleanup: a removed picture and a deleted room type queue every file path';
end $$;

-- 2. claim returns oldest first within the limit and does not clear; finish clears only what it is given; unknown paths count nothing
do $$
declare p1 text := (select v from t89_ctx where k = 'p1'); p2 text := (select v from t89_ctx where k = 'p2'); p3 text := (select v from t89_ctx where k = 'p3');
        c text[]; n integer;
begin
  perform t_sys();
  c := claim_photo_cleanup(2);
  if array_length(c, 1) <> 2 then raise exception 'FAIL limit not applied %', c; end if;
  if array_length(claim_photo_cleanup(null), 1) <> 3 or array_length(claim_photo_cleanup(0), 1) <> 1 then raise exception 'FAIL default and minimum limits'; end if;
  if (select count(*) from room_photo_cleanup) <> 3 then raise exception 'FAIL claiming must not clear the queue'; end if;
  n := finish_photo_cleanup(array[p1, p2, 'nowhere/never.jpg']);
  if n <> 2 or (select array_agg(path) from room_photo_cleanup) <> array[p3] then raise exception 'FAIL finish cleared % %', n, (select array_agg(path) from room_photo_cleanup); end if;
  if finish_photo_cleanup(null) <> 0 or finish_photo_cleanup('{}') <> 0 then raise exception 'FAIL empty finish'; end if;
  n := finish_photo_cleanup(array[p3]);
  if n <> 1 or claim_photo_cleanup(10) is distinct from '{}'::text[] then raise exception 'FAIL final clear % %', n, claim_photo_cleanup(10); end if;
  raise notice 'PASS photo cleanup: claim respects the limit and leaves the queue alone, finish clears exactly what it is given';
end $$;

-- 3. a path already queued is not queued twice
do $$
declare v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_type uuid; v_path text;
begin
  perform t_sys();
  insert into room_types (tenant_id, property_id, name, code, slug, max_adults, max_children, max_occupancy, base_rate_minor, is_public)
  values (v_t, v_p, 'Cleanup Two', 'T89B', 'cleanup-two', 2, 0, 2, 100000, true) returning id into v_type;
  v_path := v_t || '/' || v_p || '/' || v_type || '/' || gen_random_uuid() || '.jpg';
  insert into room_type_photos (tenant_id, property_id, room_type_id, storage_path, content_type, size_bytes) values (v_t, v_p, v_type, v_path, 'image/jpeg', 100);
  insert into room_photo_cleanup (path) values (v_path);
  delete from room_type_photos where storage_path = v_path;
  if (select count(*) from room_photo_cleanup where path = v_path) <> 1 then raise exception 'FAIL path queued twice'; end if;
  perform finish_photo_cleanup(array[v_path]);
  delete from room_types where id = v_type;
  raise notice 'PASS photo cleanup: a path already waiting is not queued again';
end $$;

-- 4. logins cannot read or change the queue or call the functions
do $$
declare v_state text; v_who text;
begin
  foreach v_who in array array['authenticated', 'anon'] loop
    begin
      execute format('set local role %I', v_who);
      perform claim_photo_cleanup(1);
      v_state := 'allowed';
    exception when insufficient_privilege then v_state := 'refused';
    end;
    reset role;
    if v_state <> 'refused' then raise exception 'FAIL % could call claim_photo_cleanup', v_who; end if;
    begin
      execute format('set local role %I', v_who);
      perform finish_photo_cleanup('{}');
      v_state := 'allowed';
    exception when insufficient_privilege then v_state := 'refused';
    end;
    reset role;
    if v_state <> 'refused' then raise exception 'FAIL % could call finish_photo_cleanup', v_who; end if;
    begin
      execute format('set local role %I', v_who);
      perform count(*) from room_photo_cleanup;
      v_state := 'allowed';
    exception when insufficient_privilege then v_state := 'refused';
    end;
    reset role;
    if v_state <> 'refused' then raise exception 'FAIL % could read the queue', v_who; end if;
  end loop;
  raise notice 'PASS photo cleanup: authenticated and anon cannot read the queue or call either function';
end $$;
