-- Migration 192: record_folio_payment takes the time the money was taken (p_at). Reuses t_as / t_sys / t_expect / t_book / t_rr (05)
-- and t21_free_room (21). Users: aa04 front desk A (holds payment.record), aa02 housekeeping A (does not), bb01 owner of Hotel B.
-- Ids: a1 tenant A, a2 property A, a3 the STD room type.
--
-- A fresh database always has TODAY closed for hotel A (an earlier test closes it), and a closed day is exactly what the new rule
-- reacts to. So every scenario below runs in its own sub-transaction that starts by clearing the day closes (the guard trigger is
-- switched off inside it) and ends by raising ROLLBACK192, which undoes the clearing and everything the scenario recorded. Only the
-- reservation fixture in step 1 stays. Inside one DO block now() does not move, so times are compared exactly.
\set ON_ERROR_STOP on

create table t192_ctx (label text primary key, val text not null);
create function t192_res() returns uuid language sql stable as $$ select val::uuid from t192_ctx where label = 'res' $$;
create function t192_pay(p_result jsonb) returns folio_payments language sql stable as $$
  select * from folio_payments where id = (p_result ->> 'payment_id')::uuid $$;
create function t192_audit(p_result jsonb) returns jsonb language sql stable as $$
  select metadata from audit_logs where action = 'folio.payment_recorded' and entity_id = (p_result ->> 'payment_id')::uuid $$;
-- as the database owner: no day of hotel A is closed
create function t192_unclose() returns void language plpgsql as $$
begin
  alter table day_closes disable trigger day_closes_guard_trg;
  delete from day_closes where property_id = '00000000-0000-0000-0000-0000000000a2';
end $$;
create function t192_stamp(p_at timestamptz) returns text language sql stable as $$
  select 'Taken offline at ' || to_char(p_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC' $$;

-- 1. One function, closed to anon, and an in-house booking with extras owed
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); v_room text; v_book jsonb; v_rr uuid; v_n integer; v_oid oid;
begin
  perform t_sys();
  select count(*) into v_n from pg_proc where proname = 'record_folio_payment';
  if v_n <> 1 then raise exception 'FAIL expected one record_folio_payment, found %', v_n; end if;
  if to_regprocedure('record_folio_payment(uuid,bigint,text,text,text,text)') is not null then raise exception 'FAIL the old six-argument signature is still there'; end if;
  v_oid := to_regprocedure('record_folio_payment(uuid,bigint,text,text,text,text,timestamptz)');
  if v_oid is null then raise exception 'FAIL the seven-argument signature is missing'; end if;
  if not has_function_privilege('authenticated', v_oid, 'execute') then raise exception 'FAIL authenticated cannot call it'; end if;
  if has_function_privilege('anon', v_oid, 'execute') or has_function_privilege('public', v_oid, 'execute') then raise exception 'FAIL anon or public can call it'; end if;
  if not (select prosecdef from pg_proc where oid = v_oid) then raise exception 'FAIL not security definer'; end if;
  if (select proconfig from pg_proc where oid = v_oid) is distinct from array['search_path=public'] then raise exception 'FAIL search_path not pinned'; end if;
  v_oid := to_regprocedure('payment_effective_time(timestamptz,timestamptz)');
  if has_function_privilege('authenticated', v_oid, 'execute') or has_function_privilege('anon', v_oid, 'execute') then raise exception 'FAIL the time helper is callable from the API'; end if;

  v_room := t21_free_room();
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  v_book := t_book('00000000-0000-0000-0000-0000000000a3', t, t + 2, 'fol-192-0001', t21_room(v_room));
  v_rr := t_rr(v_book);
  perform check_in(v_rr, 'test');
  perform post_folio_charge((v_book ->> 'reservation_id')::uuid, 'minibar', 'Stock', 1, 100000000, 'k192-charge');
  perform t_sys();
  -- the booking is five days old, so the floor ("never before the booking existed") does not interfere unless a scenario sets it
  update reservations set created_at = now() - interval '5 days' where id = (v_book ->> 'reservation_id')::uuid;
  insert into t192_ctx values ('res', v_book ->> 'reservation_id');
  raise notice 'PASS 192 one seven-argument function, authenticated only, security definer, pinned search_path; time helper private; in-house booking with extras owed';
end $$;

