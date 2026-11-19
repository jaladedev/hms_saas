-- SMS and WhatsApp notifications (migration 147). Hotel A: tenant a1, property a2; owner aa01, front desk aa04; another hotel's owner bb01.
-- Reuses t_as / t_sys / t_expect (05), t06_hold (06), t08_ctx / t08_conf (08). Date offsets 290 to 299 are used here.
\set ON_ERROR_STOP on

create function t145_online(p_label text, p_off integer, p_phone text, p_country text default null) returns uuid
language plpgsql as $$
declare h jsonb; a jsonb; v_res uuid;
begin
  h := t06_hold(p_off => p_off, p_nights => 2,
                p_guest => jsonb_build_object('full_name', 'Sms Guest', 'email', p_label || '@example.com', 'phone', p_phone),
                p_key => 't145-' || p_label);
  v_res := (h ->> 'reservation_id')::uuid;
  a := create_payment_attempt(v_res, 't145-attempt-' || p_label);
  insert into t08_ctx (label, res, ref, amount) values (p_label, v_res, a ->> 'reference', (a ->> 'amount_minor')::bigint);
  return v_res;
end $$;

-- A booking made far ahead and moved into a window (triggers off), like test 122
create function t145_moved(p_label text, p_arrive_in integer, p_status text, p_phone text, p_age interval default '3 days') returns uuid
language plpgsql as $$
declare v_res uuid; v_t date := property_today('00000000-0000-0000-0000-0000000000a2'); v_arr date := current_date + 30 + (random() * 250)::int;
begin
  v_res := (create_hold('book.hotel-a.test', v_arr, v_arr + 2, '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":1}]'::jsonb,
                        jsonb_build_object('full_name', 'Moved Guest', 'email', p_label || '@example.com', 'phone', p_phone), 't145m-' || p_label) ->> 'reservation_id')::uuid;
  set local session_replication_role = replica;
  delete from room_inventory_claims where reservation_room_id in (select id from reservation_rooms where reservation_id = v_res);
  update reservations set arrival_date = v_t + p_arrive_in, departure_date = v_t + p_arrive_in + 2, reservation_status = p_status, created_at = now() - p_age where id = v_res;
  if p_status = 'checked_out' then
    update reservation_rooms set room_status = 'checked_out', checked_out_at = now() - interval '5 hours' where reservation_id = v_res;
  end if;
  set local session_replication_role = origin;
  return v_res;
end $$;

-- 1. Phone numbers
do $$ begin
  if phone_to_e164('0803 123 4567', 'NG') <> '+2348031234567' then raise exception 'FAIL local mobile'; end if;
  if phone_to_e164('(0803) 123-4567', 'NG') <> '+2348031234567' then raise exception 'FAIL punctuation'; end if;
  if phone_to_e164('2348031234567', 'NG') <> '+2348031234567' then raise exception 'FAIL 234 without plus'; end if;
  if phone_to_e164('+234 803 123 4567', 'GH') <> '+2348031234567' then raise exception 'FAIL plus form'; end if;
  if phone_to_e164('00234 803 123 4567', 'NG') <> '+2348031234567' then raise exception 'FAIL 00 prefix'; end if;
  if phone_to_e164('+44 7700 900123', 'NG') <> '+447700900123' then raise exception 'FAIL foreign number'; end if;
  if phone_to_e164('0803123456', 'NG') is not null then raise exception 'FAIL too short'; end if;
  if phone_to_e164('02012345678', 'NG') is not null then raise exception 'FAIL landline accepted'; end if;
  if phone_to_e164('+2342012345678', 'NG') is not null then raise exception 'FAIL +234 landline accepted'; end if;
  if phone_to_e164('07700900123', 'GB') is not null then raise exception 'FAIL local number outside Nigeria needs the plus'; end if;
  if phone_to_e164('call me', 'NG') is not null or phone_to_e164('', 'NG') is not null or phone_to_e164(null, 'NG') is not null then raise exception 'FAIL junk'; end if;
  if phone_to_e164('+1234567890123456', 'NG') is not null then raise exception 'FAIL too long'; end if;
  raise notice 'PASS phone numbers: Nigerian mobiles and +numbers pass, punctuation ignored, landlines, short, long and junk refused';
