-- Provider payments: create_payment_attempt, confirm_payment, expire_lapsed_holds.
-- Reuses t06_hold / t06_expect_err / t06_out (06_holds.sql) and t_book / t_expect (05_operations.sql).
-- Online reservations come from create_hold on book.hotel-a.test. Offsets 190 to 215 are used here.
-- Ids: a1 tenant A, a2 property A, a3 STD type (5 rooms), a4 SOLO type (1 room).
\set ON_ERROR_STOP on

create table t08_ctx (label text primary key, res uuid, ref text, amount bigint);

-- Online reservation with a live hold and (optionally) a payment attempt
create function t08_online(p_label text, p_off integer, p_type uuid default '00000000-0000-0000-0000-0000000000a3', p_attempt boolean default true)
returns uuid language plpgsql as $$
declare h jsonb; a jsonb; v_res uuid;
begin
  h := t06_hold(p_off => p_off, p_nights => 2,
                p_rooms => jsonb_build_array(jsonb_build_object('room_type_id', p_type, 'adults', 1)),
                p_guest => jsonb_build_object('full_name', 'Pay Guest', 'email', p_label || '@example.com'));
  v_res := (h ->> 'reservation_id')::uuid;
  insert into t08_ctx (label, res) values (p_label, v_res);
  if p_attempt then
    a := create_payment_attempt(v_res, 't08-attempt-' || p_label);
    update t08_ctx set ref = a ->> 'reference', amount = (a ->> 'amount_minor')::bigint where label = p_label;
  end if;
  return v_res;
end $$;
create function t08_conf(p_label text, p_event text, p_status text default 'success', p_amount bigint default null, p_currency text default 'NGN')
returns jsonb language sql as $$
  select confirm_payment('paystack', p_event, 'charge.' || p_status, c.ref, p_status, coalesce(p_amount, c.amount), p_currency, 'card', '{}'::jsonb)
    from t08_ctx c where c.label = p_label
$$;

-- 1. Nobody but service_role can call these
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ begin
  begin perform create_payment_attempt(gen_random_uuid(), 'k'); raise exception 'FAIL authenticated create_payment_attempt';
  exception when insufficient_privilege then null; end;
  begin perform confirm_payment('paystack', 'e', 't', 'r', 'success', 1, 'NGN', 'card'); raise exception 'FAIL authenticated confirm_payment';
  exception when insufficient_privilege then null; end;
  begin perform expire_lapsed_holds(); raise exception 'FAIL authenticated expire_lapsed_holds';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
begin;
set local role anon;
set local request.jwt.claims = '{"role":"service_role"}';
do $$ begin
  begin perform confirm_payment('paystack', 'e', 't', 'r', 'success', 1, 'NGN', 'card'); raise exception 'FAIL anon confirm_payment';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
do $$ begin raise notice 'PASS provider payment functions are closed to authenticated and anon callers'; end $$;

-- 2. Attempts: provider account required, amount decided by policy, idempotent, hold must be live
do $$ declare h jsonb; v_res uuid; a jsonb; b jsonb; c jsonb; v_total bigint; begin
  h := t06_hold(p_off => 190, p_guest => '{"full_name":"Att Guest","email":"att@example.com"}'::jsonb);
  v_res := (h ->> 'reservation_id')::uuid;
  v_total := (h ->> 'total_minor')::bigint;
  perform t06_expect_err(format('select create_payment_attempt(%L, ''t08-noacct'')', v_res), 'INVALID_STATE: no payment provider configured%');
  insert into payment_provider_accounts (tenant_id, provider, mode, account_label, secret_reference, status)
  values ('00000000-0000-0000-0000-0000000000a1', 'paystack', 'test', 'Hotel A test', 'vault://hotel-a/paystack-test', 'active');

  a := create_payment_attempt(v_res, 't08-att-1');
  if (a ->> 'amount_minor')::bigint <> v_total or a ->> 'currency' <> 'NGN' or (a ->> 'reference') not like 'HMS-%' then raise exception 'FAIL attempt %', a; end if;
  if create_payment_attempt(v_res, 't08-att-1') <> a then raise exception 'FAIL attempt replay differs'; end if;
  b := create_payment_attempt(v_res, 't08-att-2');
  if b ->> 'reference' = a ->> 'reference' then raise exception 'FAIL second attempt reused reference'; end if;
  if (select count(*) from payment_attempts where reservation_id = v_res) <> 2 then raise exception 'FAIL attempt count'; end if;

  -- policy: 30 percent deposit
  update reservations set policy_snapshot = policy_snapshot || '{"online_payment":{"mode":"deposit_percent","value":30}}'::jsonb where id = v_res;
  c := create_payment_attempt(v_res, 't08-att-3');
  if (c ->> 'amount_minor')::bigint <> ceil(v_total * 0.30)::bigint then raise exception 'FAIL deposit amount %', c; end if;

  -- a lapsed hold cannot start a payment
  update room_inventory_claims set hold_expires_at = now() - interval '1 minute'
   where reservation_room_id in (select id from reservation_rooms where reservation_id = v_res);
  perform t06_expect_err(format('select create_payment_attempt(%L, ''t08-att-4'')', v_res), 'INVALID_STATE: hold lapsed%');
  perform t06_expect_err(format('select create_payment_attempt(%L, ''t08-att-5'')', gen_random_uuid()), 'NOT_FOUND%');
  raise notice 'PASS attempts: provider account needed, policy amount, idempotent, lapsed hold refused';