-- 2. No time: exactly as before this migration
do $$ declare res uuid := t192_res(); r jsonb; p folio_payments;
begin
  begin
    perform t_as('00000000-0000-0000-0000-00000000aa04');
    r := record_folio_payment(res, 1000, 'cash', 'R-1', 'paid at desk', 'k192-none');
    perform t_sys();
    p := t192_pay(r);
    if p.received_at <> now() then raise exception 'FAIL received_at is not now (%)', p.received_at; end if;
    if p.note is distinct from 'paid at desk' then raise exception 'FAIL note changed: %', p.note; end if;
    if (t192_audit(r) ? 'made_at') or (t192_audit(r) ? 'day_closed') then raise exception 'FAIL audit carries a time that was not given: %', t192_audit(r); end if;
    if (r ->> 'balance_minor')::bigint <> 100000000 - 1000 then raise exception 'FAIL balance %', r; end if;
    raise exception 'ROLLBACK192';
  exception when others then if sqlerrm <> 'ROLLBACK192' then raise; end if;
  end;
  raise notice 'PASS 192 no time given: received now, note untouched, audit unchanged';
end $$;

-- 3. A time on an open day is kept, with the real time written in the note after the person's own words, and audited
do $$ declare res uuid := t192_res(); r jsonb; p folio_payments; at timestamptz := now() - interval '30 hours'; a jsonb;
begin
  begin
    perform t_sys(); perform t192_unclose();
    perform t_as('00000000-0000-0000-0000-00000000aa04');
    r := record_folio_payment(res, 2000, 'cash', null, 'taken at the desk', 'k192-time', at);
    perform t_sys();
    p := t192_pay(r); a := t192_audit(r);
    if p.received_at <> at then raise exception 'FAIL received_at % is not the time given %', p.received_at, at; end if;
    if p.note <> 'taken at the desk · ' || t192_stamp(at) then raise exception 'FAIL note: %', p.note; end if;
    if (a ->> 'made_at')::timestamptz <> at or (a ->> 'received_at')::timestamptz <> at or (a ->> 'day_closed')::boolean then raise exception 'FAIL audit %', a; end if;
    -- without a note of its own the note is the stamp alone
    r := record_folio_payment(res, 100, 'cash', null, null, 'k192-time-2', at);
    if (t192_pay(r)).note <> t192_stamp(at) then raise exception 'FAIL stamp alone: %', (t192_pay(r)).note; end if;
    raise exception 'ROLLBACK192';
  exception when others then if sqlerrm <> 'ROLLBACK192' then raise; end if;
  end;
  raise notice 'PASS 192 a time is kept: received_at is that time, note says when it was taken after the person''s words, audit has made_at, received_at, day_closed';
end $$;

-- 4. Close to now: kept, but no stamp (a change sent the moment the connection came back, or made online)
do $$ declare res uuid := t192_res(); r jsonb; p folio_payments; at timestamptz := now() - interval '30 seconds';
begin
  begin
    perform t_sys(); perform t192_unclose();
    perform t_as('00000000-0000-0000-0000-00000000aa04');
    r := record_folio_payment(res, 500, 'cash', null, 'quick', 'k192-near', at);
    perform t_sys();
    p := t192_pay(r);
    if p.received_at <> at then raise exception 'FAIL near time not kept: %', p.received_at; end if;
    if p.note <> 'quick' then raise exception 'FAIL a stamp was added within a minute: %', p.note; end if;
    raise exception 'ROLLBACK192';
  exception when others then if sqlerrm <> 'ROLLBACK192' then raise; end if;
  end;
  raise notice 'PASS 192 within a minute of now: time kept, no stamp';
end $$;

