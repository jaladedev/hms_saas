-- Cancellation settlement and the refund payout guard (migration 016).
-- Reuses t_as / t_sys / t_expect (05), t06_expect_err (06), t07_res (07), t08_online / t08_conf (08).
-- Users: aa01 owner A (reservation.cancel, refund.approve), aa04 front desk, aa05 accountant, aa02 housekeeping,
-- bb01 owner B. Date offsets 280 to 310. Rules are set per reservation so earlier fixtures do not matter.
\set ON_ERROR_STOP on

create table t13_ctx (label text primary key, res uuid, pay uuid, pay2 uuid);

create function t13_rule(p_type text, p_value numeric) returns jsonb language sql as $$
  select jsonb_build_object('cancellation_rules', jsonb_build_array(
    jsonb_build_object('within_hours', 100000, 'charge', jsonb_build_object('type', p_type, 'value', p_value))))
$$;

-- Staff reservation, 2 nights, with an invoice, the given cancellation rule and an optional manual payment
create function t13_setup(p_label text, p_off integer, p_rule jsonb, p_pay bigint default null) returns uuid language plpgsql as $$
declare v_res uuid; v_pay uuid;
begin
  v_res := t07_res(p_off, 2, 't13-book-' || p_label);
  update reservations set policy_snapshot = policy_snapshot || p_rule where id = v_res;
  perform issue_invoice(v_res, 't13-inv-' || p_label);
  if p_pay is not null then
    v_pay := (record_manual_payment(v_res, p_pay, 'cash', 'r-' || p_label, null, 't13-pay-' || p_label) ->> 'payment_id')::uuid;
  end if;
  insert into t13_ctx (label, res, pay) values (p_label, v_res, v_pay);
  return v_res;
end $$;

-- 1. Paid in full, 30 percent charge: stay invoice voided, fee invoice paid, refund REQUEST for the rest
do $$ declare v_res uuid; v_total bigint; v_fee bigint; v_pay uuid; r jsonb; f refunds%rowtype; s jsonb; v_fee_inv uuid; begin
  v_res := t13_setup('full', 280, t13_rule('percent', 30));
  select total_minor into v_total from reservations where id = v_res;
  v_pay := (record_manual_payment(v_res, v_total, 'cash', 'r-full', null, 't13-pay-full') ->> 'payment_id')::uuid;
  update t13_ctx set pay = v_pay where label = 'full';
  v_fee := round(v_total * 0.30)::bigint;
  r := cancel_reservation(v_res, 'guest cancelled', 't13-cancel-full');
  if (r ->> 'cancellation_charge_minor')::bigint <> v_fee then raise exception 'FAIL charge %', r; end if;

  if (select count(*) from invoices where reservation_id = v_res and invoice_status = 'void') <> 1 then raise exception 'FAIL stay invoice not voided'; end if;
  select id into v_fee_inv from invoices where reservation_id = v_res and invoice_status <> 'void';
  if v_fee_inv is null or (select total_minor from invoices where id = v_fee_inv) <> v_fee or (select invoice_status from invoices where id = v_fee_inv) <> 'paid'
    then raise exception 'FAIL fee invoice'; end if;
  if (select sum(amount_minor) from payment_allocations a join invoices i on i.id = a.invoice_id where i.id = v_fee_inv) <> v_fee then raise exception 'FAIL fee allocation'; end if;
  if (select description from invoice_lines where invoice_id = v_fee_inv) not like 'Cancellation charge%' then raise exception 'FAIL fee line'; end if;

  select * into f from refunds where reservation_id = v_res;
  if f.amount_minor <> v_total - v_fee or f.refund_status <> 'requested' or f.payment_id <> v_pay or f.requested_by is not null
    then raise exception 'FAIL refund request %', f; end if;
  if (select count(*) from refunds where reservation_id = v_res) <> 1 then raise exception 'FAIL refund count'; end if;
  s := reservation_settlement(v_res);
  if (s ->> 'refund_still_to_request_minor')::bigint <> 0 or (s ->> 'refunds_in_flight_minor')::bigint <> v_total - v_fee or (s ->> 'settled') <> 'false' then raise exception 'FAIL settlement %', s; end if;

  -- approve and pay out by hand: the books settle
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform approve_refund(f.id, true, null, 't13-ap-full');
  perform record_manual_refund(f.id, 'slip', 't13-po-full');
  perform t_sys();
  s := reservation_settlement(v_res);
  if (s ->> 'settled') <> 'true' or (s ->> 'refunded_minor')::bigint <> v_total - v_fee or (s ->> 'held_minor')::bigint <> v_fee then raise exception 'FAIL settled %', s; end if;
  if (select payment_status from reservations where id = v_res) <> 'paid' or (select attention_reason from reservations where id = v_res) is not null then raise exception 'FAIL status after settlement'; end if;
  if (select invoice_status from invoices where id = v_fee_inv) <> 'paid' then raise exception 'FAIL fee invoice after refund'; end if;
  raise notice 'PASS cancel with payment: stay invoice voided, fee invoice paid, refund requested for the surplus and settled after payout';
