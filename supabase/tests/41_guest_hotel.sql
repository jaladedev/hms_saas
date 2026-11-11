-- guest_hotel (migration 041). Reuses the hosts made in 06: book.hotel-a.test (Hotel A Ibadan), hotel-b.test (Hotel B Ibadan),
-- draft.hotel-a.test (not verified).
\set ON_ERROR_STOP on

-- 1. The name, address, town and times of the host's own hotel, and only those
do $$ declare r jsonb; p properties%rowtype; begin
  select * into p from properties where id = '00000000-0000-0000-0000-0000000000a2';
  r := guest_hotel('book.hotel-a.test');
  if r ->> 'name' <> p.name or r ->> 'name' <> 'Hotel A Ibadan'
     or r ->> 'city' <> p.city or r ->> 'state' <> p.state
     or (r ->> 'check_in_time')::time <> p.check_in_time or (r ->> 'check_out_time')::time <> p.check_out_time then
    raise exception 'FAIL guest hotel %', r;
  end if;
  if (select count(*) from jsonb_object_keys(r)) <> 17
     or not (r ?& array['name','address','city','state','check_in_time','check_out_time','phone','email','intro','logo','theme','theme_primary','font_display','font_body','facilities','instagram','facebook']) then
    raise exception 'FAIL guest hotel keys %', r;
  end if;
  raise notice 'PASS guest_hotel returns the seventeen facts a visitor may see and nothing else';
end $$;

-- 2. A blank address is reported as missing, a real one is returned trimmed of nothing but emptiness
do $$ declare r jsonb; begin
  update properties set address = '   ' where id = '00000000-0000-0000-0000-0000000000a2';
  r := guest_hotel('book.hotel-a.test');
  if r -> 'address' <> 'null'::jsonb then raise exception 'FAIL blank address %', r; end if;
  update properties set address = '12 Example Road' where id = '00000000-0000-0000-0000-0000000000a2';
  r := guest_hotel('book.hotel-a.test');
  if r ->> 'address' <> '12 Example Road' then raise exception 'FAIL address %', r; end if;
  update properties set address = null where id = '00000000-0000-0000-0000-0000000000a2';
  raise notice 'PASS guest_hotel reports a blank address as null';
end $$;

-- 3. The host decides: another hotel gets its own details, an unverified or unknown host finds nothing, and so does
--    a hotel that is switched off
do $$ declare r jsonb; begin
  r := guest_hotel('hotel-b.test');
  if r ->> 'name' <> 'Hotel B Ibadan' then raise exception 'FAIL hotel B %', r; end if;
  begin perform guest_hotel('draft.hotel-a.test'); raise exception 'FAIL unverified host';
  exception when sqlstate 'P0001' then null; end;
  begin perform guest_hotel('nowhere.test'); raise exception 'FAIL unknown host';
  exception when sqlstate 'P0001' then null; end;
  begin perform guest_hotel(null); raise exception 'FAIL null host';
  exception when sqlstate 'P0001' then null; end;
  update properties set status = 'inactive' where id = '00000000-0000-0000-0000-0000000000b2';
  begin perform guest_hotel('hotel-b.test'); raise exception 'FAIL inactive property';
  exception when sqlstate 'P0001' then null; end;
  update properties set status = 'active' where id = '00000000-0000-0000-0000-0000000000b2';
  raise notice 'PASS guest_hotel is scoped to the host: other hotels, unverified, unknown and switched-off hotels give nothing of this one';
end $$;

-- 4. Closed to everyone but service_role
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ begin
  begin perform guest_hotel('book.hotel-a.test'); raise exception 'FAIL authenticated guest_hotel';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
begin;
set local role anon;
do $$ begin
  begin perform guest_hotel('book.hotel-a.test'); raise exception 'FAIL anon guest_hotel';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
do $$ begin raise notice 'PASS guest_hotel is closed to authenticated and anonymous callers'; end $$;