end $$;

-- 2. Settings: property.configure only, off by default, validated, audited, anon refused, plan flag
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_state text; begin
  perform t_sys();
  if (select sms_enabled from properties where id = v_p) then raise exception 'FAIL should start off'; end if;
  if (select sms_kinds from properties where id = v_p) <> array['booking_confirmed', 'arrival_reminder'] then raise exception 'FAIL default kinds'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format($q$select set_sms_settings(%L, true, array['booking_confirmed'], 'sms', 300, 1)$q$, v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format($q$select set_sms_settings(%L, true, array['booking_confirmed'], 'sms', 300, 1)$q$, v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format($q$select set_sms_settings(%L, true, array['spam'], 'sms', 300, 1)$q$, v_p), 'INVALID_SMS_SETTING');
  perform t_expect(format($q$select set_sms_settings(%L, true, array['booking_confirmed'], 'telegram', 300, 1)$q$, v_p), 'INVALID_SMS_SETTING');
  perform t_expect(format($q$select set_sms_settings(%L, true, array['booking_confirmed'], 'sms', -1, 1)$q$, v_p), 'INVALID_SMS_SETTING');
  perform t_expect(format($q$select set_sms_settings(%L, true, array['booking_confirmed'], 'sms', 100001, 1)$q$, v_p), 'INVALID_SMS_SETTING');
  perform t_expect(format($q$select set_sms_settings(%L, true, array['booking_confirmed'], 'sms', 300, 0)$q$, v_p), 'INVALID_SMS_SETTING');
  perform t_expect(format($q$select set_sms_settings(%L, true, array['booking_confirmed'], 'sms', 300, 8)$q$, v_p), 'INVALID_SMS_SETTING');
  perform t_expect(format($q$select set_sms_settings(%L, true, array['booking_confirmed'], 'sms', null, 1)$q$, v_p), 'INVALID_SMS_SETTING');
  perform set_sms_settings(v_p, true, array['review_request', 'booking_confirmed', 'booking_confirmed', 'arrival_reminder'], ' sms ', 300, 3);
  perform t_sys();
  if not (select sms_enabled from properties where id = v_p) then raise exception 'FAIL not saved'; end if;
  if (select sms_kinds from properties where id = v_p) <> array['arrival_reminder', 'booking_confirmed', 'review_request'] then raise exception 'FAIL kinds not tidied: %', (select sms_kinds from properties where id = v_p); end if;
  if (select sms_reminder_days from properties where id = v_p) <> 3 then raise exception 'FAIL reminder days'; end if;
  if not exists (select 1 from audit_logs where entity_id = v_p and action = 'property.updated' and metadata -> 'changed' ? 'sms_enabled') then raise exception 'FAIL not audited'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_sms_settings(v_p, null, null, null, 300, 1);   -- null counts as off, no kinds, plain sms
  perform t_sys();
  if (select sms_enabled from properties where id = v_p) or cardinality((select sms_kinds from properties where id = v_p)) <> 0 then raise exception 'FAIL null did not turn it off'; end if;
  -- plan flag off: the screen's functions refuse as for a person without the right
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values ('00000000-0000-0000-0000-0000000000a1', 'sms_notifications', false);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format($q$select set_sms_settings(%L, true, array['booking_confirmed'], 'sms', 300, 1)$q$, v_p), 'NOT_FOUND');
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = '00000000-0000-0000-0000-0000000000a1' and feature_key = 'sms_notifications';
  begin
    set local role anon;
    perform set_sms_settings(v_p, true, array['booking_confirmed'], 'sms', 300, 1);
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could call set_sms_settings'; end if;
  if not ('sms_notifications' = any (plan_enforced_flags())) then raise exception 'FAIL flag missing from the enforced list'; end if;
  raise notice 'PASS sms settings: property.configure only, validated and tidied, audited, plan flag respected, anon refused';
