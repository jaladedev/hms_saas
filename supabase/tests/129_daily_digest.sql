-- Morning summary email (migration 129). Hotel A: tenant a1, property a2; owner aa01, front desk aa04; another hotel's owner bb01.
\set ON_ERROR_STOP on

create temp table t129_orig as select timezone from properties where id = '00000000-0000-0000-0000-0000000000a2';

-- a zone where it is now the given hour (0 to 23), so the test does not depend on the real time of day
create function t129_zone(p_hour integer) returns text language plpgsql as $$
declare v_off integer := ((p_hour - extract(hour from now() at time zone 'UTC')::int + 36) % 24) - 12;
begin
  return case when v_off > 0 then 'Etc/GMT-' || v_off when v_off < 0 then 'Etc/GMT+' || (-v_off) else 'UTC' end;
end $$;

create function t129_booking(p_key text, p_arrive_in integer, p_nights integer, p_status text) returns uuid
language plpgsql as $$
declare v_res uuid; v_arr date := current_date + 30 + (random() * 300)::int; v_t date := property_today('00000000-0000-0000-0000-0000000000a2');
begin
  v_res := (create_hold('book.hotel-a.test', v_arr, v_arr + 2,
                        '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":1}]'::jsonb,
                        jsonb_build_object('full_name', 'Digest Guest', 'email', p_key || '@example.test'), p_key) ->> 'reservation_id')::uuid;
  set local session_replication_role = replica;
  delete from room_inventory_claims where reservation_room_id in (select id from reservation_rooms where reservation_id = v_res);
  update reservations set arrival_date = v_t + p_arrive_in, departure_date = v_t + p_arrive_in + p_nights, reservation_status = p_status where id = v_res;
  set local session_replication_role = origin;
  return v_res;
end $$;

-- 1. only property.configure sets it; blank turns it off; bad addresses refused; audited; anon refused
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_state text; begin
  perform t_sys();
  if (select digest_email from properties where id = v_p) is not null then raise exception 'FAIL should start off'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select set_daily_digest(%L, ''a@b.co'')', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select set_daily_digest(%L, ''a@b.co'')', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select set_daily_digest(%L, ''not an email'')', v_p), 'INVALID_EMAIL');
  perform t_expect(format('select set_daily_digest(%L, %L)', v_p, repeat('a', 250) || '@b.co'), 'INVALID_EMAIL');
  perform set_daily_digest(v_p, ' Owner@Hotel-A.test ');
  perform t_sys();
  if (select digest_email from properties where id = v_p) <> 'owner@hotel-a.test' then raise exception 'FAIL not saved lowercased'; end if;
  if not exists (select 1 from audit_logs where entity_id = v_p and action = 'property.updated' and metadata -> 'changed' ? 'digest_email') then raise exception 'FAIL not audited'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_daily_digest(v_p, '  ');
  perform t_sys();
  if (select digest_email from properties where id = v_p) is not null then raise exception 'FAIL blank did not turn it off'; end if;
  begin
    set local role anon;
    perform set_daily_digest(v_p, 'a@b.co');
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could call set_daily_digest'; end if;
  raise notice 'PASS daily digest: set by property.configure only, lowercased, blank is off, bad addresses refused, audited, anon refused';
end $$;

-- 2. nothing before 06:00 hotel time or with no address; then one row of counts, once a day
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t date; pl jsonb; n integer;
  a uuid; b uuid; c uuid; d uuid; e uuid;
