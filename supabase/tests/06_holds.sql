-- resolve_host and create_hold: host-based tenancy, service_role-only access, validation,
-- idempotency, guest reuse, hold caps, expiry, multi-room and all-or-nothing behaviour.
-- Dates are relative to today so the suite keeps working as time passes.
-- Needs users from 03_security.sql (aa01 owner of Hotel A) and the 04 tax fixture.
-- Ids: a2 property A, a3 STD type (5 rooms), a4 SOLO type (1 room), a6 default plan, b3 Hotel B's type.
\set ON_ERROR_STOP on

-- Fixtures (superuser): domains for A (verified, unverified), B (tenant-wide) and a tenant with two properties
insert into tenant_domains (tenant_id, property_id, host, verified_at) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'book.hotel-a.test', now()),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'draft.hotel-a.test', null),
  ('00000000-0000-0000-0000-0000000000b1', null, 'hotel-b.test', now());
insert into tenants (id, name, slug) values ('00000000-0000-0000-0000-0000000000c1', 'Hotel C', 'hotel-c');
insert into properties (id, tenant_id, name, code) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c1', 'Hotel C One', 'HC1'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c1', 'Hotel C Two', 'HC2');
insert into tenant_domains (tenant_id, property_id, host, verified_at)
values ('00000000-0000-0000-0000-0000000000c1', null, 'multi.test', now());

create table t06_out (label text, result jsonb);
grant all on t06_out to service_role;

create function t06_hold(
  p_host text default 'book.hotel-a.test', p_off integer default 10, p_nights integer default 2,
  p_rooms jsonb default '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":2}]'::jsonb,
  p_guest jsonb default '{"full_name":"Test Guest","email":"guest@example.com"}'::jsonb,
  p_key text default null
) returns jsonb language plpgsql as $$
begin
  return create_hold(p_host, current_date + p_off, current_date + p_off + p_nights, p_rooms, p_guest,
                     coalesce(p_key, gen_random_uuid()::text));
end $$;

-- Runs a statement that must fail; the error message must match the LIKE pattern.
create function t06_expect_err(p_sql text, p_like text) returns void language plpgsql as $$
declare v text;
begin
  begin execute p_sql; exception when others then v := sqlerrm; end;
  if v is null then raise exception 'FAIL expected error like % but it succeeded: %', p_like, p_sql; end if;
  if v not like p_like then raise exception 'FAIL expected error like % but got %', p_like, v; end if;
end $$;

-- Race helper: one hold for a unique guest, retrying on deadlock as the caller should.
create function test_try_hold(p_label text, p_off integer, p_nights integer, p_rooms jsonb)
returns boolean language plpgsql as $$
declare attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      perform t06_hold('book.hotel-a.test', p_off, p_nights, p_rooms,
                       jsonb_build_object('full_name', 'Race Guest', 'email', 'race-' || gen_random_uuid() || '@example.com'));
      insert into test_results (label, ok) values (p_label, true);
      return true;
    exception
      when deadlock_detected or serialization_failure then
        if attempt >= 3 then raise; end if;
      when sqlstate 'P0001' then
        if sqlerrm like 'ROOM_UNAVAILABLE%' then
          insert into test_results (label, ok) values (p_label, false);
          return false;
        end if;
        raise;
    end;
  end loop;
end $$;

-- 1. Host resolution
do $$ declare r record; begin
  select * into r from resolve_host('book.hotel-a.test');
  if r.tenant_id <> '00000000-0000-0000-0000-0000000000a1' or r.property_id <> '00000000-0000-0000-0000-0000000000a2'
    then raise exception 'FAIL host a: %', r; end if;
  select * into r from resolve_host('  BOOK.Hotel-A.test:8443 ');
  if r.property_id <> '00000000-0000-0000-0000-0000000000a2' then raise exception 'FAIL host case or port: %', r; end if;
  select * into r from resolve_host('hotel-b.test');
  if r.property_id <> '00000000-0000-0000-0000-0000000000b2' then raise exception 'FAIL tenant-wide domain, single property: %', r; end if;
  perform t06_expect_err($q$select * from resolve_host('draft.hotel-a.test')$q$, 'NOT_FOUND: host%');
  perform t06_expect_err($q$select * from resolve_host('nobody.example')$q$, 'NOT_FOUND: host%');
  perform t06_expect_err($q$select * from resolve_host(null)$q$, 'NOT_FOUND: host%');
  perform t06_expect_err($q$select * from resolve_host('multi.test')$q$, 'NOT_FOUND: property%');
  update tenants set status = 'suspended' where id = '00000000-0000-0000-0000-0000000000b1';
  perform t06_expect_err($q$select * from resolve_host('hotel-b.test')$q$, 'NOT_FOUND: host%');
  update tenants set status = 'active' where id = '00000000-0000-0000-0000-0000000000b1';
  raise notice 'PASS host resolution: verified only, port and case ignored, ambiguity and suspended tenants refused';
