-- Email outbox (triggers, claim/mark lifecycle), link re-issue, rate limits, access limits (migration 015).
-- Reuses t06_hold / t06_expect_err (06), t07_res (07), t08_online / t08_conf (08), t_as / t_sys (05).
-- Offsets 260 to 275 are used here. Everything pending from earlier files is marked sent first so
-- these tests see only their own emails.
\set ON_ERROR_STOP on

update email_outbox set status = 'sent', sent_at = now() where status <> 'sent';

create function t12_count(p_kind text, p_email text) returns integer language sql as $$
  select count(*)::integer from email_outbox where kind = p_kind and to_email = lower(p_email)
$$;

-- 1. A website hold queues one booking_held email; replays and staff bookings queue nothing more
do $$ declare h jsonb; v_res uuid; begin
  h := t06_hold(p_off => 260, p_key => 't12-hold-1', p_guest => '{"full_name":"Em One","email":"Em1@Example.com"}'::jsonb);
  if t12_count('booking_held', 'em1@example.com') <> 1 then raise exception 'FAIL held email not queued once'; end if;
  perform t06_hold(p_off => 260, p_key => 't12-hold-1', p_guest => '{"full_name":"Em One","email":"Em1@Example.com"}'::jsonb);
  if t12_count('booking_held', 'em1@example.com') <> 1 then raise exception 'FAIL replay queued another email'; end if;
  v_res := t07_res(262, 1, 't12-staff-1');
  if exists (select 1 from email_outbox where reservation_id = v_res) then raise exception 'FAIL staff booking queued an email'; end if;
  if (select status from email_outbox where kind = 'booking_held' and to_email = 'em1@example.com') <> 'pending' then raise exception 'FAIL status'; end if;
  -- a refused hold rolls its email back with it
  perform t06_expect_err($q$select t06_hold(p_off => 260, p_nights => 31, p_guest => '{"full_name":"Em Bad","email":"embad@example.com"}'::jsonb)$q$, 'POLICY_VIOLATION%');
  if t12_count('booking_held', 'embad@example.com') <> 0 then raise exception 'FAIL refused hold left an email'; end if;
  raise notice 'PASS held email: queued once, not for replays or staff bookings, rolled back with a refused hold';
end $$;

-- 2. Payment confirmation queues booking_confirmed once; a mismatch queues nothing
do $$ declare v_res uuid; begin
  v_res := t08_online('em2', 264);
  perform t08_conf('em2', 'evt-em2-1');
  perform t08_conf('em2', 'evt-em2-2');
  if t12_count('booking_confirmed', 'em2@example.com') <> 1 or t12_count('booking_held', 'em2@example.com') <> 1
    then raise exception 'FAIL confirmation emails'; end if;
  perform t08_online('em3', 266);
  perform t08_conf('em3', 'evt-em3-1', p_amount => (select amount - 1 from t08_ctx where label = 'em3'));
  if t12_count('booking_confirmed', 'em3@example.com') <> 0 then raise exception 'FAIL mismatch queued a confirmation'; end if;
  raise notice 'PASS confirmation email queued once; none for a mismatched payment';
end $$;