end $$;

-- 2. Unpaid: the charge is flagged, collectable up to the charge only, then the flag clears
do $$ declare v_res uuid; v_total bigint; v_fee bigint; r jsonb; v_fee_inv uuid; s jsonb; begin
  v_res := t13_setup('unpaid', 283, t13_rule('percent', 50));
  select total_minor into v_total from reservations where id = v_res;
  v_fee := round(v_total * 0.50)::bigint;
  perform cancel_reservation(v_res, 'no longer travelling', 't13-cancel-unpaid');
  select id into v_fee_inv from invoices where reservation_id = v_res and invoice_status <> 'void';
  if (select invoice_status from invoices where id = v_fee_inv) <> 'issued' or (select attention_reason from reservations where id = v_res) <> 'cancellation_charge_unpaid'
    then raise exception 'FAIL unpaid charge flags'; end if;
  if exists (select 1 from refunds where reservation_id = v_res) then raise exception 'FAIL refund for an unpaid reservation'; end if;
  s := reservation_settlement(v_res);
  if (s ->> 'charge_due_minor')::bigint <> v_fee or (s ->> 'settled') <> 'false' then raise exception 'FAIL charge due %', s; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := record_manual_payment(v_res, v_fee - 1000, 'cash', 'part', null, 't13-collect-1');
  if r ->> 'payment_status' <> 'partially_paid' then raise exception 'FAIL part status %', r; end if;
  perform t_expect(format('select record_manual_payment(%L, 1001, ''cash'', null, null, ''t13-collect-over'')', v_res), 'POLICY_VIOLATION: OVERPAYMENT outstanding 1000');
  r := record_manual_payment(v_res, 1000, 'cash', 'rest', null, 't13-collect-2');
  perform t_sys();
  if r ->> 'payment_status' <> 'paid' or (select attention_reason from reservations where id = v_res) is not null
     or (select invoice_status from invoices where id = v_fee_inv) <> 'paid' then raise exception 'FAIL collected %', r; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select record_manual_payment(%L, 1, ''cash'', null, null, ''t13-collect-3'')', v_res), 'INVALID_STATE: cancelled');
  perform t_sys();
  raise notice 'PASS unpaid charge: flagged, collectable up to the charge, flag clears when covered';
end $$;

-- 3. No charge: nothing invoiced; money paid is requested back in full
do $$ declare v_res uuid; v_total bigint; v_res2 uuid; begin
  v_res := t13_setup('free', 286, '{}'::jsonb);
  perform cancel_reservation(v_res, 'free cancellation', 't13-cancel-free');
  if exists (select 1 from invoices where reservation_id = v_res and invoice_status <> 'void') or exists (select 1 from refunds where reservation_id = v_res)
     or (select attention_reason from reservations where id = v_res) is not null then raise exception 'FAIL free cancellation left work behind'; end if;
  if (select invoice_status from invoices where reservation_id = v_res) <> 'void' then raise exception 'FAIL stay invoice'; end if;

  v_res2 := t13_setup('freepaid', 289, '{}'::jsonb);
  select total_minor into v_total from reservations where id = v_res2;
  perform record_manual_payment(v_res2, v_total, 'cash', 'r', null, 't13-pay-freepaid2');
  perform cancel_reservation(v_res2, 'free cancellation', 't13-cancel-freepaid');
  if (select sum(amount_minor) from refunds where reservation_id = v_res2) <> v_total or (select count(*) from invoices where reservation_id = v_res2 and invoice_status <> 'void') <> 0
    then raise exception 'FAIL full refund request'; end if;
  raise notice 'PASS no charge: no fee invoice, full refund requested when money was paid';