begin
  perform t_sys();
  update properties set timezone = t129_zone(12) where id = v_p;
  v_t := property_today(v_p);
  a := t129_booking('t129-a', 0, 2, 'confirmed');    -- arrives today
  b := t129_booking('t129-b', -2, 2, 'checked_in');  -- leaves today
  c := t129_booking('t129-c', -1, 3, 'checked_in');  -- in house, leaves later
  d := t129_booking('t129-d', 1, 2, 'confirmed');    -- arrives tomorrow
  e := t129_booking('t129-e', 5, 2, 'pending');      -- a hold

  if queue_daily_digests() <> 0 then raise exception 'FAIL queued with no address'; end if;
  update properties set digest_email = 'owner@hotel-a.test', timezone = t129_zone(3) where id = v_p;
  if queue_daily_digests() <> 0 then raise exception 'FAIL queued before 06:00 hotel time'; end if;
  update properties set timezone = t129_zone(12) where id = v_p;
  v_t := property_today(v_p);
  n := queue_daily_digests();
  if n <> 1 then raise exception 'FAIL expected 1 queued, got %', n; end if;
  select payload into pl from digest_outbox where property_id = v_p and report_date = v_t;
  if pl is null then raise exception 'FAIL no row for today'; end if;
  if (pl ->> 'arrivals')::int <> (select count(*) from reservations where property_id = v_p and reservation_status = 'confirmed' and arrival_date = v_t)
     or (pl ->> 'departures')::int <> (select count(*) from reservations where property_id = v_p and reservation_status = 'checked_in' and departure_date = v_t)
     or (pl ->> 'in_house')::int <> (select count(*) from reservations where property_id = v_p and reservation_status = 'checked_in')
     or (pl ->> 'tomorrow')::int <> (select count(*) from reservations where property_id = v_p and reservation_status = 'confirmed' and arrival_date = v_t + 1)
     or (pl ->> 'holds')::int <> (select count(*) from reservations where property_id = v_p and reservation_status = 'pending') then
    raise exception 'FAIL counts do not match the bookings: %', pl;
  end if;
  if (pl ->> 'arrivals')::int < 1 or (pl ->> 'departures')::int < 1 or (pl ->> 'in_house')::int < 2 or (pl ->> 'tomorrow')::int < 1 or (pl ->> 'holds')::int < 1 then
    raise exception 'FAIL fixtures not counted: %', pl;
  end if;
  if pl::text ~* 'Digest Guest|example.test' then raise exception 'FAIL guest details in the digest: %', pl; end if;
  if (select to_email from digest_outbox where property_id = v_p and report_date = v_t) <> 'owner@hotel-a.test' then raise exception 'FAIL wrong recipient'; end if;
  if queue_daily_digests() <> 0 then raise exception 'FAIL a repeat the same day queued again'; end if;
  raise notice 'PASS daily digest: waits for 06:00 hotel time, counts only, once per day';
end $$;

-- 3. claim and result: exclusive, retries with backoff, five attempts, sent rows purged after 30 days
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; c jsonb; v_id uuid; r jsonb; begin
  perform t_sys();
  c := claim_digests(10);
  if jsonb_array_length(c) <> 1 or c -> 0 ->> 'to_email' <> 'owner@hotel-a.test' then raise exception 'FAIL claim %', c; end if;
  v_id := (c -> 0 ->> 'id')::uuid;
  if jsonb_array_length(claim_digests(10)) <> 0 then raise exception 'FAIL claimed twice'; end if;
  perform mark_digest_result(v_id, false, 'mail down');
  if (select status || attempts from digest_outbox where id = v_id) <> 'pending1' then raise exception 'FAIL not back to pending'; end if;
  if jsonb_array_length(claim_digests(10)) <> 0 then raise exception 'FAIL retried before backoff'; end if;
  update digest_outbox set next_attempt_at = now() where id = v_id;
  c := claim_digests(10);
  perform mark_digest_result(v_id, true);
  if (select status from digest_outbox where id = v_id) <> 'sent' then raise exception 'FAIL not sent'; end if;
  update digest_outbox set attempts = 5, status = 'sending' where id = v_id;
  perform mark_digest_result(v_id, false, 'x');
  if (select status from digest_outbox where id = v_id) <> 'failed' then raise exception 'FAIL fifth failure should stick'; end if;
  update digest_outbox set status = 'sent', sent_at = now() - interval '31 days' where id = v_id;
  r := purge_old_operational_data();
  if (r ->> 'digests')::int <> 1 then raise exception 'FAIL purge %', r; end if;
  raise notice 'PASS daily digest: exclusive claims, backoff, fifth failure sticks, old sent rows purged';
end $$;

-- 4. the worker functions are for the system only
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ begin
  begin perform queue_daily_digests(); raise exception 'FAIL authenticated queue_daily_digests';
  exception when insufficient_privilege then null; end;
  begin perform claim_digests(1); raise exception 'FAIL authenticated claim_digests';
  exception when insufficient_privilege then null; end;
  begin perform mark_digest_result(gen_random_uuid(), true); raise exception 'FAIL authenticated mark_digest_result';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
do $$ begin raise notice 'PASS daily digest: worker functions closed to authenticated callers'; end $$;

do $$ begin
  perform t_sys();
  update properties set digest_email = null, timezone = (select timezone from t129_orig) where id = '00000000-0000-0000-0000-0000000000a2';
end $$;
