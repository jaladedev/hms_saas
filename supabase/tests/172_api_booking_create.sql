-- Creating a booking through the public API (migration 172). Hotel A: tenant a1, property a2, room type a3 (5 rooms), booking site
-- book.hotel-a.test; owner aa01 (api.manage), front desk aa04; hotel B owner bb01. Dates are relative to the hotel's own today, 301 to 330 days
-- ahead, clear of the fixed dates other tests use.
\set ON_ERROR_STOP on

create table t172_ctx (label text primary key, val text not null);
create function t172(p_label text) returns text language sql stable as $$ select val from t172_ctx where label = p_label $$;

create function t172_call(p_key uuid, p_idem text, p_off integer, p_nights integer default 2, p_qty integer default 1,
                          p_guest jsonb default '{"full_name":"Api Guest","email":"api-guest@example.test","phone":"0803 777 0001"}'::jsonb,
                          p_prop uuid default '00000000-0000-0000-0000-0000000000a2', p_room uuid default '00000000-0000-0000-0000-0000000000a3')
returns jsonb language plpgsql as $$
declare v_t date := property_today(p_prop);
begin
  return api_create_booking(p_prop, p_key, p_idem, v_t + p_off, v_t + p_off + p_nights, 2, 0, p_room, p_qty, p_guest, null);
end $$;

-- 1. The new scope
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb; begin
  perform t_sys();
  update api_keys set revoked_at = now() where revoked_at is null;   -- earlier tests leave live keys; at most ten may be live
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format($q$select api_key_create(%L, 'Site', array['bookings.delete'], 60)$q$, v_p), 'POLICY_VIOLATION: scopes');
  perform t_expect(format($q$select api_key_create(%L, 'Site', array['guests.read', 'bookings.write'], 60)$q$, v_p), 'POLICY_VIOLATION: scopes');   -- guests still need bookings.read
  r := api_key_create(v_p, 'Writer', array['bookings.write', 'bookings.write'], 60);
  insert into t172_ctx values ('key_id', r ->> 'key_id'), ('key', r ->> 'key');
  r := api_key_create(v_p, 'Reader', array['availability.read', 'bookings.read'], 60);
  insert into t172_ctx values ('reader_id', r ->> 'key_id');
  perform t_sys();
  if (select scopes from api_keys where id = t172('key_id')::uuid) <> array['bookings.write'] then raise exception 'FAIL scopes %', (select scopes from api_keys where id = t172('key_id')::uuid); end if;
  raise notice 'PASS bookings.write is a scope of its own; unknown scopes and guests.read without bookings.read are still refused';
end $$;

