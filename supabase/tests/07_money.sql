-- Invoices and manual payments: issuing, numbering, immutability, allocation, overpayment, void,
-- permissions, idempotency. Reuses helpers from 05_operations.sql (t_as, t_sys, t_expect, t_book,
-- t_rr) and 06_holds.sql (t06_expect_err). Users: aa04 front desk A (payment.record, invoice.issue),
-- aa02 housekeeping A, bb01 owner B; this file adds aa05 accountant A (invoice.void).
-- Dates are relative to the property's today, offsets 160 to 180 (earlier files stay below 150).
\set ON_ERROR_STOP on

insert into auth.users (id) values ('00000000-0000-0000-0000-00000000aa05');
insert into tenant_memberships (id, tenant_id, user_id, status)
values ('00000000-0000-0000-0000-0000000aaa05', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa05', 'active');
insert into membership_roles (membership_id, role_id)
select '00000000-0000-0000-0000-0000000aaa05', id from roles where key = 'accountant';

create table t07_ctx (label text primary key, id uuid not null);
create function t07_res(p_off integer, p_nights integer, p_key text) returns uuid language sql as $$
  select (t_book('00000000-0000-0000-0000-0000000000a3',
                 property_today('00000000-0000-0000-0000-0000000000a2') + p_off,
                 property_today('00000000-0000-0000-0000-0000000000a2') + p_off + p_nights, p_key) ->> 'reservation_id')::uuid
$$;

-- 1. Issuing: numbering, lines copied from the nights, idempotency, permissions, visibility, immutability
do $$ declare res uuid; r jsonb; v_total bigint; v_inv uuid; begin
  res := t07_res(160, 3, 't07-book-1');
  insert into t07_ctx values ('main', res);
  select total_minor into v_total from reservations where id = res;

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := issue_invoice(res, 't07-inv-1');
  if issue_invoice(res, 't07-inv-1') <> r then raise exception 'FAIL issue replay differs'; end if;
  perform t_sys();
  v_inv := (r ->> 'invoice_id')::uuid;
  insert into t07_ctx values ('main_inv', v_inv);
  if (r ->> 'invoice_number') not like 'INV-HA-%-000001' or r ->> 'status' <> 'issued' or (r ->> 'total_minor')::bigint <> v_total
    then raise exception 'FAIL invoice header %', r; end if;
  if (select count(*) from invoice_lines where invoice_id = v_inv) <> 3
     or (select sum(line_total_minor) from invoice_lines where invoice_id = v_inv) <> v_total
     then raise exception 'FAIL invoice lines'; end if;
  if (select count(*) from invoices where reservation_id = res) <> 1 then raise exception 'FAIL replay duplicated invoice'; end if;
  if not exists (select 1 from audit_logs where entity_id = v_inv and action = 'invoice.issued') then raise exception 'FAIL invoice audit'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select issue_invoice(%L, %L)', res, 't07-inv-2'), 'INVALID_STATE: invoice exists');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select issue_invoice(%L, %L)', res, 't07-inv-hk'), 'NOT_FOUND');
  if (select count(*) from invoices) <> 0 then raise exception 'FAIL housekeeping can read invoices'; end if;
  perform t_sys();
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000bb01', true);
  perform set_config('role', 'authenticated', true);
  perform t_expect(format('select issue_invoice(%L, %L)', res, 't07-inv-b'), 'NOT_FOUND');
  if (select count(*) from invoices) <> 0 then raise exception 'FAIL other tenant can read invoices'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if (select count(*) from invoices) <> 1 or (select count(*) from invoice_lines) <> 3 then raise exception 'FAIL front desk cannot read its invoice'; end if;
  begin insert into payments (tenant_id) values (null); raise exception 'FAIL client wrote payments';
  exception when insufficient_privilege then null; end;
  begin update invoices set total_minor = 1; raise exception 'FAIL client updated invoices';
  exception when insufficient_privilege then null; end;
  perform t_sys();

  -- issued invoices cannot be rewritten or removed, even by the table owner
  perform t06_expect_err(format('update invoices set total_minor = total_minor + 1 where id = %L', v_inv), 'an issued invoice cannot be rewritten%');
  perform t06_expect_err(format('delete from invoices where id = %L', v_inv), 'invoices cannot be deleted%');
  perform t06_expect_err(format('update invoice_lines set unit_amount_minor = 1 where invoice_id = %L', v_inv), 'invoice_lines rows cannot be changed%');
  perform t06_expect_err(format('delete from invoice_lines where invoice_id = %L', v_inv), 'invoice_lines rows cannot be changed%');

  -- cancelled reservations are not invoiced
  res := t07_res(165, 1, 't07-book-c');
  perform cancel_reservation(res, 'test', 't07-cancel-c');
  perform t06_expect_err(format('select issue_invoice(%L, %L)', res, 't07-inv-c'), 'INVALID_STATE: cancelled%');
  raise notice 'PASS invoices: numbered, copied from nights, idempotent, permissioned, read-scoped, immutable';
