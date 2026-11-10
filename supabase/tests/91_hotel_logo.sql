-- Hotel logo (migration 090). Hotel A: tenant a1, property a2. Owner aa01, front desk aa04, another hotel's owner bb01.
\set ON_ERROR_STOP on

create table t91_ctx (k text primary key, v text);

do $$
declare
  v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_other constant uuid := '00000000-0000-0000-0000-0000000000b1';
  p1 text := v_t || '/' || v_p || '/logo/' || gen_random_uuid() || '.png'; p2 text := v_t || '/' || v_p || '/logo/' || gen_random_uuid() || '.webp';
  r jsonb;
begin
  perform t_sys();
  delete from room_photo_cleanup;
  insert into t91_ctx values ('p1', p1), ('p2', p2);

  -- 1. set; guest_hotel returns it; audited; nothing queued
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_hotel_logo(v_p, p1);
  perform t_sys();
  r := guest_hotel('book.hotel-a.test');
  if r ->> 'logo' <> p1 then raise exception 'FAIL logo not returned %', r; end if;
  if not exists (select 1 from audit_logs where entity_id = v_p and action = 'property.updated' and metadata -> 'changed' ? 'logo_path') then raise exception 'FAIL logo change not audited'; end if;
  if (select count(*) from room_photo_cleanup) <> 0 then raise exception 'FAIL first logo should queue nothing'; end if;

  -- 2. replacing queues the old file, once
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_hotel_logo(v_p, p2);
  perform t_sys();
  if (select array_agg(path) from room_photo_cleanup) <> array[p1] then raise exception 'FAIL replaced logo not queued %', (select array_agg(path) from room_photo_cleanup); end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_hotel_logo(v_p, p2);   -- same again: nothing changes, nothing more queued
  perform t_sys();
  if (select count(*) from room_photo_cleanup) <> 1 then raise exception 'FAIL an unchanged logo queued something'; end if;

  -- 3. removing (null or blank) clears it and queues the file
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_hotel_logo(v_p, '  ');
  perform t_sys();
  if (select logo_path from properties where id = v_p) is not null then raise exception 'FAIL logo not cleared'; end if;
  if (select guest_hotel('book.hotel-a.test') -> 'logo') <> 'null'::jsonb then raise exception 'FAIL guest_hotel still shows a logo'; end if;
  if (select count(*) from room_photo_cleanup where path in (p1, p2)) <> 2 then raise exception 'FAIL removed logo not queued'; end if;
  raise notice 'PASS hotel logo: set, replaced and removed; guest_hotel follows; audited; old files queued once';
end $$;

-- 4. paths that are not this hotel's logo folder are refused
do $$
declare
  v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_try text; v_refused integer := 0; v_path text;
  v_u text := gen_random_uuid()::text;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  for v_try in select unnest(array['other hotel', 'other tenant', 'room folder', 'bad ext', 'gif', 'traversal', 'no name', 'foreign'])
  loop
    begin
      v_path := case v_try
        when 'other hotel' then v_t || '/00000000-0000-0000-0000-0000000000b2/logo/' || v_u || '.png'
        when 'other tenant' then '00000000-0000-0000-0000-0000000000b1/' || v_p || '/logo/' || v_u || '.png'
        when 'room folder' then v_t || '/' || v_p || '/' || v_u || '/' || v_u || '.png'
        when 'bad ext' then v_t || '/' || v_p || '/logo/' || v_u || '.exe'
        when 'gif' then v_t || '/' || v_p || '/logo/' || v_u || '.gif'
        when 'traversal' then v_t || '/' || v_p || '/logo/../' || v_u || '.png'
        when 'no name' then v_t || '/' || v_p || '/logo/logo.png'
        else 'https://elsewhere.test/logo.png' end;
      perform set_hotel_logo(v_p, v_path);
      raise exception 'FAIL % was accepted', v_try;
    exception when check_violation then v_refused := v_refused + 1;
    end;
  end loop;
  if v_refused <> 8 then raise exception 'FAIL only % refused', v_refused; end if;
  perform t_sys();
  if (select logo_path from properties where id = v_p) is not null then raise exception 'FAIL a refused path was stored'; end if;
  raise notice 'PASS hotel logo: 8 paths outside this hotel''s logo folder refused';
end $$;

-- 5. only property.configure at this hotel; anon cannot call it
do $$
declare
  v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_state text;
  v_path text := v_t || '/' || v_p || '/logo/' || gen_random_uuid() || '.jpg';
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select set_hotel_logo(%L, %L)', v_p, v_path), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select set_hotel_logo(%L, %L)', v_p, v_path), 'NOT_FOUND');
  perform t_sys();
  if (select logo_path from properties where id = v_p) is not null then raise exception 'FAIL a refused caller set the logo'; end if;
  begin
    set local role anon;
    perform set_hotel_logo(v_p, v_path);
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could call set_hotel_logo'; end if;
  delete from room_photo_cleanup;
  raise notice 'PASS hotel logo: front desk and another hotel are refused, anon cannot call it';
end $$;
