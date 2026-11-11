-- Emailing a booking invoice (migration 095). Reuses t_as / t_sys / t_expect (05), t07_res (07).
-- Users: aa04 front desk (invoice.issue), aa02 housekeeping, aa05 accountant, bb01 owner of Hotel B. Date offset 3100.
\set ON_ERROR_STOP on

do $$ declare
  res uuid; res2 uuid; v_inv2 uuid; v_guest uuid; v_inv uuid; v_total bigint; r jsonb; r2 jsonb; v_row email_outbox%rowtype; v_n integer;
begin
  perform t_sys();
  res := t07_res(3100, 2, 't96-book-1');
  select total_minor, primary_guest_id into v_total, v_guest from reservations where id = res;
  v_inv := (issue_invoice(res, 't96-inv-1') ->> 'invoice_id')::uuid;
  perform record_manual_payment(res, 1000000, 'cash', 'r96', null, 't96-pay-1');
  update guests set email = 'Guest.Inv@Example.test' where id = v_guest;

  -- who may ask, and bad input
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select email_booking_invoice(%L, %L)', v_inv, 'bi-mail-hk-01'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select email_booking_invoice(%L, %L)', v_inv, 'bi-mail-b-001'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select email_booking_invoice(%L, %L)', gen_random_uuid(), 'bi-mail-none1'), 'NOT_FOUND');
  perform t_expect(format('select email_booking_invoice(%L, %L)', v_inv, 'short'), 'POLICY_VIOLATION: key');
  perform t_expect(format('select email_booking_invoice(%L, null)', v_inv), 'POLICY_VIOLATION: key');

  -- queued once for one key, with a frozen copy including what is still owing
  r := email_booking_invoice(v_inv, 'bi-mail-key-01');
  r2 := email_booking_invoice(v_inv, 'bi-mail-key-01');   -- a double click
  perform t_sys();
  if (r ->> 'queued')::boolean is not true or (r2 ->> 'queued')::boolean is not false then raise exception 'FAIL queued flags % %', r, r2; end if;
  select count(*) into v_n from email_outbox where kind = 'booking_invoice' and reservation_id = res;
  if v_n <> 1 then raise exception 'FAIL one email for one key (%)', v_n; end if;
  select * into v_row from email_outbox where kind = 'booking_invoice' and reservation_id = res;
  if v_row.to_email <> 'guest.inv@example.test' or v_row.status <> 'pending' then raise exception 'FAIL row % %', v_row.to_email, v_row.status; end if;
  if v_row.payload ->> 'invoice_number' <> (select invoice_number from invoices where id = v_inv)
     or (v_row.payload ->> 'total_minor')::bigint <> v_total
     or (v_row.payload ->> 'balance_minor')::bigint <> v_total - 1000000
     or jsonb_array_length(v_row.payload -> 'lines') < 1
     or (v_row.payload #>> '{lines,0,line_total_minor}') is null then raise exception 'FAIL payload %', v_row.payload; end if;
  if (select count(*) from audit_logs where action = 'invoice.emailed' and entity_id = v_inv) <> 1 then raise exception 'FAIL audit once per queued email'; end if;

  -- a new key sends again; the first email is untouched
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  r := email_booking_invoice(v_inv, 'bi-mail-key-02');
  perform t_sys();
  select count(*) into v_n from email_outbox where kind = 'booking_invoice' and reservation_id = res;
  if v_n <> 2 or (r ->> 'queued')::boolean is not true then raise exception 'FAIL a new key should queue a second email (%)', v_n; end if;

  -- no address on the guest
  update guests set email = null where id = v_guest;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select email_booking_invoice(%L, %L)', v_inv, 'bi-mail-noem-1'), 'POLICY_VIOLATION: no email');

  -- a void invoice is refused (one with no payments, so it can be voided)
  perform t_sys();
  update guests set email = 'guest.inv@example.test' where id = v_guest;
  res2 := t07_res(3110, 2, 't96-book-2');
  v_inv2 := (issue_invoice(res2, 't96-inv-2') ->> 'invoice_id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform void_invoice(v_inv2, 'issued in error', 't96-void-1');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select email_booking_invoice(%L, %L)', v_inv2, 'bi-mail-void-1'), 'INVALID_STATE: void');
  perform t_sys();
  select count(*) into v_n from email_outbox where kind = 'booking_invoice' and reservation_id = res;
  if v_n <> 2 then raise exception 'FAIL a refused call queued an email (%)', v_n; end if;
  raise notice 'PASS email_booking_invoice: permissions, key, one email per key, frozen copy with balance, audited, no address and void refused';
end $$;

-- anon cannot call it
do $$ declare v_state text; begin
  perform t_sys();
  begin
    set local role anon;
    perform email_booking_invoice(gen_random_uuid(), 'bi-mail-anon-1');
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could call email_booking_invoice'; end if;
  raise notice 'PASS email_booking_invoice: anon refused';
end $$;