end $$;

-- 2. Payments against an issued invoice: partial, replay, validation, overpayment, settle, permissions
do $$ declare res uuid; inv uuid; v_total bigint; r jsonb; r2 jsonb; begin
  select id into res from t07_ctx where label = 'main';
  select id into inv from t07_ctx where label = 'main_inv';
  select total_minor into v_total from reservations where id = res;

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := record_manual_payment(res, 1000000, 'cash', 'receipt 001', 'deposit', 't07-pay-1');
  if (r ->> 'allocated_minor')::bigint <> 1000000 or r ->> 'payment_status' <> 'partially_paid'
     or (r ->> 'outstanding_minor')::bigint <> v_total - 1000000 or (r ->> 'internal_reference') not like 'PAY-%'
     then raise exception 'FAIL first payment %', r; end if;
  if record_manual_payment(res, 1000000, 'cash', 'receipt 001', 'deposit', 't07-pay-1') <> r then raise exception 'FAIL payment replay differs'; end if;
  perform t_expect(format('select record_manual_payment(%L, 1100000, ''cash'', ''receipt 001'', ''deposit'', ''t07-pay-1'')', res), 'IDEMPOTENCY_MISMATCH');
  perform t_expect(format('select record_manual_payment(%L, 0, ''cash'', null, null, ''t07-pay-z'')', res), 'POLICY_VIOLATION: amount must be positive');
  perform t_expect(format('select record_manual_payment(%L, -5, ''cash'', null, null, ''t07-pay-n'')', res), 'POLICY_VIOLATION: amount must be positive');
  perform t_expect(format('select record_manual_payment(%L, 1000, ''bitcoin'', null, null, ''t07-pay-m'')', res), 'POLICY_VIOLATION: payment method');
  perform t_expect(format('select record_manual_payment(%L, %s, ''cash'', null, null, ''t07-pay-o'')', res, v_total), 'POLICY_VIOLATION: OVERPAYMENT');
  perform t_sys();
  if (select invoice_status from invoices where id = inv) <> 'partially_paid' then raise exception 'FAIL invoice not partially paid'; end if;
  if (select count(*) from payments where reservation_id = res) <> 1 then raise exception 'FAIL replay or refusals left payments'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select record_manual_payment(%L, 1000, ''cash'', null, null, ''t07-pay-hk'')', res), 'NOT_FOUND');
  perform t_sys();
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000bb01', true);
  perform set_config('role', 'authenticated', true);
  perform t_expect(format('select record_manual_payment(%L, 1000, ''cash'', null, null, ''t07-pay-b'')', res), 'NOT_FOUND');

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r2 := record_manual_payment(res, v_total - 1000000, 'bank_transfer', 'slip 77', null, 't07-pay-2');
  perform t_expect(format('select record_manual_payment(%L, 1, ''cash'', null, null, ''t07-pay-3'')', res), 'POLICY_VIOLATION: OVERPAYMENT');
  perform t_sys();
  if r2 ->> 'payment_status' <> 'paid' or (r2 ->> 'outstanding_minor')::bigint <> 0 then raise exception 'FAIL settling payment %', r2; end if;
  if (select invoice_status from invoices where id = inv) <> 'paid' then raise exception 'FAIL invoice not paid'; end if;
  if (select payment_status from reservations where id = res) <> 'paid' then raise exception 'FAIL reservation not paid'; end if;
  if (select sum(amount_minor) from payment_allocations where invoice_id = inv) <> v_total
     or (select sum(amount_minor) from payments where reservation_id = res) <> v_total then raise exception 'FAIL money does not add up'; end if;
  perform t06_expect_err(format('update payments set amount_minor = 1 where reservation_id = %L', res), 'a recorded payment cannot be rewritten%');
  perform t06_expect_err(format('delete from payments where reservation_id = %L', res), 'payments cannot be deleted%');
  perform t06_expect_err('delete from payment_allocations', 'payment_allocations rows cannot be changed%');
  raise notice 'PASS payments: partial, replay, validation, overpayment refused, settled, permissioned, immutable';
end $$;