end $$;

-- 3. A confirmed website booking queues one text; every other case queues none
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_a uuid; v_n integer; v_row sms_outbox%rowtype; begin
  perform t_sys();
  -- setting off: nothing
  v_a := t145_online('sms-off', 290, '0803 111 0001');
  perform t08_conf('sms-off', 'evt-sms-off');
  if (select count(*) from sms_outbox) <> 0 then raise exception 'FAIL queued while the setting is off'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_sms_settings(v_p, true, array['booking_confirmed', 'arrival_reminder'], 'sms', 300, 2);
  perform t_sys();
  v_a := t145_online('sms-a', 291, '0803 111 0002');
  perform t08_conf('sms-a', 'evt-sms-a-1');
  perform t08_conf('sms-a', 'evt-sms-a-2');   -- a replay
  select count(*) into v_n from sms_outbox where reservation_id = v_a;
  if v_n <> 1 then raise exception 'FAIL expected 1 text, got %', v_n; end if;
  select * into v_row from sms_outbox where reservation_id = v_a;
  if v_row.kind <> 'booking_confirmed' or v_row.to_phone <> '+2348031110002' or v_row.channel <> 'sms' or v_row.status <> 'pending' or v_row.property_id <> v_p then raise exception 'FAIL row %', to_jsonb(v_row); end if;

  -- no phone, a landline, an opted-out guest, a kind that is off: no text
  perform t145_online('sms-nophone', 292, null);
  perform t08_conf('sms-nophone', 'evt-sms-nophone');
  perform t145_online('sms-land', 293, '020 1234 5678');
  perform t08_conf('sms-land', 'evt-sms-land');
  perform t145_online('sms-opt', 294, '0803 111 0003');
  update guests set sms_opt_out = true where email = 'sms-opt@example.com';
  perform t08_conf('sms-opt', 'evt-sms-opt');
  if (select count(*) from sms_outbox) <> 1 then raise exception 'FAIL a case that should not queue did (% rows)', (select count(*) from sms_outbox); end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_sms_settings(v_p, true, array['arrival_reminder'], 'sms', 300, 2);
  perform t_sys();
  perform t145_online('sms-kind', 295, '0803 111 0004');
  perform t08_conf('sms-kind', 'evt-sms-kind');
  if (select count(*) from sms_outbox) <> 1 then raise exception 'FAIL a kind that is switched off queued'; end if;

  -- plan flag off: nothing
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_sms_settings(v_p, true, array['booking_confirmed', 'arrival_reminder'], 'sms', 300, 2);
  perform t_sys();
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values ('00000000-0000-0000-0000-0000000000a1', 'sms_notifications', false);
  perform t145_online('sms-flag', 296, '0803 111 0005');
  perform t08_conf('sms-flag', 'evt-sms-flag');
  delete from tenant_feature_entitlements where tenant_id = '00000000-0000-0000-0000-0000000000a1' and feature_key = 'sms_notifications';
  if (select count(*) from sms_outbox) <> 1 then raise exception 'FAIL queued with the plan flag off'; end if;

  -- a staff booking confirmed the normal way: nothing (website bookings only)
  v_a := t145_moved('sms-staff', 5, 'pending', '0803 111 0006');
  set local session_replication_role = replica;
  update reservations set source = 'staff_entry' where id = v_a;
  set local session_replication_role = origin;
  update reservations set reservation_status = 'confirmed' where id = v_a;
  if (select count(*) from sms_outbox) <> 1 then raise exception 'FAIL a staff booking queued a text'; end if;
  raise notice 'PASS confirmed website booking queues one text (not for replays, staff bookings, no phone, landlines, opt-out, a kind off or the plan flag off)';