end $$;

-- 3. Success through the PostgREST call shape: hold becomes a stay, reservation confirmed and paid
do $$ begin perform t08_online('happy', 192); end $$;
select ref as ref_h, amount as amt_h from t08_ctx where label = 'happy' \gset
begin;
set local session authorization authenticator;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
insert into t06_out values ('svc_confirm',
  confirm_payment('paystack', 'evt-happy-1', 'charge.success', :'ref_h', 'success', :amt_h, 'NGN', 'card', '{"data":{"id":1}}'::jsonb));
commit;
do $$ declare r jsonb; v_res uuid; v_dup jsonb; v_again jsonb; begin
  select result into r from t06_out where label = 'svc_confirm';
  select res into v_res from t08_ctx where label = 'happy';
  if r ->> 'result' <> 'confirmed' or r ->> 'reservation_status' <> 'confirmed' or r ->> 'payment_status' <> 'paid' then raise exception 'FAIL confirm %', r; end if;
  if (select count(*) from room_inventory_claims c join reservation_rooms rr on rr.id = c.reservation_room_id
       where rr.reservation_id = v_res and c.claim_type = 'stay' and c.status = 'active' and c.hold_expires_at is null) <> 1
     or exists (select 1 from room_inventory_claims c join reservation_rooms rr on rr.id = c.reservation_room_id
                 where rr.reservation_id = v_res and c.claim_type = 'hold' and c.status = 'active') then raise exception 'FAIL hold not converted'; end if;
  if not exists (select 1 from payments where reservation_id = v_res and payment_provider = 'paystack' and payment_method = 'card'
                    and amount_minor = (select amount from t08_ctx where label = 'happy')) then raise exception 'FAIL payment row'; end if;
  if (select processing_status from payment_events where provider_event_id = 'evt-happy-1') <> 'processed' then raise exception 'FAIL event status'; end if;
  if (select status from payment_attempts where reference = (select ref from t08_ctx where label = 'happy')) <> 'succeeded' then raise exception 'FAIL attempt status'; end if;
  -- same event again, and another event for the same reference: nothing is recorded twice
  v_dup := t08_conf('happy', 'evt-happy-1');
  v_again := t08_conf('happy', 'evt-happy-2');
  if v_dup ->> 'duplicate' <> 'true' or v_dup ->> 'result' <> 'confirmed' then raise exception 'FAIL duplicate %', v_dup; end if;
  if v_again ->> 'result' <> 'already_processed' then raise exception 'FAIL second event %', v_again; end if;
  if (select count(*) from payments where reservation_id = v_res) <> 1 then raise exception 'FAIL double payment'; end if;
  raise notice 'PASS verified success confirms the booking, converts holds, ignores repeats';
end $$;

-- 4. Mismatches record no money and flag the reservation
do $$ declare r1 jsonb; r2 jsonb; v_res uuid; begin
  v_res := t08_online('mm1', 194);
  r1 := t08_conf('mm1', 'evt-mm1-1', p_amount => (select amount - 1 from t08_ctx where label = 'mm1'));
  if r1 ->> 'result' <> 'mismatch' then raise exception 'FAIL amount mismatch %', r1; end if;
  if exists (select 1 from payments where reservation_id = v_res) then raise exception 'FAIL mismatch recorded money'; end if;
  if (select attention_reason from reservations where id = v_res) <> 'payment_amount_or_currency_mismatch'
     or (select reservation_status from reservations where id = v_res) <> 'pending'
     or (select status from payment_attempts where reference = (select ref from t08_ctx where label = 'mm1')) <> 'needs_attention'
     then raise exception 'FAIL mismatch flags'; end if;
  r2 := t08_conf('mm1', 'evt-mm1-2');                         -- a later event cannot resurrect it
  if r2 ->> 'result' <> 'ignored' then raise exception 'FAIL needs_attention not terminal %', r2; end if;

  v_res := t08_online('mm2', 196);
  r1 := t08_conf('mm2', 'evt-mm2-1', p_currency => 'USD');
  if r1 ->> 'result' <> 'mismatch' or exists (select 1 from payments where reservation_id = v_res) then raise exception 'FAIL currency mismatch %', r1; end if;
  raise notice 'PASS wrong amount or currency records no money and needs attention';