end $$;

-- 4. Less paid than the charge: the money goes to the fee, no refund, the rest is due
do $$ declare v_res uuid; v_fee_inv uuid; s jsonb; begin
  v_res := t13_setup('short', 292, t13_rule('fixed', 2000000), 1000000);
  perform cancel_reservation(v_res, 'late cancel', 't13-cancel-short');
  select id into v_fee_inv from invoices where reservation_id = v_res and invoice_status <> 'void';
  if (select invoice_status from invoices where id = v_fee_inv) <> 'partially_paid' or exists (select 1 from refunds where reservation_id = v_res)
     or (select sum(amount_minor) from payment_allocations where invoice_id = v_fee_inv) <> 1000000 then raise exception 'FAIL short payment'; end if;
  s := reservation_settlement(v_res);
  if (s ->> 'charge_due_minor')::bigint <> 1000000 or (select attention_reason from reservations where id = v_res) <> 'cancellation_charge_unpaid' then raise exception 'FAIL due %', s; end if;
  raise notice 'PASS short payment is applied to the charge; the remainder is flagged as due';
end $$;

-- 5. Surplus refunds go to the newest payment first (two payments in separate transactions)
do $$ declare v_res uuid; begin
  v_res := t13_setup('two', 295, t13_rule('fixed', 500000), 1000000);
end $$;
do $$ declare v_res uuid; v_p2 uuid; v_p1 uuid; begin
  select res, pay into v_res, v_p1 from t13_ctx where label = 'two';
  v_p2 := (record_manual_payment(v_res, 1500000, 'bank_transfer', 'slip', null, 't13-pay-two-b') ->> 'payment_id')::uuid;
  update t13_ctx set pay2 = v_p2 where label = 'two';
  perform cancel_reservation(v_res, 'split refund', 't13-cancel-two');
  if (select amount_minor from refunds where payment_id = v_p2 and reservation_id = v_res) <> 1500000
     or (select amount_minor from refunds where payment_id = v_p1 and reservation_id = v_res) <> 500000
     or (select count(*) from refunds where reservation_id = v_res) <> 2 then raise exception 'FAIL refund split'; end if;
  if (select sum(amount_minor) from payment_allocations a join invoices i on i.id = a.invoice_id where i.reservation_id = v_res and i.invoice_status <> 'void') <> 500000
    then raise exception 'FAIL fee allocation after split'; end if;
  raise notice 'PASS surplus is refunded newest payment first and the charge is covered by the oldest';
end $$;

-- 6. Replays and repeats do not settle twice
do $$ declare v_res uuid; a jsonb; b jsonb; n integer; begin
  select res into v_res from t13_ctx where label = 'two';
  select count(*) into n from refunds where reservation_id = v_res;
  a := cancel_reservation(v_res, 'split refund', 't13-cancel-two');
  if (select count(*) from refunds where reservation_id = v_res) <> n then raise exception 'FAIL replay created refunds'; end if;
  perform t06_expect_err(format('select cancel_reservation(%L, ''again'', ''t13-cancel-two-b'')', v_res), 'INVALID_STATE: cancelled%');
  if (select count(*) from refunds where reservation_id = v_res) <> n or (select count(*) from invoices where reservation_id = v_res and invoice_status <> 'void') <> 1 then raise exception 'FAIL repeat settled again'; end if;
  raise notice 'PASS replay and repeat cancellations settle only once';
end $$;

