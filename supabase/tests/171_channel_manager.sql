-- Channel manager, inbound half (migration 171). Reuses t_as / t_sys / t_expect (05).
-- Users: aa01 owner A (channels.manage), aa04 front desk A, bb01 owner of Hotel B. Room type a3 STD has 5 rooms; dates are far ahead so nothing else clashes.
\set ON_ERROR_STOP on

create table t171_ctx (label text primary key, val text not null);
create function t171(p_label text) returns uuid language sql stable as $$ select val::uuid from t171_ctx where label = p_label $$;
create function t171_pay(p_arr integer, p_nights integer, p_name text, p_email text, p_total bigint, p_rooms jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('arrival', (current_date + p_arr)::text, 'departure', (current_date + p_arr + p_nights)::text, 'guest_name', p_name, 'email', p_email, 'phone', '0803', 'total_minor', p_total, 'rooms', p_rooms)
$$;

-- 1. Grants and flag
do $$ declare v_n integer; begin
  perform t_sys();
  select count(*) into v_n from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id where p.key = 'channels.manage' and r.is_system and r.key in ('owner', 'general_manager');
  if v_n <> 2 then raise exception 'FAIL channels.manage grants (%)', v_n; end if;
  if exists (select 1 from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id where p.key = 'channels.manage' and r.is_system and r.key not in ('owner', 'general_manager')) then raise exception 'FAIL held by another system role'; end if;
  if not ('channel_manager' = any (plan_enforced_flags())) then raise exception 'FAIL not an enforced flag'; end if;
  if not (select 'channel_manager' = any (features) from plans where code = 'pro') or (select 'channel_manager' = any (features) from plans where code = 'starter') then raise exception 'FAIL plan features'; end if;
  raise notice 'PASS grants: channels.manage for owner and general manager only; channel_manager is enforced and on the pro plan only';
end $$;

-- 2. Connections and the room map
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb; v_id uuid; v_key text; i integer; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select channel_connection_create(%L, ''booking_com'', ''Booking.com'', ''channel'')', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select channel_connection_create(%L, ''booking_com'', ''Booking.com'', ''channel'')', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select channel_connection_create(%L, ''agoda'', ''X'', ''channel'')', v_p), 'POLICY_VIOLATION: channel');
  perform t_expect(format('select channel_connection_create(%L, ''expedia'', '' '', ''channel'')', v_p), 'POLICY_VIOLATION: label');
  perform t_expect(format('select channel_connection_create(%L, ''expedia'', ''X'', ''nobody'')', v_p), 'POLICY_VIOLATION: collects');
  r := channel_connection_create(v_p, 'booking_com', 'Booking.com', 'channel');
  v_id := r ->> 'connection_id'; v_key := r ->> 'key';
  if v_key !~ '^chn_[0-9a-f]{8}_[0-9a-f]{48}$' then raise exception 'FAIL key shape %', v_key; end if;
  insert into t171_ctx values ('conn', v_id::text), ('key', v_key);
  begin perform key_hash from channel_connections; raise exception 'FAIL key_hash readable';
  exception when insufficient_privilege then null; end;
  perform t_sys();
  if (select key_hash from channel_connections where id = v_id) <> encode(sha256(convert_to(v_key, 'UTF8')), 'hex') or exists (select 1 from channel_connections where key_hash = v_key) then raise exception 'FAIL only the hash is stored'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select channel_map_set(%L, ''DBL-1'', %L)', v_id, '00000000-0000-0000-0000-0000000000b3'), 'POLICY_VIOLATION: room type');
  perform t_expect(format('select channel_map_set(%L, '' '', %L)', v_id, '00000000-0000-0000-0000-0000000000a3'), 'POLICY_VIOLATION: code');
  perform channel_map_set(v_id, 'DBL-1', '00000000-0000-0000-0000-0000000000a3');
  perform channel_map_set(v_id, 'DBL-1', '00000000-0000-0000-0000-0000000000a4');   -- remap
  perform channel_map_set(v_id, 'DBL-1', '00000000-0000-0000-0000-0000000000a3');
  perform channel_map_set(v_id, 'TMP', '00000000-0000-0000-0000-0000000000a4');
  perform channel_map_remove(v_id, 'TMP');
  if (select count(*) from channel_room_map where connection_id = v_id) <> 1 then raise exception 'FAIL map count'; end if;
  for i in 1..4 loop perform channel_connection_create(v_p, 'other', 'Extra ' || i, 'hotel'); end loop;
  perform t_expect(format('select channel_connection_create(%L, ''other'', ''Too many'', ''hotel'')', v_p), 'POLICY_VIOLATION: too many');
  -- the other four are not needed: revoke them so the limit is not in the way later
  perform t_sys();
  update channel_connections set status = 'revoked' where label like 'Extra %';
  raise notice 'PASS setup: channels.manage only, key shown once and only its hash kept, hash unreadable, map checks the hotel''s own room types, five live connections at most';
end $$;

-- 3. Authenticating a connection
do $$ declare v_h text := encode(sha256(convert_to((select val from t171_ctx where label = 'key'), 'UTF8')), 'hex'); v_c constant uuid := null; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin perform channel_authenticate(v_h); raise exception 'FAIL staff can authenticate a connection'; exception when insufficient_privilege then null; end;
  perform t_sys();
  if channel_authenticate(v_h) ->> 'ok' <> 'true' or channel_authenticate(v_h) ->> 'property_id' <> '00000000-0000-0000-0000-0000000000a2' then raise exception 'FAIL authenticate'; end if;
  if channel_authenticate('00') ->> 'ok' <> 'false' then raise exception 'FAIL wrong hash'; end if;
  if (select last_inbound_at from channel_connections where id = t171('conn')) is null then raise exception 'FAIL last_inbound_at'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform channel_connection_set(t171('conn'), 'paused');
  perform t_sys();
  if channel_authenticate(v_h) ->> 'ok' <> 'false' then raise exception 'FAIL paused connection authenticates'; end if;
  perform t_expect(format('select channel_receive(%L, ''booking'', ''P-1'', %L)', t171('conn'), t171_pay(300, 2, 'Ada', 'ada@x.test', 1, '[]')), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform channel_connection_set(t171('conn'), 'active');
  perform t_sys();
  if channel_authenticate(v_h) ->> 'ok' <> 'true' then raise exception 'FAIL active again'; end if;
  raise notice 'PASS authenticate: service role only, active connections only, paused ones are refused and can be switched back on';
end $$;

-- 4. Importing bookings
do $$ declare v_c uuid := t171('conn'); r jsonb; v_res uuid; v_g1 uuid; v_n integer; v_rooms jsonb := '[{"external_room_id":"DBL-1","adults":2,"children":0}]'; begin
  perform t_sys();
  r := channel_receive(v_c, 'booking', 'EXT-1', t171_pay(300, 2, 'Ada Obi', 'Ada@X.test', 1, v_rooms));
  if r ->> 'status' <> 'imported' or (r ->> 'duplicate')::boolean then raise exception 'FAIL import %', r; end if;
  select reservation_id into v_res from channel_bookings where connection_id = v_c and external_id = 'EXT-1';
  if (select source || reservation_status from reservations where id = v_res) <> 'partnerconfirmed' then raise exception 'FAIL reservation made'; end if;
  if (select arrival_date from reservations where id = v_res) <> current_date + 300 or (select departure_date from reservations where id = v_res) <> current_date + 302 then raise exception 'FAIL dates'; end if;
  if (select summary ? '_email' from channel_bookings where connection_id = v_c and external_id = 'EXT-1') then raise exception 'FAIL email left in the booking row'; end if;
  select primary_guest_id into v_g1 from reservations where id = v_res;
  if (select email from guests where id = v_g1) <> 'ada@x.test' then raise exception 'FAIL guest email'; end if;
  insert into t171_ctx values ('res1', v_res::text);
  -- the same booking again changes nothing
  r := channel_receive(v_c, 'booking', 'EXT-1', t171_pay(300, 2, 'Ada Obi', 'ada@x.test', 1, v_rooms));
  if r ->> 'status' <> 'imported' or not (r ->> 'duplicate')::boolean then raise exception 'FAIL repeat %', r; end if;
  select count(*) into v_n from reservations where primary_guest_id = v_g1; if v_n <> 1 then raise exception 'FAIL repeat made another booking'; end if;
  -- the same guest by email on another booking is one guest
  r := channel_receive(v_c, 'booking', 'EXT-2', t171_pay(310, 1, 'Ada Obi', 'ada@x.test', 2500000, v_rooms));
  if (select primary_guest_id from reservations where id = (select reservation_id from channel_bookings where external_id = 'EXT-2')) <> v_g1 then raise exception 'FAIL guest reuse'; end if;
  -- an unmapped room code fails with a reason and makes nothing
  select count(*) into v_n from reservations where source = 'partner';
  r := channel_receive(v_c, 'booking', 'EXT-3', t171_pay(320, 1, 'Ben', 'ben@x.test', 5, '[{"external_room_id":"SUITE-9","adults":1}]'));
  if r ->> 'status' <> 'failed' or (select error from channel_bookings where external_id = 'EXT-3') <> 'POLICY_VIOLATION: unmapped room' or (select count(*) from reservations where source = 'partner') <> v_n then raise exception 'FAIL unmapped %', r; end if;
  -- no room left: two rooms of a type that has one; nothing half-made
  insert into room_types (id, tenant_id, property_id, name, code, slug, max_adults, max_occupancy, base_rate_minor)
  values ('00000000-0000-0000-0000-000000171001', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'Chan One', 'CH1', 'chan-one', 2, 2, 1000000);
  insert into rooms (tenant_id, property_id, room_type_id, room_number) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000171001', '901');
  insert into channel_room_map (connection_id, external_room_id, room_type_id) values (v_c, 'ONE', '00000000-0000-0000-0000-000000171001');
  r := channel_receive(v_c, 'booking', 'EXT-4', t171_pay(330, 1, 'Cy', 'cy@x.test', 5, '[{"external_room_id":"ONE","adults":1},{"external_room_id":"ONE","adults":1}]'));
  if r ->> 'status' <> 'failed' or (select reservation_id from channel_bookings where external_id = 'EXT-4') is not null or (select count(*) from reservations where source = 'partner') <> v_n then raise exception 'FAIL no room %', r; end if;
  -- partner bookings only: other tests book at current_date + 30 + random() * 300 (128, 129), which is +330 about once in 150 runs
  if exists (select 1 from reservations where source = 'partner' and arrival_date = current_date + 330) then raise exception 'FAIL half-made booking'; end if;
  -- bad input is refused outright and stores nothing
  perform t_expect(format('select channel_receive(%L, ''booking'', ''BAD'', %L)', v_c, jsonb_build_object('arrival', 'soon')), 'POLICY_VIOLATION: payload');
  perform t_expect(format('select channel_receive(%L, ''booking'', ''BAD'', %L)', v_c, t171_pay(300, 40, 'X', null, 1, v_rooms)), 'POLICY_VIOLATION: payload');
  perform t_expect(format('select channel_receive(%L, ''refund'', ''BAD'', ''{}'')', v_c), 'POLICY_VIOLATION: event');
  if exists (select 1 from channel_bookings where external_id = 'BAD') then raise exception 'FAIL bad input stored'; end if;
  -- fix the map and retry the unmapped one from the screen's function
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform channel_map_set(v_c, 'SUITE-9', '00000000-0000-0000-0000-0000000000a4');
  perform t_expect(format('select channel_retry(%L)', (select id from channel_bookings where external_id = 'EXT-1')), 'INVALID_STATE: imported');
  r := channel_retry((select id from channel_bookings where external_id = 'EXT-3'));
  if r ->> 'status' <> 'imported' or (select reservation_id from channel_bookings where external_id = 'EXT-3') is null then raise exception 'FAIL retry %', r; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select channel_retry(%L)', (select id from channel_bookings where external_id = 'EXT-4')), 'NOT_FOUND');
  raise notice 'PASS import: same code as every booking, repeats and guests reused, unmapped and full rooms fail cleanly with a reason, bad input stores nothing, retry works';
end $$;

-- 5. Cancel, modify, resolve
do $$ declare v_c uuid := t171('conn'); r jsonb; v_res uuid; v_rooms jsonb := '[{"external_room_id":"DBL-1","adults":2}]'; begin
  perform t_sys();
  r := channel_receive(v_c, 'cancel', 'EXT-1', '{}');
  if r ->> 'status' <> 'cancelled' or (select reservation_status from reservations where id = t171('res1')) <> 'cancelled' then raise exception 'FAIL cancel %', r; end if;
  if (select cancellation_charge_minor from reservations where id = t171('res1')) <> 0 then raise exception 'FAIL charge not waived'; end if;
  if not (channel_receive(v_c, 'cancel', 'EXT-1', '{}') ->> 'duplicate')::boolean then raise exception 'FAIL cancel twice'; end if;
  if channel_receive(v_c, 'cancel', 'EXT-NEW', '{}') ->> 'status' <> 'cancelled' or (select reservation_id from channel_bookings where external_id = 'EXT-NEW') is not null then raise exception 'FAIL cancel before received'; end if;
  -- a booking already in house cannot be cancelled by the channel: attention
  r := channel_receive(v_c, 'booking', 'EXT-5', t171_pay(340, 1, 'Di', 'di@x.test', 2500000, v_rooms));
  select reservation_id into v_res from channel_bookings where external_id = 'EXT-5';
  update reservations set reservation_status = 'checked_in' where id = v_res;
  r := channel_receive(v_c, 'cancel', 'EXT-5', '{}');
  if r ->> 'status' <> 'attention' or (select reservation_status from reservations where id = v_res) <> 'checked_in' then raise exception 'FAIL cancel in house %', r; end if;
  -- a change is never applied by itself
  r := channel_receive(v_c, 'booking', 'EXT-6', t171_pay(350, 1, 'Ed', 'ed@x.test', 2500000, v_rooms));
  r := channel_receive(v_c, 'modify', 'EXT-6', t171_pay(351, 2, 'Ed', 'ed@x.test', 5000000, v_rooms));
  if r ->> 'status' <> 'attention' or (select arrival_date from reservations where id = (select reservation_id from channel_bookings where external_id = 'EXT-6')) <> current_date + 350 then raise exception 'FAIL modify %', r; end if;
  -- people resolve items by hand
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select channel_resolve(%L, ''x'')', (select id from channel_bookings where external_id = 'EXT-6')), 'POLICY_VIOLATION: note');
  perform channel_resolve((select id from channel_bookings where external_id = 'EXT-6'), 'Moved the booking by hand');
  perform t_expect(format('select channel_resolve(%L, ''done again'')', (select id from channel_bookings where external_id = 'EXT-6')), 'INVALID_STATE: resolved');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select channel_resolve(%L, ''not allowed'')', (select id from channel_bookings where external_id = 'EXT-5')), 'NOT_FOUND');
  raise notice 'PASS cancel and modify: a cancel applies with the charge waived and is replay-safe, in-house stays go to attention, a change is never applied by itself, resolved by hand with a note';
end $$;

-- 6. Reconciliation
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select channel_sync_report(%L)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  -- EXT-2 is imported at our price; make the channel's total differ
  perform t_sys();
  update channel_bookings set channel_total_minor = 1 where external_id = 'EXT-2';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := channel_sync_report(v_p);
  if (r -> 'counts' ->> 'imported')::int <> 2 or (r -> 'counts' ->> 'cancelled')::int <> 2 or (r -> 'counts' ->> 'attention')::int <> 1 or (r -> 'counts' ->> 'resolved')::int <> 1 or (r -> 'counts' ->> 'failed')::int <> 1 then raise exception 'FAIL counts %', r -> 'counts'; end if;
  if not exists (select 1 from jsonb_array_elements(r -> 'price_differences') e where e ->> 'external_id' = 'EXT-2') then raise exception 'FAIL price difference missing'; end if;
  if exists (select 1 from jsonb_array_elements(r -> 'price_differences') e where e ->> 'external_id' = 'EXT-1') then raise exception 'FAIL cancelled booking listed as a price difference'; end if;
  -- cancelled here but still live at the channel
  perform cancel_reservation((select reservation_id from channel_bookings where external_id = 'EXT-2'), 'Guest called the hotel', 'rec-1');
  r := channel_sync_report(v_p);
  if not exists (select 1 from jsonb_array_elements(r -> 'cancelled_here') e where e ->> 'external_id' = 'EXT-2') then raise exception 'FAIL cancelled here %', r -> 'cancelled_here'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select channel_sync_report(%L)', v_p), 'NOT_FOUND');
  if (select count(*) from channel_bookings) <> 0 or (select count(*) from channel_connections) <> 0 then raise exception 'FAIL other hotel reads channel data'; end if;
  raise notice 'PASS reconciliation: counts by status, price differences against the channel''s total, bookings cancelled here but live there, hotel-private';
end $$;

-- 7. Revoking, and the flag
do $$ declare v_c uuid := t171('conn'); v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_h text := encode(sha256(convert_to((select val from t171_ctx where label = 'key'), 'UTF8')), 'hex'); begin
  perform t_sys();
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values (v_t, 'channel_manager', false);
  if channel_authenticate(v_h) ->> 'ok' <> 'false' then raise exception 'FAIL authenticate with the flag off'; end if;
  perform t_expect(format('select channel_receive(%L, ''booking'', ''F-1'', ''{}'')', v_c), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select channel_connection_create(%L, ''other'', ''Nope'', ''hotel'')', v_p), 'POLICY_VIOLATION: channels off');
  perform t_expect(format('select channel_map_set(%L, ''Z'', %L)', v_c, '00000000-0000-0000-0000-0000000000a3'), 'POLICY_VIOLATION: channels off');
  perform t_expect(format('select channel_retry(%L)', (select id from channel_bookings where external_id = 'EXT-4')), 'POLICY_VIOLATION: channels off');
  if channel_sync_report(v_p) is null then raise exception 'FAIL report with the flag off'; end if;
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = v_t and feature_key = 'channel_manager';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform channel_connection_set(v_c, 'revoked');
  perform t_expect(format('select channel_connection_set(%L, ''active'')', v_c), 'INVALID_STATE: revoked');
  perform t_expect(format('select channel_retry(%L)', (select id from channel_bookings where external_id = 'EXT-4')), 'INVALID_STATE: revoked');
  perform t_sys();
  if channel_authenticate(v_h) ->> 'ok' <> 'false' then raise exception 'FAIL revoked key authenticates'; end if;
  raise notice 'PASS flag and revoke: off stops imports, setup and retries but reads work; a revoked key is dead for good';
end $$;