end $$;

-- 5. Failed payment, then a successful retry on a new attempt
do $$ declare v_res uuid; r jsonb; a jsonb; begin
  v_res := t08_online('fail1', 198);
  r := t08_conf('fail1', 'evt-fail1-1', 'failed');
  if r ->> 'result' <> 'failed' or (select payment_status from reservations where id = v_res) <> 'payment_failed'
     or (select reservation_status from reservations where id = v_res) <> 'pending' then raise exception 'FAIL failure handling %', r; end if;
  a := create_payment_attempt(v_res, 't08-attempt-fail1-retry');
  update t08_ctx set ref = a ->> 'reference', amount = (a ->> 'amount_minor')::bigint where label = 'fail1';
  r := t08_conf('fail1', 'evt-fail1-2');
  if r ->> 'result' <> 'confirmed' or r ->> 'payment_status' <> 'paid' then raise exception 'FAIL retry after failure %', r; end if;
  raise notice 'PASS failed payment keeps the hold; a successful retry confirms and clears payment_failed';
end $$;

-- 6. Late payment: hold time passed but nobody took the room (claim still active)
do $$ declare v_res uuid; r jsonb; begin
  v_res := t08_online('late1', 200);
  update room_inventory_claims set hold_expires_at = now() - interval '5 minutes'
   where reservation_room_id in (select id from reservation_rooms where reservation_id = v_res);
  r := t08_conf('late1', 'evt-late1-1');
  if r ->> 'result' <> 'confirmed' then raise exception 'FAIL late payment %', r; end if;
  raise notice 'PASS late payment keeps an unclaimed room';
end $$;

-- 7. Sweep and recovery: expired reservation re-claims its room; sweep leaves live and recent ones alone
do $$ declare v_fresh uuid; v_busy uuid; v_exp uuid; v_room_before uuid; v_room_after uuid; r jsonb; n integer; begin
  v_fresh := t08_online('fresh', 202, p_attempt => false);
  v_busy  := t08_online('busy', 204);                       -- hold lapsed but a payment started minutes ago
  update room_inventory_claims set hold_expires_at = now() - interval '2 minutes'
   where reservation_room_id in (select id from reservation_rooms where reservation_id = v_busy);
  v_exp := t08_online('exp1', 206);
  select c.room_id into v_room_before from room_inventory_claims c join reservation_rooms rr on rr.id = c.reservation_room_id where rr.reservation_id = v_exp;
  update room_inventory_claims set hold_expires_at = now() - interval '2 minutes'
   where reservation_room_id in (select id from reservation_rooms where reservation_id = v_exp);
  update payment_attempts set created_at = now() - interval '1 hour' where reservation_id = v_exp;

  n := expire_lapsed_holds();
  if n < 1 then raise exception 'FAIL sweep expired nothing'; end if;
  if (select reservation_status from reservations where id = v_exp) <> 'expired'
     or exists (select 1 from room_inventory_claims c join reservation_rooms rr on rr.id = c.reservation_room_id where rr.reservation_id = v_exp and c.status = 'active')
     then raise exception 'FAIL lapsed reservation not expired'; end if;
  if (select reservation_status from reservations where id = v_fresh) <> 'pending' then raise exception 'FAIL sweep touched a live hold'; end if;
  if (select reservation_status from reservations where id = v_busy) <> 'pending' then raise exception 'FAIL sweep touched a payment in progress'; end if;
  perform t06_expect_err(format('select create_payment_attempt(%L, ''t08-exp-new'')', v_exp), 'INVALID_STATE: expired%');
  if expire_lapsed_holds() <> 0 and (select reservation_status from reservations where id = v_exp) <> 'expired' then raise exception 'FAIL sweep not stable'; end if;

  r := t08_conf('exp1', 'evt-exp1-1');                      -- the payer finished anyway
  if r ->> 'result' <> 'confirmed' or r ->> 'reservation_status' <> 'confirmed' then raise exception 'FAIL recovery %', r; end if;
  select c.room_id into v_room_after from room_inventory_claims c join reservation_rooms rr on rr.id = c.reservation_room_id
   where rr.reservation_id = v_exp and c.status = 'active' and c.claim_type = 'stay';
  if v_room_after is distinct from v_room_before then raise exception 'FAIL room changed on recovery'; end if;
  raise notice 'PASS sweep expires only abandoned holds; payment after expiry re-claims the same room';
end $$;