-- 2. Who may call it, and what it refuses
do $$ declare v_key uuid := t172('key_id')::uuid; v_b constant uuid := '00000000-0000-0000-0000-0000000000b2'; v_bk uuid; v_tmp uuid; v_state text; begin
  perform t_sys();
  perform t_expect(format($q$select t172_call(%L, 'idem-a-0001', 301, 2, 1, '{"full_name":"A","email":"x"}'::jsonb)$q$, v_key), 'POLICY_VIOLATION');   -- the hold refuses a bad guest
  perform t_expect(format($q$select t172_call(%L, 'short', 301)$q$, v_key), 'POLICY_VIOLATION: idempotency key');
  perform t_expect(format($q$select t172_call(%L, 'has space in it', 301)$q$, v_key), 'POLICY_VIOLATION: idempotency key');
  perform t_expect(format($q$select t172_call(%L, 'idem-a-0002', 301, 2, 0)$q$, v_key), 'POLICY_VIOLATION: rooms');
  perform t_expect(format($q$select t172_call(%L, 'idem-a-0003', 301, 2, 6)$q$, v_key), 'POLICY_VIOLATION: rooms');
  perform t_expect(format($q$select t172_call(%L, 'idem-a-0004', 301, 2, 1, p_room => %L)$q$, v_key, gen_random_uuid()), 'POLICY_VIOLATION: room type');
  perform t_expect(format($q$select t172_call(%L, 'idem-a-0005', 301)$q$, gen_random_uuid()), 'NOT_FOUND');                      -- unknown key
  perform t_expect(format($q$select t172_call(%L, 'idem-a-0006', 301)$q$, t172('reader_id')), 'NOT_FOUND');                     -- a key without the scope

  -- a key of hotel B cannot book hotel A
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  v_bk := (api_key_create(v_b, 'B writer', array['bookings.write'], 60) ->> 'key_id')::uuid;
  perform t_sys();
  perform t_expect(format($q$select t172_call(%L, 'idem-a-0007', 301)$q$, v_bk), 'NOT_FOUND');
  perform t_expect(format($q$select api_create_booking(%L, %L, 'idem-b-0001', current_date + 301, current_date + 303, 2, 0, %L, 1, '{"full_name":"Bee Guest","email":"b@example.test"}'::jsonb)$q$,
                          '00000000-0000-0000-0000-0000000000a2', v_bk, '00000000-0000-0000-0000-0000000000a3'), 'NOT_FOUND');

  -- a revoked key
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_tmp := (api_key_create('00000000-0000-0000-0000-0000000000a2', 'Temp writer', array['bookings.write'], 60) ->> 'key_id')::uuid;
  perform api_key_revoke(v_tmp);
  perform t_sys();
  perform t_expect(format($q$select t172_call(%L, 'idem-a-0008', 301)$q$, v_tmp), 'NOT_FOUND');

  -- not for logins or anon
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin
    perform t172_call(v_key, 'idem-a-0009', 301);
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  if v_state <> 'refused' then raise exception 'FAIL a login could create an API booking'; end if;
  perform t_sys();
  begin
    set local role anon;
    perform t172_call(v_key, 'idem-a-0010', 301);
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could create an API booking'; end if;
  if (select count(*) from api_booking_requests) <> 0 then raise exception 'FAIL a refused call left a booking'; end if;
  raise notice 'PASS refusals: bad guest, idempotency key, rooms, room type, unknown key, key without the scope, another hotel''s key, revoked key, logins and anon; nothing left behind';
end $$;

-- 3. A booking: held like the website does, recorded, audited; a repeat is the same booking
do $$ declare
  v_key uuid := t172('key_id')::uuid; r jsonb; r2 jsonb; v_res uuid; v_t date := property_today('00000000-0000-0000-0000-0000000000a2'); v_n integer;
begin
  perform t_sys();
  r := t172_call(v_key, 'order-1001-aaa', 301);
  v_res := (r ->> 'reservation_id')::uuid;
  if r ->> 'host' <> 'book.hotel-a.test' or r -> 'booking' ->> 'status' is distinct from 'pending' or (r -> 'booking' ->> 'total_minor')::bigint <= 0
     or r -> 'booking' ->> 'booking_reference' is null or r -> 'booking' ->> 'hold_expires_at' is null then raise exception 'FAIL result %', r; end if;
  insert into t172_ctx values ('res', v_res::text), ('ref', r -> 'booking' ->> 'booking_reference');
  if (select source from reservations where id = v_res) <> 'website' or (select reservation_status from reservations where id = v_res) <> 'pending'
     or (select arrival_date from reservations where id = v_res) <> v_t + 301 or (select departure_date from reservations where id = v_res) <> v_t + 303 then raise exception 'FAIL reservation'; end if;
  if not exists (select 1 from guests g join reservations x on x.primary_guest_id = g.id where x.id = v_res and g.email = 'api-guest@example.test' and g.full_name = 'Api Guest') then raise exception 'FAIL guest not recorded'; end if;
  if (select api_key_id from api_booking_requests where reservation_id = v_res) <> v_key then raise exception 'FAIL request not recorded'; end if;
  if (select count(*) from audit_logs where entity_id = v_res and action = 'api_booking.created' and metadata ->> 'key_prefix' = (select prefix from api_keys where id = v_key)) <> 1 then raise exception 'FAIL audit'; end if;
  if exists (select 1 from audit_logs where entity_id = v_res and metadata::text like '%' || t172('key') || '%') then raise exception 'FAIL the key reached the audit log'; end if;

  -- the same call again: the same booking, no second hold, no second record
  r2 := t172_call(v_key, 'order-1001-aaa', 301);
  if r2 ->> 'reservation_id' <> v_res::text or r2 -> 'booking' ->> 'booking_reference' <> t172('ref') then raise exception 'FAIL repeat gave another booking %', r2; end if;
  if (select count(*) from api_booking_requests where api_key_id = v_key) <> 1 or (select count(*) from audit_logs where entity_id = v_res and action = 'api_booking.created') <> 1 then raise exception 'FAIL repeat recorded twice'; end if;
  select count(*) into v_n from reservation_rooms where reservation_id = v_res;
  if v_n <> 1 then raise exception 'FAIL rooms held %', v_n; end if;
  -- the same key with a different request is refused, not answered with the old booking
  perform t_expect(format($q$select t172_call(%L, 'order-1001-aaa', 302)$q$, v_key), 'IDEMPOTENCY_MISMATCH');
  -- two rooms in one call
  r := t172_call(v_key, 'order-1002-bbb', 305, 2, 2);
  select count(*) into v_n from reservation_rooms where reservation_id = (r ->> 'reservation_id')::uuid;
  if v_n <> 2 then raise exception 'FAIL expected 2 rooms, got %', v_n; end if;
  -- the booking can be read back by the other API functions
  if (api_booking('00000000-0000-0000-0000-0000000000a2', t172('ref'), false) ->> 'reference') <> t172('ref') then raise exception 'FAIL api_booking cannot read it'; end if;
  raise notice 'PASS booking: held as a pending website booking for the key''s hotel, guest recorded, audited without the key, repeat returns the same booking, changed repeat refused, several rooms';
