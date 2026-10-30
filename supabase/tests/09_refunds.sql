-- Refunds and payment reversal: two-person rule, caps, manual and provider payouts, statuses,
-- voiding a refunded invoice, reversal, immutability, visibility.
-- Reuses t_as / t_sys / t_expect (05), t06_expect_err (06), t07_res (07), t08_online / t08_conf (08).
-- Users: aa04 front desk (no refund rights), aa05 accountant (request and approve), aa01 owner (approve),
-- aa02 housekeeping, bb01 owner of Hotel B. Date offsets 220 to 240.
\set ON_ERROR_STOP on

create table t09_ctx (label text primary key, c_res uuid, c_pay uuid, c_inv uuid, c_refund uuid, c_extra uuid);

-- Reservation with an issued invoice and one manual payment (as the system, so permissions are not in play)
create function t09_paid(p_label text, p_off integer, p_amount bigint default null) returns uuid language plpgsql as $$
declare v_res uuid; v_inv uuid; v_pay uuid; v_total bigint;
begin
  v_res := t07_res(p_off, 2, 't09-book-' || p_label);
  select total_minor into v_total from reservations where id = v_res;
  v_inv := (issue_invoice(v_res, 't09-inv-' || p_label) ->> 'invoice_id')::uuid;
  v_pay := (record_manual_payment(v_res, coalesce(p_amount, v_total), 'cash', 'r-' || p_label, null, 't09-pay-' || p_label) ->> 'payment_id')::uuid;
  insert into t09_ctx (label, c_res, c_pay, c_inv) values (p_label, v_res, v_pay, v_inv);
  return v_pay;
end $$;

-- 1. Who may request, and what may be requested
do $$ declare pay uuid; r jsonb; total bigint; begin
  pay := t09_paid('r1', 220);
  select total_minor into total from reservations where id = (select c_res from t09_ctx where label = 'r1');

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select request_refund(%L, 1000, ''x'', ''t09-fd'')', pay), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select request_refund(%L, 1000, ''x'', ''t09-hk'')', pay), 'NOT_FOUND');
  perform t_sys();
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000bb01', true);
  perform set_config('role', 'authenticated', true);
  perform t_expect(format('select request_refund(%L, 1000, ''x'', ''t09-b'')', pay), 'NOT_FOUND');

  perform t_as('00000000-0000-0000-0000-00000000aa05');
  r := request_refund(pay, 1000000, 'guest left early', 't09-rq-1');
  if request_refund(pay, 1000000, 'guest left early', 't09-rq-1') <> r then raise exception 'FAIL request replay differs'; end if;
  if r ->> 'status' <> 'requested' or (r ->> 'internal_reference') not like 'RF-%' then raise exception 'FAIL request %', r; end if;
  update t09_ctx set c_refund = (r ->> 'refund_id')::uuid where label = 'r1';
  perform t_expect(format('select request_refund(%L, %s, ''too much'', ''t09-rq-big'')', pay, total), 'POLICY_VIOLATION: REFUND_EXCEEDS_PAYMENT%');
  perform t_expect(format('select request_refund(%L, 0, ''x'', ''t09-rq-0'')', pay), 'POLICY_VIOLATION: amount must be positive');
  perform t_expect(format('select request_refund(%L, 1000, '' '', ''t09-rq-nr'')', pay), 'POLICY_VIOLATION: reason required');
  perform t_expect(format('select request_refund(%L, 1000, ''x'', ''t09-rq-1'')', pay), 'IDEMPOTENCY_MISMATCH');
  perform t_sys();
  perform t06_expect_err(format('select request_refund(%L, 1000, ''x'', ''t09-rq-bad'')', gen_random_uuid()), 'NOT_FOUND%');
  raise notice 'PASS refund requests: permissioned, capped by the payment, validated, idempotent';
end $$;