end $$;

-- 4. Reminders and review requests: the queue function
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; a uuid; b uuid; c uuid; d uuid; e uuid; f uuid; r jsonb; begin
  perform t_sys();
  a := t145_moved('rem-a', 2, 'confirmed', '0803 222 0001');                        -- in the window (2 days)
  b := t145_moved('rem-b', 4, 'confirmed', '0803 222 0002');                        -- beyond the window
  c := t145_moved('rem-c', 1, 'confirmed', '0803 222 0003', '1 hour');              -- made an hour ago
  d := t145_moved('rem-d', 2, 'cancelled', '0803 222 0004');
  e := t145_moved('rem-e', 2, 'confirmed', null);                                   -- no phone
  f := t145_moved('rem-f', 0, 'confirmed', '0803 222 0005');                        -- arrives today
  r := queue_sms_messages();
  if (r ->> 'arrival_reminder')::int <> 1 or (r ->> 'review_request')::int <> 0 then raise exception 'FAIL first run %', r; end if;
  if not exists (select 1 from sms_outbox where reservation_id = a and kind = 'arrival_reminder' and to_phone = '+2348032220001') then raise exception 'FAIL booking A not queued'; end if;
  if exists (select 1 from sms_outbox where kind = 'arrival_reminder' and reservation_id in (b, c, d, e, f)) then raise exception 'FAIL a booking outside the rules was queued'; end if;
  r := queue_sms_messages();
  if (r ->> 'arrival_reminder')::int <> 0 then raise exception 'FAIL reminded twice %', r; end if;

  -- a wider window picks up B once
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_sms_settings(v_p, true, array['booking_confirmed', 'arrival_reminder'], 'sms', 300, 4);
  perform t_sys();
  r := queue_sms_messages();
  if (r ->> 'arrival_reminder')::int <> 1 or not exists (select 1 from sms_outbox where reservation_id = b and kind = 'arrival_reminder') then raise exception 'FAIL wider window %', r; end if;

  -- review requests: off unless the kind is on
  perform t145_moved('rev-a', -3, 'checked_out', '0803 222 0006');
  r := queue_sms_messages();
  if (r ->> 'review_request')::int <> 0 then raise exception 'FAIL review queued while the kind is off %', r; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_sms_settings(v_p, true, array['booking_confirmed', 'arrival_reminder', 'review_request'], 'sms', 300, 4);
  perform t_sys();
  if (queue_sms_messages() ->> 'review_request')::int <> 1 then raise exception 'FAIL review request not queued'; end if;
  if (queue_sms_messages() ->> 'review_request')::int <> 0 then raise exception 'FAIL review request queued twice'; end if;
  raise notice 'PASS reminders: only confirmed, older bookings in the window with a mobile; once each; the window widens; review request only when the kind is on';
end $$;

-- 5. The monthly cap
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_used integer; v_before integer; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_used := (sms_usage(v_p) ->> 'used_this_month')::int;
  if v_used < 3 then raise exception 'FAIL expected earlier rows to count, got %', v_used; end if;
  perform set_sms_settings(v_p, true, array['booking_confirmed'], 'sms', v_used, 1);   -- cap reached exactly
  perform t_sys();
  select count(*) into v_before from sms_outbox;
  perform t145_online('cap-a', 297, '0803 333 0001');
  perform t08_conf('cap-a', 'evt-cap-a');
  if (select count(*) from sms_outbox) <> v_before then raise exception 'FAIL queued over the cap'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_sms_settings(v_p, true, array['booking_confirmed'], 'sms', v_used + 1, 1);
  perform t_sys();
  perform t145_online('cap-b', 298, '0803 333 0002');
  perform t08_conf('cap-b', 'evt-cap-b');
  if (select count(*) from sms_outbox) <> v_before + 1 then raise exception 'FAIL a message under the cap was not queued'; end if;
  perform t145_online('cap-c', 299, '0803 333 0003');
  perform t08_conf('cap-c', 'evt-cap-c');
  if (select count(*) from sms_outbox) <> v_before + 1 then raise exception 'FAIL queued over the cap (second)'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_sms_settings(v_p, true, array['booking_confirmed', 'arrival_reminder', 'review_request'], 'sms', 0, 1);   -- 0 means none
  perform t_sys();
  raise notice 'PASS monthly cap: nothing queued at the cap, one more allowed when raised by one, 0 stops everything';