end $$;

-- 4. Rooms taken by one key: at most 20 unpaid holds, and only unpaid ones count
do $$ declare v_key uuid := t172('key_id')::uuid; i integer; r jsonb; v_free uuid; begin
  perform t_sys();
  -- two holds exist already (blocks 3); make 18 more on separate nights
  -- (create_hold itself allows only a few unpaid holds for one guest, so each call is for a different guest)
  for i in 1..18 loop
    perform t172_call(v_key, 'bulk-' || lpad(i::text, 4, '0') || '-xx', 310 + i * 2, 1,
                      p_guest => jsonb_build_object('full_name', 'Bulk Guest', 'email', 'bulk-' || i || '@example.test'));
  end loop;
  if (select count(*) from api_booking_requests r join reservations x on x.id = r.reservation_id where r.api_key_id = v_key and x.reservation_status = 'pending') <> 20 then raise exception 'FAIL setup'; end if;
  perform t_expect(format($q$select t172_call(%L, 'bulk-over-0001', 360, 1, 1, '{"full_name":"Bulk Over","email":"bulk-over@example.test"}'::jsonb)$q$, v_key), 'POLICY_VIOLATION: too many unpaid holds');
  -- a repeat of an earlier call still works at the limit
  r := t172_call(v_key, 'bulk-0001-xx', 312, 1, 1, '{"full_name":"Bulk Guest","email":"bulk-1@example.test"}'::jsonb);
  if r ->> 'reservation_id' is null then raise exception 'FAIL repeat at the limit refused'; end if;
  -- a hold that is cancelled stops counting
  update reservations set reservation_status = 'cancelled' where id = t172('res')::uuid;
  r := t172_call(v_key, 'bulk-over-0002', 360, 1, 1, '{"full_name":"Bulk Over","email":"bulk-over@example.test"}'::jsonb);
  if r ->> 'reservation_id' is null then raise exception 'FAIL not allowed after a hold ended'; end if;
  raise notice 'PASS unpaid holds: 20 at most per key, a repeat is still answered at the limit, a cancelled hold frees a place';
end $$;

-- 5. The table is closed
do $$ declare v_state text; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin
    perform count(*) from api_booking_requests;
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  if v_state <> 'refused' then raise exception 'FAIL a login can read api_booking_requests'; end if;
  perform t_sys();
  raise notice 'PASS api_booking_requests is closed to logins';
end $$;

-- leave the hotels as found
update api_keys set revoked_at = now() where revoked_at is null;