-- 2. Approval: a different person, rejection needs a note, decisions are final
do $$ declare ref uuid; pay uuid; r jsonb; r2 jsonb; ref2 uuid; begin
  select c_refund, c_pay into ref, pay from t09_ctx where label = 'r1';
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select approve_refund(%L, true, null, ''t09-ap-self'')', ref), 'POLICY_VIOLATION: SELF_APPROVAL');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select approve_refund(%L, true, null, ''t09-ap-fd'')', ref), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := approve_refund(ref, true, 'ok', 't09-ap-1');
  if approve_refund(ref, true, 'ok', 't09-ap-1') <> r or r ->> 'status' <> 'approved' then raise exception 'FAIL approve %', r; end if;
  perform t_expect(format('select approve_refund(%L, false, ''changed my mind'', ''t09-ap-2'')', ref), 'INVALID_STATE: approved');

  perform t_as('00000000-0000-0000-0000-00000000aa05');
  r2 := request_refund(pay, 250000, 'goodwill', 't09-rq-2');
  ref2 := (r2 ->> 'refund_id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select approve_refund(%L, false, null, ''t09-rj-nn'')', ref2), 'POLICY_VIOLATION: note required to reject');
  r2 := approve_refund(ref2, false, 'not warranted', 't09-rj-1');
  if r2 ->> 'status' <> 'rejected' then raise exception 'FAIL reject %', r2; end if;
  perform t_expect(format('select record_manual_refund(%L, ''x'', ''t09-po-rej'')', ref2), 'INVALID_STATE: rejected');
  perform t_sys();
  if (select count(*) from audit_logs where entity_id = ref and action in ('refund.requested', 'refund.approved')) <> 2 then raise exception 'FAIL refund audit'; end if;
  raise notice 'PASS approval: two-person rule, rejection needs a note, decisions are final';
end $$;

-- 3. Manual payout: statuses follow money held; full refund lets the paid invoice be voided
do $$ declare ref uuid; pay uuid; res uuid; inv uuid; r jsonb; ref2 uuid; remaining bigint; begin
  select c_refund, c_pay, c_res, c_inv into ref, pay, res, inv from t09_ctx where label = 'r1';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select record_manual_refund(%L, ''slip 1'', ''t09-po-fd'')', ref), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := record_manual_refund(ref, 'slip 1', 't09-po-1');
  if record_manual_refund(ref, 'slip 1', 't09-po-1') <> r or r ->> 'status' <> 'succeeded' or r ->> 'payment_status' <> 'partially_refunded'
    then raise exception 'FAIL payout %', r; end if;
  perform t_expect(format('select record_manual_refund(%L, ''slip 1'', ''t09-po-again'')', ref), 'INVALID_STATE: succeeded');
  perform t_sys();
  if (select invoice_status from invoices where id = inv) <> 'partially_paid' then raise exception 'FAIL invoice after partial refund'; end if;
  if reservation_money_held(res) <> (select amount_minor from payments where id = pay) - 1000000 then raise exception 'FAIL money held'; end if;

  remaining := (select amount_minor from payments where id = pay) - 1000000;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select request_refund(%L, %s, ''over'', ''t09-rq-over'')', pay, remaining + 1), 'POLICY_VIOLATION: REFUND_EXCEEDS_PAYMENT%');
  perform t_expect(format('select void_invoice(%L, ''premature'', ''t09-void-early'')', inv), 'INVALID_STATE: invoice has payments');
  ref2 := (request_refund(pay, remaining, 'refund the rest', 't09-rq-rest') ->> 'refund_id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform approve_refund(ref2, true, null, 't09-ap-rest');
  r := record_manual_refund(ref2, 'slip 2', 't09-po-rest');
  if r ->> 'payment_status' <> 'refunded' then raise exception 'FAIL fully refunded status %', r; end if;
  perform t_sys();
  if (select invoice_status from invoices where id = inv) <> 'issued' then raise exception 'FAIL invoice after full refund'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  r := void_invoice(inv, 'stay refunded in full', 't09-void-ok');
  perform t_sys();
  if r ->> 'status' <> 'void' then raise exception 'FAIL void after refunds %', r; end if;
  raise notice 'PASS manual payout: partially_refunded then refunded, invoice follows, refunded invoice can be voided';
end $$;

-- 4. Reversal of a payment recorded by mistake
do $$ declare pay uuid; res uuid; inv uuid; r jsonb; pay3 uuid; total bigint; begin
  pay := t09_paid('r2', 224, 1000000);
  select c_res, c_inv into res, inv from t09_ctx where label = 'r2';
  select total_minor into total from reservations where id = res;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select reverse_payment(%L, ''typo'', ''t09-rv-fd'')', pay), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select reverse_payment(%L, '' '', ''t09-rv-nr'')', pay), 'POLICY_VIOLATION: reason required');
  r := reverse_payment(pay, 'keyed the wrong reservation', 't09-rv-1');
  if reverse_payment(pay, 'keyed the wrong reservation', 't09-rv-1') <> r or r ->> 'payment_status' <> 'unpaid' then raise exception 'FAIL reversal %', r; end if;
  perform t_expect(format('select reverse_payment(%L, ''again'', ''t09-rv-2'')', pay), 'INVALID_STATE: payment reversed');
  perform t_sys();
  if (select invoice_status from invoices where id = inv) <> 'issued' or reservation_money_held(res) <> 0 then raise exception 'FAIL state after reversal'; end if;
  -- the full total can be paid again: the reversed money no longer counts
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := record_manual_payment(res, total, 'cash', 'correct receipt', null, 't09-pay-fixed');
  perform t_sys();
  if r ->> 'payment_status' <> 'paid' then raise exception 'FAIL repay after reversal %', r; end if;

  -- a payment with a live refund cannot be reversed
  pay3 := t09_paid('r3', 227, 1000000);
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform request_refund(pay3, 500000, 'part', 't09-rq-r3');
  perform t_expect(format('select reverse_payment(%L, ''oops'', ''t09-rv-r3'')', pay3), 'INVALID_STATE: payment has refunds');
  perform t_sys();
  perform t06_expect_err(format('select reverse_payment(%L, ''x'', ''t09-rv-prov'')', (select id from payments where payment_provider = 'paystack' limit 1)), 'POLICY_VIOLATION: provider payments are refunded, not reversed%');
  raise notice 'PASS reversal: restores unpaid, frees the total, refused when a refund is live';