end $$;

-- 6. Claim, send, retry, give up, permanent failure, stuck worker, opted out after queueing
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v jsonb; v_id uuid; v_other uuid; i integer; v_state text; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_sms_settings(v_p, true, array['booking_confirmed', 'arrival_reminder', 'review_request'], 'sms', 1000, 1);
  perform t_sys();
  -- limits and access
  perform t_expect('select claim_sms(0)', 'POLICY_VIOLATION');
  perform t_expect('select claim_sms(101)', 'POLICY_VIOLATION');
  perform t_expect('select claim_sms(null)', 'POLICY_VIOLATION');

  update sms_outbox set status = 'sent', sent_at = now() where status <> 'sent' and reservation_id not in (select res from t08_ctx where label = 'sms-a');
  select id into v_id from sms_outbox where reservation_id = (select res from t08_ctx where label = 'sms-a');
  update sms_outbox set status = 'pending', attempts = 0, next_attempt_at = now(), sent_at = null where id = v_id;
  v := claim_sms(10);
  if jsonb_array_length(v) <> 1 then raise exception 'FAIL claimed %', jsonb_array_length(v); end if;
  if v -> 0 ->> 'id' <> v_id::text or v -> 0 ->> 'to_phone' <> '+2348031110002' or v -> 0 ->> 'kind' <> 'booking_confirmed' or v -> 0 ->> 'channel' <> 'sms' or (v -> 0 ->> 'attempt')::int <> 1
     or v -> 0 -> 'booking' ->> 'booking_reference' is null or v -> 0 ->> 'site_host' is distinct from 'book.hotel-a.test' then raise exception 'FAIL claimed shape %', v -> 0; end if;
  if jsonb_array_length(claim_sms(10)) <> 0 then raise exception 'FAIL a sending row was claimed twice'; end if;

  -- a failure retries with a back-off
  perform mark_sms_result(v_id, false, 'provider 500');
  if (select status from sms_outbox where id = v_id) <> 'pending' or (select next_attempt_at from sms_outbox where id = v_id) < now() + interval '4 minutes' then raise exception 'FAIL back-off'; end if;
  if jsonb_array_length(claim_sms(10)) <> 0 then raise exception 'FAIL claimed before its time'; end if;
  -- up to five attempts, then failed
  for i in 2..5 loop
    update sms_outbox set next_attempt_at = now() where id = v_id;
    v := claim_sms(10);
    if jsonb_array_length(v) <> 1 or (v -> 0 ->> 'attempt')::int <> i then raise exception 'FAIL attempt %: %', i, v; end if;
    perform mark_sms_result(v_id, false, 'provider 500');
  end loop;
  if (select status from sms_outbox where id = v_id) <> 'failed' or (select last_error from sms_outbox where id = v_id) <> 'provider 500' then raise exception 'FAIL not failed after five attempts'; end if;
  update sms_outbox set next_attempt_at = now() where id = v_id;
  if jsonb_array_length(claim_sms(10)) <> 0 then raise exception 'FAIL a failed row was claimed'; end if;

  -- success records the provider id; a result for a row not being sent is ignored
  update sms_outbox set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null where id = v_id;
  perform claim_sms(10);
  perform mark_sms_result(v_id, true, null, 'msg-123');
  if (select status from sms_outbox where id = v_id) <> 'sent' or (select provider_message_id from sms_outbox where id = v_id) <> 'msg-123' or (select sent_at from sms_outbox where id = v_id) is null then raise exception 'FAIL success not recorded'; end if;
  perform mark_sms_result(v_id, false, 'late failure');
  if (select status from sms_outbox where id = v_id) <> 'sent' then raise exception 'FAIL a result for a sent row changed it'; end if;

  -- a permanent refusal fails at once
  update sms_outbox set status = 'pending', attempts = 0, next_attempt_at = now(), sent_at = null where id = v_id;
  perform claim_sms(10);
  perform mark_sms_result(v_id, false, 'invalid number', null, true);
  if (select status from sms_outbox where id = v_id) <> 'failed' or (select attempts from sms_outbox where id = v_id) <> 1 then raise exception 'FAIL permanent failure'; end if;

  -- a worker that died: sending for 11 minutes is claimed again
  update sms_outbox set status = 'sending', attempts = 1, updated_at = now() - interval '11 minutes' where id = v_id;
  v := claim_sms(10);
  if jsonb_array_length(v) <> 1 or (v -> 0 ->> 'attempt')::int <> 2 then raise exception 'FAIL stuck row not recovered %', v; end if;
  perform mark_sms_result(v_id, true, null, 'msg-124');

  -- a guest who opts out after the text was queued: dropped at claim time, never sent
  update sms_outbox set status = 'pending', attempts = 0, next_attempt_at = now(), sent_at = null, last_error = null where id = v_id;
  update guests set sms_opt_out = true where id = (select primary_guest_id from reservations where id = (select reservation_id from sms_outbox where id = v_id));
  if jsonb_array_length(claim_sms(10)) <> 0 then raise exception 'FAIL claimed a text for an opted-out guest'; end if;
  if (select status from sms_outbox where id = v_id) <> 'failed' or (select last_error from sms_outbox where id = v_id) not like 'not sent%' then raise exception 'FAIL opted-out text not dropped'; end if;
  update guests set sms_opt_out = false where id = (select primary_guest_id from reservations where id = (select reservation_id from sms_outbox where id = v_id));

  -- the hotel switches it off after queueing: dropped too
  update sms_outbox set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null where id = v_id;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_sms_settings(v_p, false, array['booking_confirmed'], 'sms', 1000, 1);
  perform t_sys();
  if jsonb_array_length(claim_sms(10)) <> 0 then raise exception 'FAIL a text was claimed after the hotel switched SMS off'; end if;
  if (select status from sms_outbox where id = v_id) <> 'failed' then raise exception 'FAIL the text was not dropped after the hotel switched SMS off'; end if;
  raise notice 'PASS sms outbox: exclusive claim, back-off, five attempts, provider id, permanent failure, stuck worker, opt-out and switch-off drop the text';