-- 3. A successful refund queues refund_processed once (website bookings only)
do $$ declare v_res uuid; v_pay uuid; v_ref uuid; v_amt bigint; r jsonb; begin
  select res into v_res from t08_ctx where label = 'em2';
  select id, amount_minor into v_pay, v_amt from payments where reservation_id = v_res;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  v_ref := (request_refund(v_pay, v_amt, 'email test', 't12-rq') ->> 'refund_id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform approve_refund(v_ref, true, null, 't12-ap');
  perform t_sys();
  perform begin_refund_processing(v_ref);
  if t12_count('refund_processed', 'em2@example.com') <> 0 then raise exception 'FAIL refund email before success'; end if;
  perform record_refund_result('paystack', 'evt-em2-refund', v_ref, 'succeeded', 'rf_em2');
  perform record_refund_result('paystack', 'evt-em2-refund', v_ref, 'succeeded', 'rf_em2');
  if t12_count('refund_processed', 'em2@example.com') <> 1 then raise exception 'FAIL refund email count'; end if;
  select payload into r from email_outbox where kind = 'refund_processed' and to_email = 'em2@example.com';
  if (r ->> 'amount_minor')::bigint <> v_amt or r ->> 'currency' <> 'NGN' then raise exception 'FAIL refund payload %', r; end if;
  raise notice 'PASS refund email queued once with the amount';
end $$;

-- 4. Claim, send, retry with backoff, give up, and recover a stuck worker
do $$ declare c jsonb; c2 jsonb; id1 uuid; id2 uuid; id3 uuid; e email_outbox%rowtype; begin
  update email_outbox set status = 'sent', sent_at = now() where status <> 'sent';
  perform t06_hold(p_off => 268, p_guest => '{"full_name":"Q One","email":"q1@example.com"}'::jsonb);
  perform t06_hold(p_off => 268, p_guest => '{"full_name":"Q Two","email":"q2@example.com"}'::jsonb);
  perform t06_hold(p_off => 268, p_guest => '{"full_name":"Q Three","email":"q3@example.com"}'::jsonb);

  c := claim_emails(2);
  if jsonb_array_length(c) <> 2 then raise exception 'FAIL claim size %', c; end if;
  if (c -> 0 ->> 'kind') <> 'booking_held' or (c -> 0 ->> 'site_host') <> 'book.hotel-a.test' or (c -> 0 ->> 'attempt')::int <> 1
     or (c -> 0 -> 'booking' ->> 'booking_reference') not like 'BK-%' or (c -> 0 ->> 'to_email') not like 'q%@example.com'
    then raise exception 'FAIL claimed shape %', c -> 0; end if;
  id1 := (c -> 0 ->> 'id')::uuid; id2 := (c -> 1 ->> 'id')::uuid;
  c2 := claim_emails(10);
  if jsonb_array_length(c2) <> 1 or (c2 -> 0 ->> 'id')::uuid in (id1, id2) then raise exception 'FAIL second claim overlaps %', c2; end if;
  id3 := (c2 -> 0 ->> 'id')::uuid;
  if jsonb_array_length(claim_emails(10)) <> 0 then raise exception 'FAIL claimed rows claimed again'; end if;

  perform mark_email_result(id1, true);
  perform mark_email_result(id2, false, 'provider said no');
  select * into e from email_outbox where id = id1;
  if e.status <> 'sent' or e.sent_at is null then raise exception 'FAIL sent mark'; end if;
  select * into e from email_outbox where id = id2;
  if e.status <> 'pending' or e.last_error <> 'provider said no' or e.next_attempt_at <= now() + interval '4 minutes' then raise exception 'FAIL backoff %', e; end if;
  perform mark_email_result(id1, false, 'late failure');                  -- already sent: ignored
  if (select status from email_outbox where id = id1) <> 'sent' then raise exception 'FAIL sent row changed'; end if;
  if (select count(*) from jsonb_array_elements(claim_emails(10)) x where (x ->> 'id')::uuid = id2) <> 0 then raise exception 'FAIL claimed during backoff'; end if;

  -- retries up to 5 attempts, then failed for good
  for i in 2..5 loop
    update email_outbox set next_attempt_at = now() where id = id2;
    c := claim_emails(10);
    if (select count(*) from jsonb_array_elements(c) x where (x ->> 'id')::uuid = id2 and (x ->> 'attempt')::int = i) <> 1 then raise exception 'FAIL retry %', i; end if;
    perform mark_email_result(id2, false, 'still failing');
  end loop;
  if (select status from email_outbox where id = id2) <> 'failed' then raise exception 'FAIL not failed after 5 attempts'; end if;
  update email_outbox set next_attempt_at = now() where id = id2;
  if jsonb_array_length(claim_emails(10)) <> 0 then raise exception 'FAIL failed email claimed again'; end if;

  -- a worker that died: its 'sending' row comes back after 10 minutes
  update email_outbox set updated_at = now() - interval '11 minutes' where id = id3;
  c := claim_emails(10);
  if (select count(*) from jsonb_array_elements(c) x where (x ->> 'id')::uuid = id3 and (x ->> 'attempt')::int = 2) <> 1 then raise exception 'FAIL stuck row not reclaimed %', c; end if;
  perform mark_email_result(id3, true);
  perform t06_expect_err($q$select claim_emails(0)$q$, 'POLICY_VIOLATION%');
  raise notice 'PASS outbox: claim is exclusive, success/failure marks, backoff, five attempts, stuck worker recovery';
end $$;

-- 5. Link re-issue
do $$ declare v_ref text; v_res uuid; n integer; begin
  select r.booking_reference, r.id into v_ref, v_res from reservations r join guests g on g.id = r.primary_guest_id where g.email = 'em2@example.com';
  update email_outbox set status = 'sent', sent_at = now() where status <> 'sent';
  if not request_booking_link('book.hotel-a.test', '  ' || lower(v_ref) || ' ', ' EM2@example.com ') then raise exception 'FAIL matching request not queued'; end if;
  if t12_count('booking_link', 'em2@example.com') <> 1 then raise exception 'FAIL link email missing'; end if;
  if request_booking_link('book.hotel-a.test', v_ref, 'someone.else@example.com') then raise exception 'FAIL wrong email matched'; end if;
  if request_booking_link('book.hotel-a.test', 'BK-NOSUCH', 'em2@example.com') then raise exception 'FAIL unknown reference matched'; end if;
  if request_booking_link('hotel-b.test', v_ref, 'em2@example.com') then raise exception 'FAIL matched across hotels'; end if;
  if request_booking_link('book.hotel-a.test', repeat('x', 50), 'em2@example.com') then raise exception 'FAIL oversize input matched'; end if;
  select count(*) into n from email_outbox where kind = 'booking_link' and status = 'pending';
  if n <> 1 then raise exception 'FAIL non-matching requests queued emails (%)', n; end if;
  perform t06_expect_err($q$select request_booking_link('nobody.example', 'BK-X', 'a@example.com')$q$, 'NOT_FOUND: host%');
  raise notice 'PASS link re-issue: matches reference plus email within one hotel, queues nothing otherwise';
end $$;

-- 6. Rate limits
do $$ declare r jsonb; begin
  for i in 1..3 loop
    r := consume_rate_limit('t12:k1', 3, 3600);
    if (r ->> 'allowed') <> 'true' or (r ->> 'hits')::int <> i then raise exception 'FAIL hit % %', i, r; end if;
  end loop;
  r := consume_rate_limit('t12:k1', 3, 3600);
  if (r ->> 'allowed') <> 'false' or (r ->> 'retry_after_seconds')::int not between 1 and 3600 then raise exception 'FAIL over limit %', r; end if;
  r := consume_rate_limit('t12:k1', 3, 3600);
  if (r ->> 'allowed') <> 'false' then raise exception 'FAIL still over limit'; end if;
  if (consume_rate_limit('t12:k2', 3, 3600) ->> 'allowed') <> 'true' then raise exception 'FAIL keys not independent'; end if;
  perform t06_expect_err($q$select consume_rate_limit('', 3, 60)$q$, 'POLICY_VIOLATION%');
  perform t06_expect_err($q$select consume_rate_limit('k', 0, 60)$q$, 'POLICY_VIOLATION%');
  perform t06_expect_err($q$select consume_rate_limit('k', 3, 0)$q$, 'POLICY_VIOLATION%');
  perform t06_expect_err(format('select consume_rate_limit(%L, 3, 60)', repeat('x', 201)), 'POLICY_VIOLATION%');
  insert into rate_limit_hits (key, window_start, hits) values ('t12:old', now() - interval '3 days', 5);
  insert into email_outbox (tenant_id, reservation_id, kind, to_email, status, sent_at, dedupe_key)
    select tenant_id, id, 'booking_link', 'old@example.com', 'sent', now() - interval '100 days', 'old-1' from reservations limit 1;
  r := purge_old_operational_data();
  if (r ->> 'rate_limit_rows')::int < 1 or (r ->> 'emails')::int < 1 or exists (select 1 from rate_limit_hits where key = 't12:old') then raise exception 'FAIL purge %', r; end if;
  if not exists (select 1 from rate_limit_hits where key = 't12:k1') then raise exception 'FAIL purge removed a current window'; end if;
  raise notice 'PASS rate limit: counts per key and window, refuses over the limit, validates input, purges old rows';
end $$;

-- 7. Closed to everyone but service_role; tables unreadable by clients
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ begin
  begin perform claim_emails(1); raise exception 'FAIL authenticated claim_emails'; exception when insufficient_privilege then null; end;
  begin perform mark_email_result(gen_random_uuid(), true); raise exception 'FAIL authenticated mark_email_result'; exception when insufficient_privilege then null; end;
  begin perform request_booking_link('book.hotel-a.test', 'BK-X', 'a@example.com'); raise exception 'FAIL authenticated request_booking_link'; exception when insufficient_privilege then null; end;
  begin perform consume_rate_limit('k', 1, 60); raise exception 'FAIL authenticated consume_rate_limit'; exception when insufficient_privilege then null; end;
  begin perform purge_old_operational_data(); raise exception 'FAIL authenticated purge'; exception when insufficient_privilege then null; end;
  begin perform count(*) from email_outbox; raise exception 'FAIL authenticated read outbox'; exception when insufficient_privilege then null; end;
  begin perform count(*) from rate_limit_hits; raise exception 'FAIL authenticated read rate limits'; exception when insufficient_privilege then null; end;
end $$;
rollback;
do $$ begin raise notice 'PASS email and rate limit functions are closed to authenticated callers'; end $$;

-- Race fixture: 20 pending emails, 30 workers each claiming one at a time
update email_outbox set status = 'sent', sent_at = now() where status <> 'sent';
insert into email_outbox (tenant_id, reservation_id, kind, to_email, dedupe_key)
select tenant_id, id, 'booking_link', 'race@example.com', 'race-' || g
  from (select * from reservations limit 1) r, generate_series(1, 20) g;
create table t12_claims (email_id uuid);
create function test_try_claim(p_label text) returns boolean language plpgsql as $$
declare c jsonb;
begin
  c := claim_emails(1);
  if jsonb_array_length(c) = 1 then
    insert into t12_claims values ((c -> 0 ->> 'id')::uuid);
    insert into test_results (label, ok) values (p_label, true);
    return true;
  end if;
  insert into test_results (label, ok) values (p_label, false);
  return false;
end $$;