-- 5. A clock that is wrong is not believed: the future is moved to now, the far past to two days back, a time before the booking to its start
do $$ declare res uuid := t192_res(); r jsonb; p folio_payments;
begin
  begin
    perform t_sys(); perform t192_unclose();
    update reservations set created_at = now() - interval '10 hours' where id = res;                  -- the booking is ten hours old
    perform t_as('00000000-0000-0000-0000-00000000aa04');
    r := record_folio_payment(res, 100, 'cash', null, null, 'k192-future', now() + interval '1 day');
    perform t_sys();
    p := t192_pay(r);
    if p.received_at <> now() or p.note is not null then raise exception 'FAIL a time in the future: % / %', p.received_at, p.note; end if;
    perform t_as('00000000-0000-0000-0000-00000000aa04');
    r := record_folio_payment(res, 100, 'cash', null, null, 'k192-old', now() - interval '10 days');
    perform t_sys();
    p := t192_pay(r);
    -- the booking is ten hours old, so the floor (not the two-day bound) is what holds here
    if p.received_at <> now() - interval '10 hours' then raise exception 'FAIL before the booking existed: %', p.received_at; end if;
    if p.note <> t192_stamp(now() - interval '10 hours') then raise exception 'FAIL floor note: %', p.note; end if;
    -- a booking older than two days: the two-day bound holds
    update reservations set created_at = now() - interval '9 days' where id = res;
    perform t_as('00000000-0000-0000-0000-00000000aa04');
    r := record_folio_payment(res, 100, 'cash', null, null, 'k192-old-2', now() - interval '10 days');
    perform t_sys();
    p := t192_pay(r);
    if p.received_at <> now() - interval '2 days' then raise exception 'FAIL two-day bound: %', p.received_at; end if;
    if p.note <> t192_stamp(now() - interval '2 days') then raise exception 'FAIL two-day note: %', p.note; end if;
    raise exception 'ROLLBACK192';
  exception when others then if sqlerrm <> 'ROLLBACK192' then raise; end if;
  end;
  raise notice 'PASS 192 bounds: future moved to now, never before the booking existed, never more than two days back; moved times are stamped as moved';
end $$;

-- 6. A signed-off day is never added to: the payment is recorded now and says so; an open day beside it is unaffected
do $$ declare res uuid := t192_res(); r jsonb; p folio_payments; at timestamptz := now() - interval '30 hours'; a jsonb; d date; v_closed_row text; v_after text;
begin
  begin
    perform t_sys(); perform t192_unclose();
    d := (at at time zone (select timezone from properties where id = '00000000-0000-0000-0000-0000000000a2'))::date;
    insert into day_closes (tenant_id, property_id, business_date, figures, open_items, closed_by)
    values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', d, '{"cash": 0}', '{}', '00000000-0000-0000-0000-00000000aa01');
    select to_jsonb(c)::text into v_closed_row from day_closes c where business_date = d and property_id = '00000000-0000-0000-0000-0000000000a2';
    perform t_as('00000000-0000-0000-0000-00000000aa04');
    r := record_folio_payment(res, 3000, 'cash', null, 'late', 'k192-closed', at);
    perform t_sys();
    p := t192_pay(r); a := t192_audit(r);
    if p.received_at <> now() then raise exception 'FAIL a closed day was added to: %', p.received_at; end if;
    if p.note <> 'late · ' || t192_stamp(at) || '; that day is closed, recorded today' then raise exception 'FAIL closed-day note: %', p.note; end if;
    if not (a ->> 'day_closed')::boolean or (a ->> 'made_at')::timestamptz <> at or (a ->> 'received_at')::timestamptz <> now() then raise exception 'FAIL closed-day audit %', a; end if;
    select to_jsonb(c)::text into v_after from day_closes c where business_date = d and property_id = '00000000-0000-0000-0000-0000000000a2';
    if v_after is distinct from v_closed_row then raise exception 'FAIL the closed day changed'; end if;
    -- money taken on a day that is still open is dated normally
    perform t_as('00000000-0000-0000-0000-00000000aa04');
    r := record_folio_payment(res, 200, 'cash', null, null, 'k192-open-beside', now() - interval '2 hours');
    perform t_sys();
    if (t192_pay(r)).received_at <> now() - interval '2 hours' or (t192_audit(r) ->> 'day_closed')::boolean then raise exception 'FAIL an open day was treated as closed'; end if;
    raise exception 'ROLLBACK192';
  exception when others then if sqlerrm <> 'ROLLBACK192' then raise; end if;
  end;
  raise notice 'PASS 192 closed day: payment recorded now with the real time in the note and audit; the closed day is untouched; an open day is dated normally';
end $$;