end $$;

-- 2. The way production calls it: PostgREST connects as authenticator, switches to service_role,
--    and carries the role in the verified JWT claims. A bogus rate_plan_id must be ignored.
begin;
set local session authorization authenticator;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
insert into t06_out values ('svc', t06_hold(p_off => 12, p_nights => 3,
  p_rooms => '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":2,"rate_plan_id":"00000000-0000-0000-0000-00000000dead","room_id":"x"}]'::jsonb,
  p_guest => '{"full_name":"Chidi Eze","email":"Chidi@Example.com","phone":"+2348011111111"}'::jsonb));
commit;
do $$ declare r jsonb; v_res uuid; v_exp timestamptz; begin
  select result into r from t06_out where label = 'svc';
  v_res := (r ->> 'reservation_id')::uuid;
  if r ->> 'status' <> 'pending' or (r ->> 'booking_reference') not like 'BK-%' then raise exception 'FAIL status/ref %', r; end if;
  v_exp := (r ->> 'hold_expires_at')::timestamptz;
  if v_exp < now() + interval '19 minutes' or v_exp > now() + interval '21 minutes' then raise exception 'FAIL hold expiry %', v_exp; end if;
  if (r ->> 'total_minor')::bigint <> (r ->> 'subtotal_minor')::bigint + (r ->> 'tax_minor')::bigint or r ->> 'currency' <> 'NGN'
    then raise exception 'FAIL totals %', r; end if;
  if (r -> 'rooms' -> 0) ? 'claim_id' or (r -> 'rooms' -> 0) ? 'room_id' then raise exception 'FAIL internal ids leaked %', r; end if;
  if (select count(*) from room_inventory_claims c join reservation_rooms rr on rr.id = c.reservation_room_id
       where rr.reservation_id = v_res and c.claim_type = 'hold' and c.status = 'active') <> 1 then raise exception 'FAIL hold claim'; end if;
  if (select rate_plan_id from reservation_rooms where reservation_id = v_res) <> '00000000-0000-0000-0000-0000000000a6'
    then raise exception 'FAIL caller chose the rate plan'; end if;
  if not exists (select 1 from guests g join reservations r2 on r2.primary_guest_id = g.id
                  where r2.id = v_res and g.email = 'chidi@example.com' and g.full_name = 'Chidi Eze' and g.phone = '+2348011111111')
    then raise exception 'FAIL guest not created as given'; end if;
  if not exists (select 1 from audit_logs where entity_id = v_res and action = 'hold.created' and actor_user_id is null)
    then raise exception 'FAIL hold audit'; end if;
  raise notice 'PASS service_role through PostgREST makes a pending 20 minute hold, default rate plan, no internal ids';
end $$;

-- 3. Nobody else can reach it: signed-in staff, anon, and a client claiming service_role
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ begin
  begin perform t06_hold(p_off => 14); raise exception 'FAIL authenticated staff called create_hold';
  exception when insufficient_privilege then null; end;
  begin perform resolve_host('book.hotel-a.test'); raise exception 'FAIL authenticated called resolve_host';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
begin;
set local role anon;
set local request.jwt.claims = '{"role":"service_role"}';
do $$ begin
  begin perform t06_hold(p_off => 14); raise exception 'FAIL anon called create_hold';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
do $$ begin raise notice 'PASS create_hold and resolve_host are closed to authenticated and anon callers'; end $$;