end $$;

-- 7. Opt-out: staff (guest.manage) and the guest themselves
do $$ declare g uuid; r jsonb; v_res uuid; begin
  perform t_sys();
  v_res := (select res from t08_ctx where label = 'sms-a');
  g := (select primary_guest_id from reservations where id = v_res);
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select set_guest_sms_opt_out(%L, true)', g), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');   -- housekeeping: no guest.manage
  perform t_expect(format('select set_guest_sms_opt_out(%L, true)', g), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select set_guest_sms_opt_out(%L, null)', g), 'POLICY_VIOLATION');
  r := set_guest_sms_opt_out(g, true);
  if (r ->> 'changed') <> 'true' then raise exception 'FAIL %', r; end if;
  r := set_guest_sms_opt_out(g, true);
  if (r ->> 'changed') <> 'false' then raise exception 'FAIL repeat changed %', r; end if;
  perform t_sys();
  if not (select sms_opt_out from guests where id = g) then raise exception 'FAIL not saved'; end if;
  if (select count(*) from audit_logs where entity_id = g and action = 'guest.sms_opt_out_changed') <> 1 then raise exception 'FAIL audit rows'; end if;
  if (select metadata ->> 'by' from audit_logs where entity_id = g and action = 'guest.sms_opt_out_changed') <> 'staff' then raise exception 'FAIL audit actor kind'; end if;
  -- the guest turns it back on, from their booking page
  r := guest_set_sms_opt_out(v_res, false);
  if (r ->> 'changed') <> 'true' or (select sms_opt_out from guests where id = g) then raise exception 'FAIL guest change %', r; end if;
  if (guest_set_sms_opt_out(v_res, false) ->> 'changed') <> 'false' then raise exception 'FAIL guest repeat'; end if;
  perform t_expect(format('select guest_set_sms_opt_out(%L, null)', v_res), 'POLICY_VIOLATION');
  perform t_expect('select guest_set_sms_opt_out(gen_random_uuid(), true)', 'NOT_FOUND');
  if not exists (select 1 from audit_logs where entity_id = g and action = 'guest.sms_opt_out_changed' and metadata ->> 'by' = 'guest' and actor_user_id is null) then raise exception 'FAIL guest change not audited'; end if;
  -- what the booking page asks: the hotel texts this guest, and whether they opted out
  update properties set sms_enabled = true, sms_kinds = array['booking_confirmed'] where id = '00000000-0000-0000-0000-0000000000a2';
  r := guest_sms_status(v_res);
  if (r ->> 'hotel_texts')::boolean is not true or (r ->> 'opt_out')::boolean is not false then raise exception 'FAIL status %', r; end if;
  perform guest_set_sms_opt_out(v_res, true);
  if (guest_sms_status(v_res) ->> 'opt_out')::boolean is not true then raise exception 'FAIL status after opt-out'; end if;
  perform guest_set_sms_opt_out(v_res, false);
  update guests set phone = null where id = g;
  if (guest_sms_status(v_res) ->> 'hotel_texts')::boolean is not false then raise exception 'FAIL status without a number'; end if;
  update guests set phone = '0803 111 0002' where id = g;
  update properties set sms_enabled = false where id = '00000000-0000-0000-0000-0000000000a2';
  if (guest_sms_status(v_res) ->> 'hotel_texts')::boolean is not false then raise exception 'FAIL status with the setting off'; end if;
  perform t_expect('select guest_sms_status(gen_random_uuid())', 'NOT_FOUND');
  -- direct updates of guests stay closed (047)
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin
    update guests set sms_opt_out = true where id = g;
    raise exception 'FAIL a direct update of guests worked';
  exception when insufficient_privilege then null;
  end;
  perform t_sys();
  raise notice 'PASS opt-out: staff with guest.manage and the guest can change it, both audited, direct updates still closed';
end $$;

-- 8. Usage and failures: property.configure only, hotel isolation, numbers masked
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; u jsonb; f jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select sms_usage(%L)', v_p), 'NOT_FOUND');
  perform t_expect(format('select sms_recent_failures(%L)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select sms_usage(%L)', v_p), 'NOT_FOUND');
  perform t_expect(format('select sms_recent_failures(%L)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  u := sms_usage(v_p);
  if (u ->> 'plan_enabled')::boolean is not true then raise exception 'FAIL plan_enabled should be true %', u; end if;
  if (u ->> 'cap')::int <> 1000 or (u ->> 'used_this_month')::int < 1 or jsonb_array_length(u -> 'months') < 1 then raise exception 'FAIL usage %', u; end if;
  if (u -> 'months' -> 0 ->> 'month') <> to_char(now() at time zone 'Africa/Lagos', 'YYYY-MM') then raise exception 'FAIL month label %', u; end if;
  perform t_sys();
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values ('00000000-0000-0000-0000-0000000000a1', 'sms_notifications', false);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if (sms_usage(v_p) ->> 'plan_enabled')::boolean is not false then raise exception 'FAIL plan_enabled should be false with the flag off'; end if;
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = '00000000-0000-0000-0000-0000000000a1' and feature_key = 'sms_notifications';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  f := sms_recent_failures(v_p);
  if jsonb_array_length(f) < 1 then raise exception 'FAIL no failures listed'; end if;
  if f::text like '%+2348031110002%' or f -> 0 ->> 'to' !~ '^\+234•+...$' then raise exception 'FAIL number not masked %', f -> 0; end if;
  raise notice 'PASS usage and failures: property.configure only, other hotels see nothing, numbers masked';
end $$;

-- 9. Nobody but the server calls the queue, claim, result and enqueue functions; the table is closed
do $$ declare v_state text; v_fn text; begin
  foreach v_fn in array array['queue_sms_messages()', 'claim_sms(5)', 'mark_sms_result(gen_random_uuid(), true)',
                              'enqueue_sms(gen_random_uuid(), ''booking_confirmed'', ''x'')', 'guest_set_sms_opt_out(gen_random_uuid(), true)', 'guest_sms_status(gen_random_uuid())',
                              'phone_to_e164(''08031234567'', ''NG'')'] loop
    perform t_as('00000000-0000-0000-0000-00000000aa01');
    begin
      execute 'select ' || v_fn;
      v_state := 'allowed';
    exception when insufficient_privilege then v_state := 'refused';
    end;
    if v_state <> 'refused' then raise exception 'FAIL authenticated could call %', v_fn; end if;
    perform t_sys();
    begin
      set local role anon;
      execute 'select ' || v_fn;
      v_state := 'allowed';
    exception when insufficient_privilege then v_state := 'refused';
    end;
    reset role;
    if v_state <> 'refused' then raise exception 'FAIL anon could call %', v_fn; end if;
  end loop;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin
    perform count(*) from sms_outbox;
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  if v_state <> 'refused' then raise exception 'FAIL authenticated can read sms_outbox'; end if;
  perform t_sys();
  raise notice 'PASS access: the queue, claim, result, enqueue and guest opt-out functions and the table are closed to logins and anon';
end $$;

-- 10. Purge: only finished rows older than 400 days go
do $$ declare v_id uuid; v_old uuid; v_new uuid; r jsonb; begin
  perform t_sys();
  select id into v_id from sms_outbox limit 1;
  insert into sms_outbox (tenant_id, property_id, reservation_id, kind, channel, to_phone, status, created_at, dedupe_key)
  select tenant_id, property_id, reservation_id, 'booking_confirmed', 'sms', '+2348031110002', 'sent', now() - interval '401 days', 'old-sent' from sms_outbox where id = v_id returning id into v_old;
  insert into sms_outbox (tenant_id, property_id, reservation_id, kind, channel, to_phone, status, created_at, dedupe_key)
  select tenant_id, property_id, reservation_id, 'booking_confirmed', 'sms', '+2348031110002', 'pending', now() - interval '401 days', 'old-pending' from sms_outbox where id = v_id returning id into v_new;
  r := purge_old_operational_data();
  if (r ->> 'sms')::int < 1 then raise exception 'FAIL nothing purged %', r; end if;
  if exists (select 1 from sms_outbox where id = v_old) then raise exception 'FAIL old sent row kept'; end if;
  if not exists (select 1 from sms_outbox where id = v_new) then raise exception 'FAIL an unfinished row was purged'; end if;
  if not exists (select 1 from sms_outbox where id = v_id) then raise exception 'FAIL a recent row was purged'; end if;
  delete from sms_outbox where id = v_new;
  raise notice 'PASS purge: finished rows older than 400 days go, recent and unfinished stay';
end $$;

-- leave the hotel as found
update properties set sms_enabled = false, sms_kinds = array['booking_confirmed', 'arrival_reminder'], sms_monthly_cap = 300, sms_reminder_days = 1
 where id = '00000000-0000-0000-0000-0000000000a2';