end $$;

-- 5. Provider refund, part 1: approval, begin, a failed attempt frees the amount, retry is approved
do $$ declare res uuid; pay uuid; r jsonb; ref uuid; ref2 uuid; b1 jsonb; b2 jsonb; amt bigint; begin
  res := t08_online('rf1', 230);
  perform t08_conf('rf1', 'evt-rf1-pay');
  select id, amount_minor into pay, amt from payments where reservation_id = res and payment_provider = 'paystack';
  if pay is null then raise exception 'FAIL provider payment missing'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa05');
  ref := (request_refund(pay, amt, 'guest cancelled', 't09-prov-rq') ->> 'refund_id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select record_manual_refund(%L, ''x'', ''t09-prov-man'')', ref), 'POLICY_VIOLATION: provider payments are refunded through the provider');
  perform approve_refund(ref, true, null, 't09-prov-ap');
  perform t_expect(format('select record_manual_refund(%L, ''x'', ''t09-prov-man2'')', ref), 'POLICY_VIOLATION: provider payments are refunded through the provider');
  perform t_sys();

  b1 := begin_refund_processing(ref);
  b2 := begin_refund_processing(ref);
  if (b1 - 'call_allowed') <> (b2 - 'call_allowed') or b1 ->> 'provider' <> 'paystack' or (b1 ->> 'payment_provider_reference') is null
     or (b1 ->> 'amount_minor')::bigint <> amt then raise exception 'FAIL begin %', b1; end if;
  if (b1 ->> 'call_allowed') <> 'true' or (b2 ->> 'call_allowed') <> 'false' then raise exception 'FAIL provider may be called exactly once % %', b1, b2; end if;
  if (select refund_status from refunds where id = ref) <> 'processing' then raise exception 'FAIL not processing'; end if;
  r := record_refund_result('paystack', 'evt-rf1-r1', ref, 'failed', null, 'insufficient balance');
  if r ->> 'result' <> 'failed' or (select refund_status from refunds where id = ref) <> 'failed'
     or (select payment_status from reservations where id = res) <> 'paid' then raise exception 'FAIL failed refund %', r; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa05');
  ref2 := (request_refund(pay, amt, 'retry after failure', 't09-prov-rq2') ->> 'refund_id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform approve_refund(ref2, true, null, 't09-prov-ap2');
  perform t_sys();
  insert into t09_ctx (label, c_res, c_pay, c_refund, c_extra) values ('prov', res, pay, ref2, ref);
  raise notice 'PASS provider refund: begin is repeatable, a failed attempt frees the amount, retry approved';
end $$;

-- 6. Provider refund, part 2: result events, duplicates, final status, access
do $$ declare v_res uuid; v_pay uuid; v_ref uuid; v_failed uuid; r jsonb; dup jsonb; begin
  select c_res, c_pay, c_refund, c_extra into v_res, v_pay, v_ref, v_failed from t09_ctx where label = 'prov';
  -- a result for a refund that is not processing yet is ignored, not applied
  r := record_refund_result('paystack', 'evt-rf1-early', v_ref, 'succeeded', 'rf_x');
  if r ->> 'result' <> 'ignored' or (select refund_status from refunds where id = v_ref) <> 'approved' then raise exception 'FAIL early result %', r; end if;
  perform begin_refund_processing(v_ref);
  r := record_refund_result('paystack', 'evt-rf1-r2', v_ref, 'succeeded', 'rf_123');
  if r ->> 'result' <> 'succeeded' or r ->> 'payment_status' <> 'refunded' then raise exception 'FAIL success result %', r; end if;
  if (select provider_refund_id from refunds where id = v_ref) <> 'rf_123' then raise exception 'FAIL provider refund id'; end if;
  dup := record_refund_result('paystack', 'evt-rf1-r2', v_ref, 'succeeded', 'rf_123');
  if dup ->> 'duplicate' <> 'true' or dup ->> 'result' <> 'succeeded' then raise exception 'FAIL duplicate result %', dup; end if;
  r := record_refund_result('paystack', 'evt-rf1-r3', v_ref, 'failed', null, 'late contradiction');
  if r ->> 'result' <> 'ignored' or (select refund_status from refunds where id = v_ref) <> 'succeeded' then raise exception 'FAIL late contradiction %', r; end if;
  perform t06_expect_err(format('select begin_refund_processing(%L)', v_ref), 'INVALID_STATE: succeeded%');
  perform t06_expect_err(format('select begin_refund_processing(%L)', v_failed), 'INVALID_STATE: failed%');
  perform t06_expect_err(format('select record_refund_result(''paystack'', '''', %L, ''succeeded'', null)', v_ref), 'POLICY_VIOLATION%');
  if (select count(*) from payments where reservation_id = v_res) <> 1 then raise exception 'FAIL refund created payments'; end if;
  raise notice 'PASS provider refund results: idempotent per event, final once succeeded, reservation refunded';
end $$;

begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ begin
  begin perform begin_refund_processing(gen_random_uuid()); raise exception 'FAIL authenticated begin_refund_processing';
  exception when insufficient_privilege then null; end;
  begin perform record_refund_result('paystack', 'e', gen_random_uuid(), 'succeeded', null); raise exception 'FAIL authenticated record_refund_result';
  exception when insufficient_privilege then null; end;
end $$;
rollback;

-- 7. Immutability and visibility
do $$ declare ref uuid; begin
  select c_refund into ref from t09_ctx where label = 'r1';
  perform t06_expect_err(format('update refunds set amount_minor = 1 where id = %L', ref), 'a refund request cannot be rewritten%');
  perform t06_expect_err(format('delete from refunds where id = %L', ref), 'refunds cannot be deleted%');
  perform t06_expect_err(format('update refunds set refund_status = ''requested'' where id = %L', ref), 'refund cannot go from%');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  if (select count(*) from refunds) <> 0 then raise exception 'FAIL housekeeping sees refunds'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  if (select count(*) from refunds) < 3 then raise exception 'FAIL accountant cannot see refunds'; end if;
  begin insert into refunds (tenant_id) values (null); raise exception 'FAIL client wrote refunds';
  exception when insufficient_privilege then null; end;
  perform t_sys();
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000bb01', true);
  perform set_config('role', 'authenticated', true);
  if (select count(*) from refunds) <> 0 then raise exception 'FAIL other tenant sees refunds'; end if;
  perform t_sys();
  raise notice 'PASS refunds are immutable, forward-only, and visible only to the right staff';
end $$;

-- Race fixture: 20 clients each ask to refund 600,000 of a 1,000,000 payment; exactly one fits
do $$ begin perform t09_paid('race', 236, 1000000); end $$;
create function test_try_refund(p_label text) returns boolean language plpgsql as $$
declare attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      perform request_refund((select c_pay from t09_ctx where label = 'race'), 600000, 'race', gen_random_uuid()::text);
      insert into test_results (label, ok) values (p_label, true);
      return true;
    exception
      when deadlock_detected or serialization_failure then
        if attempt >= 3 then raise; end if;
      when sqlstate 'P0001' then
        if sqlerrm like 'POLICY_VIOLATION: REFUND_EXCEEDS_PAYMENT%' then
          insert into test_results (label, ok) values (p_label, false);
          return false;
        end if;
        raise;
    end;
  end loop;
end $$;
