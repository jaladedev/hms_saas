-- Tenant isolation and role tests. Run as superuser; each block switches to a client role.
-- Users: ua = owner of Hotel A, hk = housekeeping at Hotel A, ub = owner of Hotel B, rv = revoked at A.
insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000aa01'), ('00000000-0000-0000-0000-00000000aa02'),
  ('00000000-0000-0000-0000-00000000bb01'), ('00000000-0000-0000-0000-00000000aa03');
insert into tenant_memberships (id, tenant_id, user_id, status) values
  ('00000000-0000-0000-0000-0000000aaa01','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000aa01','active'),
  ('00000000-0000-0000-0000-0000000aaa02','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000aa02','active'),
  ('00000000-0000-0000-0000-0000000bbb01','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-00000000bb01','active'),
  ('00000000-0000-0000-0000-0000000aaa03','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000aa03','revoked');
insert into membership_roles (membership_id, role_id)
select m.id, r.id from (values
  ('00000000-0000-0000-0000-0000000aaa01'::uuid,'owner'),
  ('00000000-0000-0000-0000-0000000aaa02'::uuid,'housekeeping'),
  ('00000000-0000-0000-0000-0000000bbb01'::uuid,'owner'),
  ('00000000-0000-0000-0000-0000000aaa03'::uuid,'owner')) as m(id, rk)
  join roles r on r.key = m.rk;

begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ begin
  if (select count(*) from room_types where tenant_id = '00000000-0000-0000-0000-0000000000b1') <> 0
    then raise exception 'FAIL tenant A reads tenant B room types'; end if;
  if (select count(*) from rooms) <> 6 then raise exception 'FAIL owner A should see exactly 6 rooms, got %', (select count(*) from rooms); end if;
  if (select count(*) from properties) <> 1 then raise exception 'FAIL owner A sees other properties'; end if;
  raise notice 'PASS tenant A isolated from tenant B';
end $$;
-- guessed UUID of B's room type
do $$ begin
  if exists (select 1 from room_types where id = '00000000-0000-0000-0000-0000000000b3')
    then raise exception 'FAIL guessed UUID leaked a row'; end if;
  raise notice 'PASS guessed UUID returns nothing';
end $$;
-- cannot update B's rows (RLS filters to zero rows)
do $$ declare n int; begin
  update room_types set base_rate_minor = 1 where id = '00000000-0000-0000-0000-0000000000b3';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL updated another tenant row'; end if;
  raise notice 'PASS cross-tenant update affects 0 rows';
end $$;
-- cannot write claims directly
do $$ begin
  begin
    insert into room_inventory_claims (tenant_id, property_id, room_id, claim_type, start_date, end_date, block_reason)
    select tenant_id, property_id, id, 'block', '2028-01-01', '2028-01-02', 'x' from rooms limit 1;
    raise exception 'FAIL direct claim insert allowed';
  exception when insufficient_privilege then raise notice 'PASS direct claim insert denied';
  end;
end $$;
-- cannot grant themselves roles
do $$ begin
  begin
    insert into membership_roles (membership_id, role_id)
      select '00000000-0000-0000-0000-0000000aaa01', id from roles where key = 'owner';
    raise exception 'FAIL self role grant allowed';
  exception when insufficient_privilege then raise notice 'PASS self role grant denied';
  end;
end $$;
commit;

begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa02';   -- housekeeping
do $$ begin
  if (select count(*) from rooms) <> 6 then raise exception 'FAIL housekeeping cannot see rooms'; end if;
  if (select count(*) from room_types) <> 0 then raise exception 'FAIL housekeeping reads room types and rates'; end if;
  begin
    update rooms set operational_status = 'retired';
    if found then raise exception 'FAIL housekeeping edited rooms'; end if;
  end;
  raise notice 'PASS housekeeping limited to room status view';
end $$;
commit;

begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa03';   -- revoked
do $$ begin
  if (select count(*) from rooms) <> 0 or (select count(*) from properties) <> 0
    then raise exception 'FAIL revoked membership still reads data'; end if;
  raise notice 'PASS revoked membership loses access';
end $$;
commit;

begin;
set local role anon;
do $$ begin
  if (select count(*) from rooms) <> 0 or (select count(*) from tenants) <> 0
    then raise exception 'FAIL anon reads base tables'; end if;
  raise notice 'PASS anon sees nothing';
end $$;
commit;