-- 4. Validation: nothing is written when a request is refused
do $$ begin
  perform t06_expect_err($q$select t06_hold(p_guest => '{"full_name":"Ok Name","email":"nope"}'::jsonb)$q$, 'POLICY_VIOLATION: guest email%');
  perform t06_expect_err($q$select t06_hold(p_guest => '{"full_name":"A","email":"a@example.com"}'::jsonb)$q$, 'POLICY_VIOLATION: guest name%');
  perform t06_expect_err($q$select t06_hold(p_guest => null)$q$, 'POLICY_VIOLATION: guest%');
  perform t06_expect_err($q$select t06_hold(p_nights => 31)$q$, 'POLICY_VIOLATION: stay too long%');
  perform t06_expect_err($q$select t06_hold(p_nights => 0)$q$, 'POLICY_VIOLATION: departure must follow arrival%');
  perform t06_expect_err($q$select t06_hold(p_off => 400)$q$, 'POLICY_VIOLATION: arrival too far ahead%');
  perform t06_expect_err($q$select t06_hold(p_rooms => '[]'::jsonb)$q$, 'POLICY_VIOLATION: rooms must be%');
  perform t06_expect_err($q$select t06_hold(p_rooms => '{}'::jsonb)$q$, 'POLICY_VIOLATION: rooms must be%');
  perform t06_expect_err($q$select t06_hold(p_rooms => (select jsonb_agg('{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":1}'::jsonb) from generate_series(1,6)))$q$, 'POLICY_VIOLATION: rooms must be%');
  perform t06_expect_err($q$select t06_hold(p_rooms => '[{"room_type_id":"not-a-uuid","adults":1}]'::jsonb)$q$, 'POLICY_VIOLATION: rooms%');
  perform t06_expect_err($q$select t06_hold(p_rooms => '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":3}]'::jsonb)$q$, 'CAPACITY_EXCEEDED%');
  perform t06_expect_err($q$select create_hold('book.hotel-a.test', current_date + 10, current_date + 12, '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":1}]'::jsonb, '{"full_name":"Ok Name","email":"ok@example.com"}'::jsonb, '')$q$, 'POLICY_VIOLATION: idempotency key required%');
  perform t06_expect_err($q$select t06_hold(p_host => 'draft.hotel-a.test')$q$, 'NOT_FOUND: host%');
  perform t06_expect_err($q$select t06_hold(p_host => 'multi.test')$q$, 'NOT_FOUND: property%');
  -- another hotel's room type through this hotel's host, and ours through theirs
  perform t06_expect_err($q$select t06_hold(p_rooms => '[{"room_type_id":"00000000-0000-0000-0000-0000000000b3","adults":1}]'::jsonb)$q$, 'NOT_FOUND: room type%');
  perform t06_expect_err($q$select t06_hold(p_host => 'hotel-b.test')$q$, 'NOT_FOUND: room type%');
  -- non-public room types cannot be booked online, and a chosen physical room is ignored
  update room_types set is_public = false where id = '00000000-0000-0000-0000-0000000000a3';
  perform t06_expect_err($q$select t06_hold()$q$, 'NOT_FOUND: room type%');
  update room_types set is_public = true where id = '00000000-0000-0000-0000-0000000000a3';
  perform t06_hold(p_off => 13, p_rooms => ('[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":1,"requested_room_id":"' || (select id from rooms where room_type_id = '00000000-0000-0000-0000-0000000000a3' order by room_number desc limit 1) || '"}]')::jsonb,
                  p_guest => '{"full_name":"Room Picker","email":"picker@example.com"}'::jsonb);
  if (select requested_room_id from reservation_rooms rr join reservations r on r.id = rr.reservation_id join guests g on g.id = r.primary_guest_id where g.email = 'picker@example.com') is not null
    then raise exception 'FAIL guest chose a physical room'; end if;
  -- refused late (arrival in the past, caught inside create_reservation): the guest row rolls back too
  perform t06_expect_err($q$select t06_hold(p_off => -3, p_guest => '{"full_name":"Late Guest","email":"late@example.com"}'::jsonb)$q$, 'POLICY_VIOLATION: arrival in the past%');
  if exists (select 1 from guests where email = 'late@example.com') then raise exception 'FAIL refused hold left a guest behind'; end if;
  raise notice 'PASS validation, cross-tenant room types and late refusals leave nothing behind';
end $$;

-- 5. Idempotency and guest reuse
do $$ declare a jsonb; b jsonb; c jsonb; v_guest uuid; begin
  a := t06_hold(p_off => 16, p_key => 'hold-key-0001', p_guest => '{"full_name":"Ngozi Obi","email":"ngozi@example.com"}'::jsonb);
  b := t06_hold(p_off => 16, p_key => 'hold-key-0001', p_guest => '{"full_name":"Ngozi Obi","email":"ngozi@example.com"}'::jsonb);
  if a <> b then raise exception 'FAIL replay differs: % vs %', a, b; end if;
  if (select count(*) from reservations where id = (a ->> 'reservation_id')::uuid) <> 1
     or (select count(*) from guests where email = 'ngozi@example.com') <> 1 then raise exception 'FAIL replay duplicated rows'; end if;
  perform t06_expect_err($q$select t06_hold(p_off => 17, p_key => 'hold-key-0001', p_guest => '{"full_name":"Ngozi Obi","email":"ngozi@example.com"}'::jsonb)$q$, 'IDEMPOTENCY_MISMATCH%');
  -- same email, new request: same guest, name not rewritten
  c := t06_hold(p_off => 18, p_guest => '{"full_name":"Someone Else","email":"NGOZI@example.com"}'::jsonb);
  select primary_guest_id into v_guest from reservations where id = (a ->> 'reservation_id')::uuid;
  if (select primary_guest_id from reservations where id = (c ->> 'reservation_id')::uuid) <> v_guest
     or (select full_name from guests where id = v_guest) <> 'Ngozi Obi' then raise exception 'FAIL guest reuse'; end if;
  raise notice 'PASS idempotent replay, key mismatch, guest reused by email without being rewritten';
