-- Group bookings, step eleven (migration 168): a company credit balance. Hotel A as in tests 149 to 167. Offsets 900 and up.
\set ON_ERROR_STOP on

create function t168_bal(p uuid) returns bigint language sql security definer set search_path = public as $$ select company_credit_of(p) $$;
create function t168_held(p uuid) returns bigint language sql security definer set search_path = public as $$ select reservation_money_held(p) $$;

do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_c uuid; v_g uuid; v_g2 uuid; e jsonb; ra text; v_a uuid; ta bigint; r jsonb; v_gp uuid; v_pay_before integer; v_rows integer;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_c := (company_create(v_p, 'Credit Co', 'Ola', null, null, 30, 0, null, null) ->> 'company_id')::uuid;
  v_g := (t149_group('Credit Group', 2, 0, 900, 3, 890)::jsonb ->> 'group_id')::uuid;
  v_g2 := (t149_group('No Company Group', 2, 0, 910, 3, 905)::jsonb ->> 'group_id')::uuid;
  ra := t150_ref(900, 902, 'g168-a');
  e := add_rooming_entry(v_g, 'A', null, null); perform link_rooming_reservation((e ->> 'entry_id')::uuid, ra);
  perform set_group_company(v_g, v_c);
  perform t_sys();
  update reservations set reservation_status = 'confirmed' where booking_reference = ra;
  select id, total_minor into v_a, ta from reservations where booking_reference = ra;
  if ta < 20000 then raise exception 'FAIL fixture total %', ta; end if;
  select count(*) into v_pay_before from payments;

  -- who may
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select company_credit_deposit(%L, 5000, ''cash'', null, null, ''d-x'')', v_c), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select company_credit_deposit(%L, 5000, ''cash'', null, null, ''d-x'')', v_c), 'NOT_FOUND');
  perform t_expect(format('select company_credit_balances(%L)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');

  -- deposit rules, replay, no booking payment made
  perform t_expect(format('select company_credit_deposit(%L, 0, ''cash'', null, null, ''d-1'')', v_c), 'POLICY_VIOLATION: amount');
  perform t_expect(format('select company_credit_deposit(%L, 5000, ''cheque'', null, null, ''d-1'')', v_c), 'POLICY_VIOLATION: method');
  r := company_credit_deposit(v_c, ta + 5000, 'bank_transfer', 'TRF-1', 'Advance', 'd-2');
  if (r ->> 'balance_minor')::bigint <> ta + 5000 or t168_bal(v_c) <> ta + 5000 then raise exception 'FAIL deposit %', r; end if;
  if company_credit_deposit(v_c, ta + 5000, 'bank_transfer', 'TRF-1', 'Advance', 'd-2') <> r then raise exception 'FAIL replay'; end if;
  if t168_bal(v_c) <> ta + 5000 then raise exception 'FAIL replay doubled the balance'; end if;
  if (select count(*) from payments) <> v_pay_before then raise exception 'FAIL a deposit made a booking payment'; end if;
  if (company_credit_balances(v_p) ->> v_c::text)::bigint <> ta + 5000 then raise exception 'FAIL balances'; end if;

  -- apply: needs a company, the balance, and not more than the group owes
  perform t_expect(format('select company_credit_apply(%L, 1000, ''a-x'')', v_g2), 'POLICY_VIOLATION: company');
  perform t_expect(format('select company_credit_apply(%L, %s, ''a-1'')', v_g, ta + 6000), 'POLICY_VIOLATION: credit balance');
  perform t_expect(format('select company_credit_apply(%L, %s, ''a-2'')', v_g, ta + 1), 'POLICY_VIOLATION: exceeds outstanding');
  if t168_bal(v_c) <> ta + 5000 or (select count(*) from payments) <> v_pay_before then raise exception 'FAIL a refused apply moved something'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select company_credit_apply(%L, 1000, ''a-x'')', v_g), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := company_credit_apply(v_g, ta, 'a-3');
  v_gp := (r ->> 'group_payment_id')::uuid;
  if t168_bal(v_c) <> 5000 or t168_held(v_a) <> ta then raise exception 'FAIL apply: balance %, held %', t168_bal(v_c), t168_held(v_a); end if;
  if (select payment_status from reservations where id = v_a) <> 'paid' then raise exception 'FAIL booking not paid'; end if;
  if company_credit_apply(v_g, ta, 'a-3') <> r then raise exception 'FAIL apply replay'; end if;
  if t168_bal(v_c) <> 5000 or (select count(*) from payments) <> v_pay_before + 1 then raise exception 'FAIL apply replay doubled'; end if;
  if (select reference from group_payments where id = v_gp) <> 'Company credit' then raise exception 'FAIL reference'; end if;

  -- reversing that company payment gives the credit back, once
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select reverse_group_payment(%L, ''oops'', ''r-x'')', v_gp), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform reverse_group_payment(v_gp, 'paid by mistake', 'r-1');
  if t168_bal(v_c) <> ta + 5000 or t168_held(v_a) <> 0 then raise exception 'FAIL reverse: balance %, held %', t168_bal(v_c), t168_held(v_a); end if;
  perform t_expect(format('select reverse_group_payment(%L, ''again'', ''r-2'')', v_gp), 'INVALID_STATE: reversed');
  if t168_bal(v_c) <> ta + 5000 then raise exception 'FAIL credit restored twice'; end if;

  -- an ordinary company payment reversed gives no credit
  r := record_group_payment(v_g, 3000, 'cash', null, null, null, 'p-1');
  perform reverse_group_payment((r ->> 'group_payment_id')::uuid, 'wrong', 'r-3');
  if t168_bal(v_c) <> ta + 5000 then raise exception 'FAIL a cash payment reversal changed the credit'; end if;

  -- withdraw: refund.approve, reason, never below zero
  perform t_expect(format('select company_credit_withdraw(%L, 1000, '' '', ''w-1'')', v_c), 'POLICY_VIOLATION: reason');
  perform t_expect(format('select company_credit_withdraw(%L, %s, ''refund'', ''w-2'')', v_c, ta + 5001), 'POLICY_VIOLATION: credit balance');
  r := company_credit_withdraw(v_c, 5000, 'Refunded by transfer', 'w-3');
  if (r ->> 'balance_minor')::bigint <> ta or t168_bal(v_c) <> ta then raise exception 'FAIL withdraw %', r; end if;
  if company_credit_withdraw(v_c, 5000, 'Refunded by transfer', 'w-3') <> r or t168_bal(v_c) <> ta then raise exception 'FAIL withdraw replay'; end if;

  -- ledger and audit
  if jsonb_array_length(company_credit_ledger_list(v_c, 50)) <> 4 then raise exception 'FAIL ledger rows %', company_credit_ledger_list(v_c, 50); end if;
  perform t_sys();
  begin update company_credit_ledger set amount_minor = 1 where company_id = v_c; raise exception 'FAIL ledger changed'; exception when check_violation then null; end;
  begin delete from company_credit_ledger where company_id = v_c; raise exception 'FAIL ledger deleted'; exception when check_violation then null; end;
  select count(*) into v_rows from audit_logs where action like 'company_credit.%' and tenant_id = '00000000-0000-0000-0000-0000000000a1';
  if v_rows < 3 then raise exception 'FAIL audit rows %', v_rows; end if;

  -- the flag turns it all off
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values ('00000000-0000-0000-0000-0000000000a1', 'group_bookings', false);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select company_credit_deposit(%L, 5000, ''cash'', null, null, ''d-9'')', v_c), 'POLICY_VIOLATION: group bookings off');
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = '00000000-0000-0000-0000-0000000000a1' and feature_key = 'group_bookings';
  raise notice 'PASS company credit: deposit, apply as a company payment, reverse restores once, withdraw, final ledger, audit, flag';
end $$;