-- 8. Paid but the room is gone: money stays on record, reservation is flagged
do $$ declare v_res uuid; r jsonb; begin
  v_res := t08_online('lost1', 208, '00000000-0000-0000-0000-0000000000a4');
  update room_inventory_claims set hold_expires_at = now() - interval '2 minutes'
   where reservation_room_id in (select id from reservation_rooms where reservation_id = v_res);
  update payment_attempts set created_at = now() - interval '1 hour' where reservation_id = v_res;
  perform expire_lapsed_holds();
  perform t_book('00000000-0000-0000-0000-0000000000a4', property_today('00000000-0000-0000-0000-0000000000a2') + 208,
                 property_today('00000000-0000-0000-0000-0000000000a2') + 210, 't08-steal-room');
  r := t08_conf('lost1', 'evt-lost1-1');
  if r ->> 'result' <> 'recorded_inventory_lost' then raise exception 'FAIL lost inventory %', r; end if;
  if (select attention_reason from reservations where id = v_res) <> 'paid_inventory_lost'
     or (select reservation_status from reservations where id = v_res) <> 'expired'
     or (select payment_status from reservations where id = v_res) <> 'paid'
     or (select sum(amount_minor) from payments where reservation_id = v_res) <> (select amount from t08_ctx where label = 'lost1')
     or exists (select 1 from room_inventory_claims c join reservation_rooms rr on rr.id = c.reservation_room_id where rr.reservation_id = v_res and c.status = 'active')
     then raise exception 'FAIL lost inventory state'; end if;
  raise notice 'PASS paid-but-no-room is recorded, flagged and holds no inventory';
end $$;

-- 9. Payment after cancellation, unknown reference, bad arguments
do $$ declare v_res uuid; r jsonb; begin
  v_res := t08_online('canc1', 211);
  perform cancel_reservation(v_res, 'guest changed mind', 't08-cancel-1');
  r := t08_conf('canc1', 'evt-canc1-1');
  if r ->> 'result' <> 'recorded_after_cancel' or (select attention_reason from reservations where id = v_res) <> 'paid_after_cancel'
     or (select reservation_status from reservations where id = v_res) <> 'cancelled' or not exists (select 1 from payments where reservation_id = v_res)
     then raise exception 'FAIL paid after cancel %', r; end if;

  r := confirm_payment('paystack', 'evt-unknown-1', 'charge.success', 'HMS-NOSUCHREF', 'success', 100, 'NGN', 'card');
  if r ->> 'result' <> 'ignored' or (select processing_status from payment_events where provider_event_id = 'evt-unknown-1') <> 'ignored' then raise exception 'FAIL unknown reference %', r; end if;
  perform t06_expect_err($q$select confirm_payment('paystack', '', 'x', 'r', 'success', 1, 'NGN', 'card')$q$, 'POLICY_VIOLATION%');
  perform t06_expect_err($q$select confirm_payment('paystack', 'e1', 'x', 'r', 'maybe', 1, 'NGN', 'card')$q$, 'POLICY_VIOLATION: status%');
  raise notice 'PASS payment after cancel flagged; unknown reference and bad arguments handled';
end $$;

-- 10. An event signed by another tenant's account cannot touch this tenant's references
do $$ declare v_res uuid; r jsonb; v_ref text; v_amt bigint; begin
  v_res := t08_online('tm1', 216);
  select ref, amount into v_ref, v_amt from t08_ctx where label = 'tm1';
  r := confirm_payment('paystack', 'evt-tm1-wrong', 'charge.success', v_ref, 'success', v_amt, 'NGN', 'card', '{}'::jsonb, '00000000-0000-0000-0000-0000000000b1');
  if r ->> 'result' <> 'ignored' or exists (select 1 from payments where reservation_id = v_res) then raise exception 'FAIL cross-tenant event %', r; end if;
  r := confirm_payment('paystack', 'evt-tm1-right', 'charge.success', v_ref, 'success', v_amt, 'NGN', 'card', '{}'::jsonb, '00000000-0000-0000-0000-0000000000a1');
  if r ->> 'result' <> 'confirmed' then raise exception 'FAIL own-tenant event %', r; end if;
  raise notice 'PASS events are scoped to the tenant whose provider account signed them';
end $$;

-- Race fixture: the same webhook delivered 20 times at once
do $$ begin perform t08_online('race', 214); end $$;
create function test_try_confirm(p_label text) returns boolean language plpgsql as $$
declare r jsonb; attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      r := t08_conf('race', 'evt-race-1');
      insert into test_results (label, ok) values (p_label, coalesce((r ->> 'duplicate') is null, true));
      return true;
    exception when deadlock_detected or serialization_failure then
      if attempt >= 3 then raise; end if;
    end;
  end loop;
end $$;