end $$;

-- 6. Live holds per email are capped; an expired hold stops counting
do $$ declare r jsonb; v_first uuid; begin
  r := t06_hold(p_off => 80, p_guest => '{"full_name":"Cap Guest","email":"cap@example.com"}'::jsonb); v_first := (r ->> 'reservation_id')::uuid;
  perform t06_hold(p_off => 85, p_guest => '{"full_name":"Cap Guest","email":"cap@example.com"}'::jsonb);
  perform t06_hold(p_off => 90, p_guest => '{"full_name":"Cap Guest","email":"cap@example.com"}'::jsonb);
  perform t06_expect_err($q$select t06_hold(p_off => 95, p_guest => '{"full_name":"Cap Guest","email":"cap@example.com"}'::jsonb)$q$, 'POLICY_VIOLATION: too many active holds%');
  update room_inventory_claims set hold_expires_at = now() - interval '1 minute'
   where reservation_room_id in (select id from reservation_rooms where reservation_id = v_first);
  perform t06_hold(p_off => 95, p_guest => '{"full_name":"Cap Guest","email":"cap@example.com"}'::jsonb);
  raise notice 'PASS three live holds per email, expired holds stop counting';
end $$;

-- 7. One-room type: second guest is refused, an expired hold frees the room, a refused hold writes nothing
do $$ declare r jsonb; v_res uuid; solo jsonb := '[{"room_type_id":"00000000-0000-0000-0000-0000000000a4","adults":2}]'; begin
  r := t06_hold(p_off => 100, p_rooms => solo::jsonb, p_guest => '{"full_name":"First Guest","email":"first@example.com"}'::jsonb);
  v_res := (r ->> 'reservation_id')::uuid;
  perform t06_expect_err(format($q$select t06_hold(p_off => 100, p_rooms => %L::jsonb, p_guest => '{"full_name":"Second Guest","email":"second@example.com"}'::jsonb)$q$, solo), 'ROOM_UNAVAILABLE%');
  if exists (select 1 from guests where email = 'second@example.com') then raise exception 'FAIL refused hold left a guest behind'; end if;
  update room_inventory_claims set hold_expires_at = now() - interval '1 minute'
   where reservation_room_id in (select id from reservation_rooms where reservation_id = v_res);
  perform t06_hold(p_off => 100, p_rooms => solo::jsonb, p_guest => '{"full_name":"Second Guest","email":"second@example.com"}'::jsonb);
  raise notice 'PASS last room held once, freed when the hold lapses, refusals roll back the guest';
end $$;

-- 8. Multi-room: two rooms priced and held together, all-or-nothing
do $$ declare r jsonb; v_res uuid; two jsonb := '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":2},{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":1}]';
  bad jsonb := '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":2},{"room_type_id":"00000000-0000-0000-0000-0000000000a4","adults":1},{"room_type_id":"00000000-0000-0000-0000-0000000000a4","adults":1}]'; begin
  r := t06_hold(p_off => 105, p_nights => 2, p_rooms => two, p_guest => '{"full_name":"Group Guest","email":"group@example.com"}'::jsonb);
  v_res := (r ->> 'reservation_id')::uuid;
  if jsonb_array_length(r -> 'rooms') <> 2 or (r ->> 'subtotal_minor')::bigint <> 2 * 2 * 2500000 then raise exception 'FAIL multi-room hold %', r; end if;
  if (select count(*) from room_inventory_claims c join reservation_rooms rr on rr.id = c.reservation_room_id
       where rr.reservation_id = v_res and c.claim_type = 'hold' and c.status = 'active') <> 2 then raise exception 'FAIL two hold claims'; end if;
  -- second SOLO room does not exist: the whole request fails, including the STD room it already priced
  perform t06_expect_err(format($q$select t06_hold(p_off => 108, p_rooms => %L::jsonb, p_guest => '{"full_name":"Aon Guest","email":"aon@example.com"}'::jsonb)$q$, bad), 'ROOM_UNAVAILABLE%');
  if exists (select 1 from reservations r2 join guests g on g.id = r2.primary_guest_id where g.email = 'aon@example.com')
     or exists (select 1 from guests where email = 'aon@example.com') then raise exception 'FAIL partial multi-room hold'; end if;
  raise notice 'PASS multi-room hold is priced and claimed together, all-or-nothing';
end $$;