-- 7. A repeat is answered with the first answer whatever time it carries; a changed request is still refused; the time is not in the hash
do $$ declare res uuid := t192_res(); r1 jsonb; r2 jsonb; r3 jsonb; v_n integer;
begin
  begin
    perform t_sys(); perform t192_unclose();
    perform t_as('00000000-0000-0000-0000-00000000aa04');
    r1 := record_folio_payment(res, 700, 'cash', 'R-9', 'once', 'k192-idem', now() - interval '30 hours');
    r2 := record_folio_payment(res, 700, 'cash', 'R-9', 'once', 'k192-idem', now() - interval '29 hours');   -- a different clamped time on a retry
    r3 := record_folio_payment(res, 700, 'cash', 'R-9', 'once', 'k192-idem');                                 -- and no time at all
    if r1 <> r2 or r1 <> r3 then raise exception 'FAIL a repeat did not return the first answer: % / % / %', r1, r2, r3; end if;
    perform t_sys();
    select count(*) into v_n from folio_payments where reservation_id = res and provider_reference = 'R-9';
    if v_n <> 1 then raise exception 'FAIL % payments recorded for one key', v_n; end if;
    perform t_as('00000000-0000-0000-0000-00000000aa04');
    perform t_expect(format('select record_folio_payment(%L, 701, %L, %L, %L, %L, now())', res, 'cash', 'R-9', 'once', 'k192-idem'), 'IDEMPOTENCY_MISMATCH');
    perform t_expect(format('select record_folio_payment(%L, 700, %L, %L, %L, %L, now())', res, 'cash', 'R-9', 'changed note', 'k192-idem'), 'IDEMPOTENCY_MISMATCH');
    raise exception 'ROLLBACK192';
  exception when others then if sqlerrm <> 'ROLLBACK192' then raise; end if;
  end;
  raise notice 'PASS 192 idempotency: a repeat with another or no time returns the first answer once; a different amount or note is still refused';
end $$;

-- 8. Every other rule still holds when a time is given
do $$ declare res uuid := t192_res(); v_n integer; v_long text := repeat('n', 500); p folio_payments; r jsonb; v_book jsonb;
  t date := property_today('00000000-0000-0000-0000-0000000000a2');
begin
  begin
    perform t_sys(); perform t192_unclose();
    perform t_as('00000000-0000-0000-0000-00000000aa04');
    perform t_expect(format('select record_folio_payment(%L, 100000001, %L, null, null, %L, now() - interval %L)', res, 'cash', 'k192-over', '30 hours'), 'POLICY_VIOLATION: OVERPAYMENT');
    perform t_expect(format('select record_folio_payment(%L, 0, %L, null, null, %L, now())', res, 'cash', 'k192-zero'), 'POLICY_VIOLATION: amount');
    perform t_expect(format('select record_folio_payment(%L, 100, %L, null, null, %L, now())', res, 'bitcoin', 'k192-method'), 'POLICY_VIOLATION: payment method');
    perform t_expect(format('select record_folio_payment(%L, 100, %L, null, %L, %L, now())', res, 'cash', repeat('n', 501), 'k192-long'), 'POLICY_VIOLATION: too long');
    perform t_as('00000000-0000-0000-0000-00000000aa02');                                        -- housekeeping holds no payment.record
    perform t_expect(format('select record_folio_payment(%L, 100, %L, null, null, %L, now() - interval %L)', res, 'cash', 'k192-hk', '1 hour'), 'NOT_FOUND');
    perform t_as('00000000-0000-0000-0000-00000000bb01');                                        -- another hotel
    perform t_expect(format('select record_folio_payment(%L, 100, %L, null, null, %L, now() - interval %L)', res, 'cash', 'k192-b', '1 hour'), 'NOT_FOUND');
    perform t_sys();
    select count(*) into v_n from folio_payments where reservation_id = res;
    if v_n <> 0 then raise exception 'FAIL % payments recorded by refused calls', v_n; end if;
    -- the largest own note still fits once the stamp is added, and the stamp is kept
    perform t_as('00000000-0000-0000-0000-00000000aa04');
    r := record_folio_payment(res, 100, 'cash', null, v_long, 'k192-trim', now() - interval '30 hours');
    perform t_sys();
    p := t192_pay(r);
    if length(p.note) > 500 or p.note not like '%' || t192_stamp(now() - interval '30 hours') or p.note not like 'nnnn%' then raise exception 'FAIL trimmed note (% chars)', length(p.note); end if;
    -- a booking that has not arrived still takes no payment
    perform t_as('00000000-0000-0000-0000-00000000aa04');
    v_book := t_book('00000000-0000-0000-0000-0000000000a3', t + 300, t + 301, 'fol-192-0002');
    perform t_expect(format('select record_folio_payment(%L, 100, %L, null, null, %L, now())', v_book ->> 'reservation_id', 'cash', 'k192-state'), 'INVALID_STATE');
    raise exception 'ROLLBACK192';
  exception when others then if sqlerrm <> 'ROLLBACK192' then raise; end if;
  end;
  raise notice 'PASS 192 other rules hold with a time: overpayment, amount, method, length, permission, other hotel, booking state, note kept inside 500 characters';
end $$;
