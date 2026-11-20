-- Public API and webhooks (migration 158). Reuses t_as / t_sys / t_expect / t_book / t_rr (05) and t21_free_room / t21_room (21).
-- Users: aa01 owner A (api.manage), aa04 front desk A (no api.manage), bb01 owner of Hotel B. Hotel A's booking site is book.hotel-a.test (06).
\set ON_ERROR_STOP on

create table t158_ctx (label text primary key, val text not null);
create function t158(p_label text) returns text language sql stable as $$ select val from t158_ctx where label = p_label $$;
create function t158_audits(p_action text, p_entity uuid) returns bigint language sql stable as $$ select count(*) from audit_logs where action = p_action and entity_id = p_entity $$;
create function t158_hash(p_key text) returns text language sql immutable as $$ select encode(sha256(convert_to(p_key, 'UTF8')), 'hex') $$;

-- 1. Grants and flag
do $$ declare v_n integer; begin
  perform t_sys();
  select count(*) into v_n from role_permissions rp join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
   where p.key = 'api.manage' and r.is_system and r.key in ('owner', 'general_manager');
  if v_n <> 2 then raise exception 'FAIL api.manage grants (%)', v_n; end if;
  if exists (select 1 from role_permissions rp join permissions p on p.id = rp.permission_id join roles r on r.id = rp.role_id
              where p.key = 'api.manage' and r.is_system and r.key not in ('owner', 'general_manager')) then raise exception 'FAIL api.manage given to another system role'; end if;
  if not ('api_access' = any (plan_enforced_flags())) then raise exception 'FAIL api_access is not an enforced flag'; end if;
  if not (select 'api_access' = any (features) from plans where code = 'pro') or (select 'api_access' = any (features) from plans where code = 'starter') then raise exception 'FAIL plan features'; end if;
  raise notice 'PASS grants: api.manage for owner and general manager only; api_access is enforced and on the pro plan only';
end $$;