-- 7. Who cancels is the requester, and cannot approve their own refund
do $$ declare v_res uuid; v_total bigint; f refunds%rowtype; begin
  v_res := t13_setup('actor', 298, t13_rule('percent', 10));
  select total_minor into v_total from reservations where id = v_res;
  perform record_manual_payment(v_res, v_total, 'cash', 'r', null, 't13-pay-actor2');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform cancel_reservation(v_res, 'owner cancelled', 't13-cancel-actor');
  select * into f from refunds where reservation_id = v_res;
  if f.requested_by <> '00000000-0000-0000-0000-00000000aa01' then raise exception 'FAIL requester %', f.requested_by; end if;
  perform t_expect(format('select approve_refund(%L, true, null, ''t13-self'')', f.id), 'POLICY_VIOLATION: SELF_APPROVAL');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform approve_refund(f.id, true, null, 't13-ap-actor');
  perform t_sys();
  if not exists (select 1 from audit_logs where entity_id = v_res and action = 'reservation.settled' and actor_user_id = '00000000-0000-0000-0000-00000000aa01') then raise exception 'FAIL settlement audit'; end if;
  raise notice 'PASS the canceller is the requester; a second person approves';
end $$;

-- 8. Website guests are emailed once, with the charge and the refund due
do $$ declare v_unpaid uuid; v_paid uuid; r jsonb; total bigint; begin
  update email_outbox set status = 'sent', sent_at = now() where status <> 'sent' and (dedupe_key is null or dedupe_key not like 'race-%');
  v_unpaid := t08_online('cn1', 301);
  update reservations set policy_snapshot = policy_snapshot || t13_rule('percent', 30) where id = v_unpaid;
  perform cancel_reservation(v_unpaid, 'changed plans', 't13-cancel-cn1');
  select payload into r from email_outbox where kind = 'booking_cancelled' and to_email = 'cn1@example.com';
  select total_minor into total from reservations where id = v_unpaid;
  if r is null or (r ->> 'charge_minor')::bigint <> round(total * 0.3)::bigint or (r ->> 'refund_due_minor')::bigint <> 0 then raise exception 'FAIL unpaid cancel email %', r; end if;
  if (select count(*) from email_outbox where kind = 'booking_cancelled' and to_email = 'cn1@example.com') <> 1 then raise exception 'FAIL cancel email count'; end if;

  v_paid := t08_online('cn2', 304);
  perform t08_conf('cn2', 'evt-cn2-1');
  update reservations set policy_snapshot = policy_snapshot || t13_rule('percent', 30) where id = v_paid;
  perform cancel_reservation(v_paid, 'changed plans', 't13-cancel-cn2');
  select payload into r from email_outbox where kind = 'booking_cancelled' and to_email = 'cn2@example.com';
  select total_minor into total from reservations where id = v_paid;
  if (r ->> 'refund_due_minor')::bigint <> total - round(total * 0.3)::bigint then raise exception 'FAIL paid cancel email %', r; end if;
  if exists (select 1 from email_outbox o join reservations x on x.id = o.reservation_id where o.kind = 'booking_cancelled' and x.source <> 'website') then raise exception 'FAIL staff booking emailed'; end if;
  insert into t13_ctx (label, res, pay) select 'online', v_paid, (select id from payments where reservation_id = v_paid);
  raise notice 'PASS cancellation email: once, website only, with charge and refund due';
end $$;

-- 9. Visibility of the settlement summary
do $$ begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if reservation_settlement((select res from t13_ctx where label = 'full')) ->> 'applicable' <> 'true' then raise exception 'FAIL front desk summary'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select reservation_settlement(%L)', (select res from t13_ctx where label = 'full')), 'NOT_FOUND');
  perform t_sys();
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000bb01', true);
  perform set_config('role', 'authenticated', true);
  perform t_expect(format('select reservation_settlement(%L)', (select res from t13_ctx where label = 'full')), 'NOT_FOUND');
  perform t_sys();
  raise notice 'PASS settlement summary is limited to finance-facing staff of the same hotel';
end $$;