-- 3. Money received before the invoice is picked up when the invoice is issued; allocation safeguards
do $$ declare res uuid; r jsonb; v_inv uuid; v_pay uuid; begin
  res := t07_res(168, 1, 't07-book-3');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := record_manual_payment(res, 500000, 'pos', null, null, 't07-pre-1');
  if r ->> 'invoice_id' is not null or (r ->> 'allocated_minor')::bigint <> 0 or r ->> 'payment_status' <> 'partially_paid'
    then raise exception 'FAIL payment before invoice %', r; end if;
  v_pay := (r ->> 'payment_id')::uuid;
  r := issue_invoice(res, 't07-pre-inv');
  perform t_sys();
  v_inv := (r ->> 'invoice_id')::uuid;
  if (r ->> 'allocated_minor')::bigint <> 500000 or r ->> 'status' <> 'partially_paid' then raise exception 'FAIL pickup %', r; end if;
  -- the payment is fully allocated: one more kobo is refused by the database itself
  perform t06_expect_err(format('insert into payment_allocations (tenant_id, payment_id, invoice_id, amount_minor) values (''00000000-0000-0000-0000-0000000000a1'', %L, %L, 1)', v_pay, v_inv),
                         'allocations exceed payment%');
  -- an allocation cannot cross reservations
  perform t06_expect_err(format('insert into payment_allocations (tenant_id, payment_id, invoice_id, amount_minor) values (''00000000-0000-0000-0000-0000000000a1'', %L, %L, 1)', v_pay, (select id from t07_ctx where label = 'main_inv')),
                         'allocation crosses reservations%');
  raise notice 'PASS earlier payments allocated at issue time; allocation safeguards hold';
end $$;

-- 4. Void: permission, reason, paid invoices refused, replay, void is final, re-issue
do $$ declare res uuid; r jsonb; v_inv uuid; r2 jsonb; v_paid_inv uuid; begin
  res := t07_res(170, 2, 't07-book-4');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := issue_invoice(res, 't07-void-inv');
  v_inv := (r ->> 'invoice_id')::uuid;
  perform t_expect(format('select void_invoice(%L, ''mistake'', ''t07-void-fd'')', v_inv), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select void_invoice(%L, '' '', ''t07-void-nr'')', v_inv), 'POLICY_VIOLATION: reason required');
  r2 := void_invoice(v_inv, 'wrong guest name', 't07-void-1');
  if void_invoice(v_inv, 'wrong guest name', 't07-void-1') <> r2 then raise exception 'FAIL void replay differs'; end if;
  perform t_expect(format('select void_invoice(%L, ''again'', ''t07-void-2'')', v_inv), 'INVALID_STATE: void');
  select id into v_paid_inv from t07_ctx where label = 'main_inv';
  perform t_expect(format('select void_invoice(%L, ''try'', ''t07-void-3'')', v_paid_inv), 'INVALID_STATE: invoice has payments');
  perform t_sys();
  if (select invoice_status from invoices where id = v_inv) <> 'void' then raise exception 'FAIL not void'; end if;
  perform t06_expect_err(format('update invoices set invoice_status = ''issued'', voided_at = null where id = %L', v_inv), 'a void invoice cannot change%');
  -- a new invoice can be issued once the old one is void
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := issue_invoice(res, 't07-void-reissue');
  perform t_sys();
  if (r ->> 'invoice_id')::uuid = v_inv or (select count(*) from invoices where reservation_id = res and invoice_status <> 'void') <> 1
    then raise exception 'FAIL reissue'; end if;
  if (select count(distinct invoice_number) from invoices where property_id = '00000000-0000-0000-0000-0000000000a2') <>
     (select count(*) from invoices where property_id = '00000000-0000-0000-0000-0000000000a2') then raise exception 'FAIL duplicate invoice numbers'; end if;
  raise notice 'PASS void: accountants only, reason needed, paid invoices refused, final, re-issue works';
end $$;

-- 5. Payments on cancelled reservations wait for settlement
do $$ declare res uuid; begin
  res := t07_res(172, 1, 't07-book-5');
  perform cancel_reservation(res, 'test', 't07-cancel-5');
  perform t06_expect_err(format('select record_manual_payment(%L, 1000, ''cash'', null, null, ''t07-pay-x'')', res), 'INVALID_STATE: cancelled%');
  raise notice 'PASS payments on cancelled reservations are refused';
end $$;

-- Race fixture: one night, invoice issued, then 20 clients each pay a fifth of the total
create function test_try_pay(p_label text, p_res uuid, p_amount bigint) returns boolean language plpgsql as $$
declare attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      perform record_manual_payment(p_res, p_amount, 'cash', null, null, gen_random_uuid()::text);
      insert into test_results (label, ok) values (p_label, true);
      return true;
    exception
      when deadlock_detected or serialization_failure then
        if attempt >= 3 then raise; end if;
      when sqlstate 'P0001' then
        if sqlerrm like 'POLICY_VIOLATION: OVERPAYMENT%' then
          insert into test_results (label, ok) values (p_label, false);
          return false;
        end if;
        raise;
    end;
  end loop;
end $$;
do $$ declare res uuid; begin
  res := t07_res(175, 1, 't07-book-race');
  insert into t07_ctx values ('race', res);
  perform issue_invoice(res, 't07-race-inv');
end $$;