-- 2. Keys: who may make them, what is stored, what can be read
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb; v_key text; v_id uuid; i integer;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select api_key_create(%L, ''Site'', array[''availability.read''], 60)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select api_key_create(%L, ''Site'', array[''availability.read''], 60)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select api_key_create(%L, '''', array[''availability.read''], 60)', v_p), 'POLICY_VIOLATION: name');
  perform t_expect(format('select api_key_create(%L, ''Site'', array[]::text[], 60)', v_p), 'POLICY_VIOLATION: scopes');
  perform t_expect(format('select api_key_create(%L, ''Site'', array[''bookings.write''], 60)', v_p), 'POLICY_VIOLATION: scopes');
  perform t_expect(format('select api_key_create(%L, ''Site'', array[''guests.read''], 60)', v_p), 'POLICY_VIOLATION: scopes');   -- guests need bookings
  perform t_expect(format('select api_key_create(%L, ''Site'', array[''availability.read''], 0)', v_p), 'POLICY_VIOLATION: limit');
  r := api_key_create(v_p, 'Booking widget', array['availability.read', 'bookings.read', 'guests.read', 'bookings.read'], 60);
  v_key := r ->> 'key'; v_id := (r ->> 'key_id')::uuid;
  if v_key !~ '^hms_[0-9a-f]{8}_[0-9a-f]{48}$' or r ->> 'prefix' <> substr(v_key, 5, 8) then raise exception 'FAIL key shape %', v_key; end if;
  insert into t158_ctx values ('key', v_key), ('key_id', v_id::text);
  perform t_sys();
  if (select key_hash from api_keys where id = v_id) <> t158_hash(v_key) then raise exception 'FAIL hash'; end if;
  if exists (select 1 from api_keys where key_hash = v_key or prefix = v_key) then raise exception 'FAIL the key itself was stored'; end if;
  if (select scopes from api_keys where id = v_id) <> array['availability.read', 'bookings.read', 'guests.read'] then raise exception 'FAIL scopes not tidied'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin perform key_hash from api_keys; raise exception 'FAIL key_hash was readable'; exception when insufficient_privilege then null; end;
  if (select count(*) from api_keys) <> 1 then raise exception 'FAIL owner should see the key row'; end if;
  if (select prefix from api_keys limit 1) <> r ->> 'prefix' then raise exception 'FAIL prefix'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if (select count(*) from api_keys) <> 0 then raise exception 'FAIL front desk reads keys'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  if (select count(*) from api_keys) <> 0 then raise exception 'FAIL hotel B reads keys'; end if;
  perform t_expect(format('select api_key_revoke(%L)', v_id), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  for i in 2..10 loop perform api_key_create(v_p, 'Extra ' || i, array['availability.read'], 60); end loop;
  perform t_expect(format('select api_key_create(%L, ''Eleventh'', array[''availability.read''], 60)', v_p), 'POLICY_VIOLATION: too many');
  perform t_sys();
  if t158_audits('api_key.created', v_id) <> 1 then raise exception 'FAIL key audit'; end if;
  if exists (select 1 from audit_logs where entity_id = v_id and metadata::text like '%' || v_key || '%') then raise exception 'FAIL the key reached the audit log'; end if;
  raise notice 'PASS keys: api.manage only, scopes checked and tidied, key shown once and stored only as a hash, hash unreadable, hotels apart, ten live at most, audited';
end $$;

-- 3. Authenticate, log, rate limit, revoke
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb; v_id uuid; v_small text; v_small_id uuid; i integer; begin
  perform t_sys();
  r := api_key_authenticate(t158_hash(t158('key')));
  if r ->> 'ok' <> 'true' or (r ->> 'property_id')::uuid <> v_p or r -> 'scopes' <> '["availability.read", "bookings.read", "guests.read"]'::jsonb then raise exception 'FAIL authenticate %', r; end if;
  if api_key_authenticate(t158_hash('hms_00000000_' || repeat('0', 48))) ->> 'reason' <> 'invalid' then raise exception 'FAIL unknown key'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin perform api_key_authenticate(t158_hash(t158('key'))); raise exception 'FAIL a logged-in user authenticated a key'; exception when insufficient_privilege then null; end;
  -- a key with a limit of 1 a minute (ten are live, so one is revoked to make room)
  perform api_key_revoke((select id from api_keys where name = 'Extra 9'));
  r := api_key_create(v_p, 'Tiny', array['availability.read'], 1);
  v_small := r ->> 'key'; v_small_id := (r ->> 'key_id')::uuid;
  perform t_sys();
  perform api_log_call(v_small_id, 'GET', '/api/v1/availability', 200);
  r := api_key_authenticate(t158_hash(v_small));
  if r ->> 'ok' <> 'false' or r ->> 'reason' <> 'rate_limited' or (r ->> 'retry_after')::int not between 1 and 60 then raise exception 'FAIL rate limit %', r; end if;
  if (select last_used_at from api_keys where id = v_small_id) is null then raise exception 'FAIL last_used_at'; end if;
  if (select count(*) from api_calls where key_id = v_small_id) <> 1 then raise exception 'FAIL call log'; end if;
  -- the log is final
  begin update api_calls set status = 500 where key_id = v_small_id; raise exception 'FAIL log edited'; exception when sqlstate 'P0001' then null; end;
  begin delete from api_calls where key_id = v_small_id; raise exception 'FAIL fresh log deleted'; exception when sqlstate 'P0001' then null; end;
  -- old rows go: back-date one row by dropping the trigger briefly
  alter table api_calls disable trigger api_calls_guard;
  update api_calls set at = now() - interval '100 days' where key_id = v_small_id;
  alter table api_calls enable trigger api_calls_guard;
  delete from api_calls where key_id = v_small_id and at < now() - interval '90 days';
  if api_key_authenticate(t158_hash(v_small)) ->> 'ok' <> 'true' then raise exception 'FAIL an old call still counted against the limit'; end if;
  -- revoke
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select api_key_revoke(%L)', v_small_id), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform api_key_revoke(v_small_id);
  perform api_key_revoke(v_small_id);
  perform t_sys();
  if api_key_authenticate(t158_hash(v_small)) ->> 'reason' <> 'invalid' then raise exception 'FAIL a revoked key still works'; end if;
  if t158_audits('api_key.revoked', v_small_id) <> 1 then raise exception 'FAIL revoke audit'; end if;
  raise notice 'PASS authenticate: scopes and hotel returned, unknown and revoked keys refused, rate limit counted from the log with retry_after, log final, logged-in users cannot authenticate';
end $$;

-- 4. Read endpoints
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_pb constant uuid := '00000000-0000-0000-0000-0000000000b2';
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); r jsonb; v_ref text; v_book jsonb;
begin
  perform t_sys();
  r := api_availability(v_p, t + 30, t + 32, 1, 0);
  if jsonb_typeof(r -> 'room_types') <> 'array' or jsonb_array_length(r -> 'room_types') = 0 or r ->> 'currency' <> 'NGN' then raise exception 'FAIL availability %', left(r::text, 200); end if;
  perform t_expect(format('select api_availability(%L, %L, %L, 1, 0)', v_p, t + 32, t + 30), 'POLICY_VIOLATION');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  v_book := t_book('00000000-0000-0000-0000-0000000000a3', t + 250, t + 252, 't158-res-1');
  v_ref := (select booking_reference from reservations where id = (v_book ->> 'reservation_id')::uuid);
  insert into t158_ctx values ('ref', v_ref), ('res', v_book ->> 'reservation_id');
  perform t_sys();
  r := api_booking(v_p, lower(v_ref), false);
  if r ->> 'reference' <> v_ref or r ->> 'status' <> 'confirmed' and r ->> 'status' <> 'pending' or (r ->> 'nights')::int <> 2 or r ? 'guest' then raise exception 'FAIL booking %', r; end if;
  if jsonb_array_length(r -> 'rooms') <> 1 then raise exception 'FAIL rooms'; end if;
  r := api_booking(v_p, v_ref, true);
  if not (r -> 'guest' ? 'name') or not (r -> 'guest' ? 'email') then raise exception 'FAIL guest %', r; end if;
  perform t_expect(format('select api_booking(%L, ''NOPE-0000'', false)', v_p), 'NOT_FOUND');
  perform t_expect(format('select api_booking(%L, %L, false)', v_pb, v_ref), 'NOT_FOUND');                                      -- another hotel's key cannot read it
  r := api_bookings(v_p, t + 249, t + 251, null, 100, false);
  if not exists (select 1 from jsonb_array_elements(r -> 'bookings') x where x ->> 'reference' = v_ref) then raise exception 'FAIL list %', left(r::text, 200); end if;
  if exists (select 1 from jsonb_array_elements(r -> 'bookings') x where (x ->> 'arrival_date')::date not between t + 249 and t + 251) then raise exception 'FAIL list outside the window'; end if;
  if exists (select 1 from jsonb_array_elements(api_bookings(v_p, t + 249, t + 251, 'cancelled', 100, false) -> 'bookings') x where x ->> 'status' <> 'cancelled' or x ->> 'reference' = v_ref) then raise exception 'FAIL status filter'; end if;
  if jsonb_array_length(api_bookings(v_pb, t + 249, t + 251, null, 10, true) -> 'bookings') <> 0 then raise exception 'FAIL list leaked to hotel B'; end if;
  perform t_expect(format('select api_bookings(%L, %L, %L, null, 10, false)', v_p, t, t + 500), 'POLICY_VIOLATION: dates');
  perform t_expect(format('select api_bookings(%L, %L, %L, null, 101, false)', v_p, t, t + 5), 'POLICY_VIOLATION: limit');
  perform t_expect(format('select api_bookings(%L, %L, %L, ''lost'', 10, false)', v_p, t, t + 5), 'POLICY_VIOLATION: status');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin perform api_bookings(v_p, t, t + 5, null, 10, true); raise exception 'FAIL a logged-in user read the API list'; exception when insufficient_privilege then null; end;
  raise notice 'PASS read endpoints: availability through the hotel site, bookings by date or reference, guest only when asked, other hotels and logged-in users refused';
end $$;

-- 5. Webhook endpoints and deliveries
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; t date := property_today('00000000-0000-0000-0000-0000000000a2');
  r jsonb; v_ep uuid; v_ep2 uuid; v_ep3 uuid; v_room text; v_book jsonb; v_rr uuid; v_res uuid; v_n integer; c record; v_secret text; i integer;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select webhook_save(%L, null, ''https://example.com/h'', array[''booking.created''], true)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select webhook_save(%L, null, ''http://example.com/h'', array[''booking.created''], true)', v_p), 'POLICY_VIOLATION: url');
  perform t_expect(format('select webhook_save(%L, null, ''https://exa mple.com'', array[''booking.created''], true)', v_p), 'POLICY_VIOLATION: url');
  perform t_expect(format('select webhook_save(%L, null, ''https://example.com/h'', array[''booking.exploded''], true)', v_p), 'POLICY_VIOLATION: events');
  perform t_expect(format('select webhook_save(%L, null, ''https://example.com/h'', array[]::text[], true)', v_p), 'POLICY_VIOLATION: events');
  r := webhook_save(v_p, null, 'https://example.com/hooks/a', array['booking.created', 'booking.checked_in'], true);
  v_ep := (r ->> 'endpoint_id')::uuid; v_secret := r ->> 'secret';
  if v_secret !~ '^whsec_[0-9a-f]{64}$' then raise exception 'FAIL secret shape'; end if;
  v_ep2 := (webhook_save(v_p, null, 'https://example.com/hooks/b', array['booking.cancelled'], true) ->> 'endpoint_id')::uuid;
  v_ep3 := (webhook_save(v_p, null, 'https://example.com/hooks/c', array['booking.created'], false) ->> 'endpoint_id')::uuid;
  if webhook_save(v_p, v_ep, 'https://example.com/hooks/a', array['booking.created', 'booking.checked_in'], true) ->> 'secret' is not null then raise exception 'FAIL an edit returned the secret'; end if;
  begin perform secret from webhook_endpoints; raise exception 'FAIL secret was readable'; exception when insufficient_privilege then null; end;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  if (select count(*) from webhook_endpoints) <> 0 then raise exception 'FAIL hotel B reads endpoints'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform webhook_save(v_p, null, 'https://example.com/hooks/d', array['booking.created'], false);
  perform webhook_save(v_p, null, 'https://example.com/hooks/e', array['booking.created'], false);
  perform t_expect(format('select webhook_save(%L, null, ''https://example.com/hooks/f'', array[''booking.created''], true)', v_p), 'POLICY_VIOLATION: too many');

  -- a booking queues one delivery for the subscribed live endpoint only
  perform t_sys();
  v_n := (select count(*) from webhook_deliveries);
  v_room := t21_free_room();
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  v_book := t_book('00000000-0000-0000-0000-0000000000a3', t, t + 2, 't158-res-2', t21_room(v_room));
  v_rr := t_rr(v_book); v_res := (v_book ->> 'reservation_id')::uuid;
  perform t_sys();
  if (select count(*) from webhook_deliveries where created_at >= now() - interval '1 minute' and endpoint_id = v_ep and event = 'booking.created') <> 1 then raise exception 'FAIL created delivery'; end if;
  if exists (select 1 from webhook_deliveries where endpoint_id in (v_ep2, v_ep3)) then raise exception 'FAIL an unsubscribed or switched-off endpoint got a delivery'; end if;
  select * into c from webhook_deliveries where endpoint_id = v_ep and event = 'booking.created' order by created_at desc limit 1;
  if c.payload ->> 'event' <> 'booking.created' or (c.payload -> 'data' ->> 'reference') <> (select booking_reference from reservations where id = v_res)
     or c.payload::text ilike '%@%' or c.payload -> 'data' ? 'guest' then raise exception 'FAIL payload %', c.payload; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform check_in(v_rr, 'test');
  perform t_sys();
  if (select count(*) from webhook_deliveries where endpoint_id = v_ep and event = 'booking.checked_in') <> 1 then raise exception 'FAIL checked-in delivery'; end if;

  -- claim: leases, returns url and secret, and a second claim finds nothing
  r := null;
  select count(*) into v_n from claim_webhook_deliveries(50);
  if v_n <> 2 then raise exception 'FAIL claim count %', v_n; end if;
  if (select count(*) from claim_webhook_deliveries(50)) <> 0 then raise exception 'FAIL a leased row was claimed again'; end if;
  select * into c from webhook_deliveries where endpoint_id = v_ep and event = 'booking.created';
  if c.attempts <> 1 or c.next_attempt_at < now() + interval '4 minutes' then raise exception 'FAIL lease'; end if;
  -- failure backs off; success closes it; six failures end it
  perform mark_webhook_delivery(c.id, false, 500, 'boom');
  select * into c from webhook_deliveries where id = c.id;
  if c.status <> 'pending' or c.response_code <> 500 or c.last_error <> 'boom' or c.next_attempt_at < now() + interval '1 minute' then raise exception 'FAIL back-off'; end if;
  update webhook_deliveries set next_attempt_at = now() where id = c.id;
  if (select count(*) from claim_webhook_deliveries(50) x where x.id = c.id) <> 1 or (select secret from claim_webhook_deliveries(0) limit 0) is not null then raise exception 'FAIL reclaim'; end if;
  perform mark_webhook_delivery(c.id, true, 200, null);
  if (select status from webhook_deliveries where id = c.id) <> 'sent' then raise exception 'FAIL sent'; end if;
  perform mark_webhook_delivery(c.id, false, 500, 'late');
  if (select status from webhook_deliveries where id = c.id) <> 'sent' then raise exception 'FAIL a sent row was changed'; end if;
  select * into c from webhook_deliveries where endpoint_id = v_ep and event = 'booking.checked_in';
  update webhook_deliveries set attempts = 6 where id = c.id;
  perform mark_webhook_delivery(c.id, false, 502, 'gone');
  if (select status from webhook_deliveries where id = c.id) <> 'failed' then raise exception 'FAIL failed after six tries'; end if;
  -- a switched-off endpoint is not claimed
  insert into webhook_deliveries (endpoint_id, tenant_id, property_id, event, payload) select v_ep3, tenant_id, property_id, 'booking.created', '{}'::jsonb from webhook_endpoints where id = v_ep3;
  if (select count(*) from claim_webhook_deliveries(50) x where x.url like '%/hooks/c') <> 0 then raise exception 'FAIL claimed for an off endpoint'; end if;
  -- the screen reads statuses but not the secret
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if (select count(*) from webhook_deliveries where endpoint_id = v_ep) <> 2 then raise exception 'FAIL owner reads deliveries'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  if (select count(*) from webhook_deliveries) <> 0 then raise exception 'FAIL hotel B reads deliveries'; end if;
  perform t_sys();
  if t158_audits('webhook_endpoint.saved', v_ep) <> 2 then raise exception 'FAIL endpoint audits'; end if;
  raise notice 'PASS webhooks: validated, secret shown once and unreadable, only subscribed live endpoints queued, no guest details, lease and back-off and six tries, hotels apart, audited';
end $$;

-- 6. The flag
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t constant uuid := '00000000-0000-0000-0000-0000000000a1'; t date := property_today('00000000-0000-0000-0000-0000000000a2'); v_n bigint; v_book jsonb; begin
  perform t_sys();
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values (v_t, 'api_access', false);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select api_key_create(%L, ''Late'', array[''availability.read''], 60)', v_p), 'POLICY_VIOLATION: api off');
  perform t_expect(format('select webhook_save(%L, null, ''https://example.com/z'', array[''booking.created''], true)', v_p), 'POLICY_VIOLATION: api off');
  if (select count(*) from api_keys) = 0 then raise exception 'FAIL keys unreadable with the flag off'; end if;
  perform api_key_revoke((select id from api_keys where name = 'Extra 2'));
  perform t_sys();
  if api_key_authenticate(t158_hash(t158('key'))) ->> 'reason' <> 'off' then raise exception 'FAIL authenticate with the flag off'; end if;
  v_n := (select count(*) from webhook_deliveries);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  v_book := t_book('00000000-0000-0000-0000-0000000000a3', t + 50, t + 52, 't158-res-3');
  perform t_sys();
  if (select count(*) from webhook_deliveries) <> v_n then raise exception 'FAIL an event was queued with the flag off'; end if;
  delete from tenant_feature_entitlements where tenant_id = v_t and feature_key = 'api_access';
  if api_key_authenticate(t158_hash(t158('key'))) ->> 'ok' <> 'true' then raise exception 'FAIL authenticate after switching on'; end if;
  raise notice 'PASS flag: off refuses new keys and endpoints, stops authentication and queueing, reads and revoking still work; on again, keys work';
end $$;