-- 10. Provider refund payout guard: exactly one caller may call the provider
do $$ declare v_res uuid; v_pay uuid; f refunds%rowtype; a jsonb; b jsonb; c jsonb; ctx jsonb; v_manual_refund uuid; begin
  select res, pay into v_res, v_pay from t13_ctx where label = 'online';
  select * into f from refunds where reservation_id = v_res;
  if f.id is null or f.payment_id <> v_pay then raise exception 'FAIL provider refund request missing'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform approve_refund(f.id, true, null, 't13-ap-online');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select start_refund_payout(%L)', f.id), 'NOT_FOUND');          -- front desk cannot pay out
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  a := start_refund_payout(f.id);
  b := start_refund_payout(f.id);
  perform t_sys();
  if (a ->> 'call_allowed') <> 'true' or (b ->> 'call_allowed') <> 'false' or a ->> 'provider' <> 'paystack'
     or (a ->> 'payment_provider_reference') is null or (a ->> 'amount_minor')::bigint <> f.amount_minor then raise exception 'FAIL payout guard % %', a, b; end if;
  c := begin_refund_processing(f.id);
  if (c ->> 'call_allowed') <> 'false' then raise exception 'FAIL server call allowed after staff call %', c; end if;
  if (select refund_status from refunds where id = f.id) <> 'processing' or (select provider_call_started_at from refunds where id = f.id) is null then raise exception 'FAIL processing state'; end if;

  -- manual payments are paid out by staff, not through the provider
  v_manual_refund := (select id from refunds where payment_id = (select pay from t13_ctx where label = 'two') limit 1);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select start_refund_payout(%L)', v_manual_refund), 'POLICY_VIOLATION: manual payments are refunded by staff');
  perform approve_refund(v_manual_refund, true, null, 't13-ap-two-man');
  perform t_expect(format('select start_refund_payout(%L)', v_manual_refund), 'POLICY_VIOLATION: manual payments are refunded by staff');
  perform t_sys();

  -- unknown outcome: noted for a person, listed once stale
  perform note_refund_attention(f.id, 'payout outcome unknown: timeout calling Paystack');
  if (select attention_note from refunds where id = f.id) not like 'payout outcome unknown%' then raise exception 'FAIL attention note'; end if;
  if jsonb_array_length(stale_processing_refunds(120)) <> 0 then raise exception 'FAIL fresh refund listed as stale'; end if;
  update refunds set provider_call_started_at = now() - interval '3 hours' where id = f.id;
  if (select count(*) from jsonb_array_elements(stale_processing_refunds(120)) x where (x ->> 'refund_id')::uuid = f.id and (x ->> 'minutes_processing')::int >= 180) <> 1 then raise exception 'FAIL stale refund not listed'; end if;
  ctx := refund_payout_context(f.id);
  if ctx ->> 'secret_reference' is null or ctx::text like '%sk_%' then raise exception 'FAIL payout context %', ctx; end if;
  perform note_refund_attention(v_manual_refund, 'ignored: not processing');
  if (select attention_note from refunds where id = v_manual_refund) is not null then raise exception 'FAIL noted a refund that is not processing'; end if;
  raise notice 'PASS payout guard: one provider call per refund, staff rights enforced, unknown outcomes surfaced';
end $$;

-- 11. Closed to the wrong callers
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ begin
  begin perform refund_payout_context(gen_random_uuid()); raise exception 'FAIL authenticated refund_payout_context'; exception when insufficient_privilege then null; end;
  begin perform note_refund_attention(gen_random_uuid(), 'x'); raise exception 'FAIL authenticated note_refund_attention'; exception when insufficient_privilege then null; end;
  begin perform stale_processing_refunds(1); raise exception 'FAIL authenticated stale_processing_refunds'; exception when insufficient_privilege then null; end;
  begin perform settle_cancelled_reservation(gen_random_uuid(), null); raise exception 'FAIL authenticated settle'; exception when insufficient_privilege then null; end;
end $$;
rollback;
begin;
set local role anon;
do $$ begin
  begin perform start_refund_payout(gen_random_uuid()); raise exception 'FAIL anon start_refund_payout'; exception when insufficient_privilege then null; end;
  begin perform reservation_settlement(gen_random_uuid()); raise exception 'FAIL anon reservation_settlement'; exception when insufficient_privilege then null; end;
end $$;
rollback;
do $$ begin raise notice 'PASS settlement and payout functions are closed to the wrong callers'; end $$;
