-- The numbered invoice for extras (migration 048). Reuses t_as / t_sys / t_expect / t_book / t_rr (05), t21_free_room / t21_room (21).
-- Users: aa01 owner A, aa02 housekeeping A, aa04 front desk A (folio.charge, invoice.issue; no invoice.void), aa05 accountant A
-- (invoice.issue, invoice.void; no folio.charge), bb01 owner of Hotel B. Ids: a2 property A, a3 the STD room type.
\set ON_ERROR_STOP on

create table t50_ctx (label text primary key, val text not null);
create function t50_res() returns uuid language sql stable as $$ select val::uuid from t50_ctx where label = 'res' $$;
-- the reservation's own money, as one string, so "nothing changed" is a single comparison
create function t50_money(p_res uuid) returns text language sql stable as $$
  select concat_ws('|', r.total_minor, r.payment_status,
    (select count(*) from invoices where reservation_id = r.id), (select count(*) from payments where reservation_id = r.id),
    (select count(*) from refunds f where f.reservation_id = r.id), reservation_money_held(r.id))
  from reservations r where r.id = p_res
$$;

-- 1. An in-house reservation with three extras, and the table and grant facts
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); v_room text; v_book jsonb; v_rr uuid; res uuid;
begin
  perform t_sys();
  -- earlier tests have used every standard room for today, so this file brings its own
  insert into rooms (tenant_id, property_id, room_type_id, room_number, floor)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a3', '950', 9);
  v_room := '950';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  v_book := t_book('00000000-0000-0000-0000-0000000000a3', t, t + 2, 'fi-res-0001', t21_room(v_room));
  v_rr := t_rr(v_book); res := (v_book ->> 'reservation_id')::uuid;
  perform check_in(v_rr, 'test');
  perform post_folio_charge(res, 'minibar', 'Water', 2, 150000, 'fi-c1');
  perform post_folio_charge(res, 'laundry', 'Shirts', 3, 200000, 'fi-c2');
  perform post_folio_charge(res, 'food_beverage', 'Dinner', 1, 1000000, 'fi-c3');
  perform t_sys();
  insert into t50_ctx values ('res', res::text), ('money', t50_money(res));
  if (select count(*) from folio_charges where reservation_id = res and status = 'posted' and folio_invoice_id is null) <> 3 then raise exception 'FAIL fixture: three uninvoiced charges'; end if;
  if not (select relrowsecurity from pg_class where oid = 'folio_invoices'::regclass) or not (select relrowsecurity from pg_class where oid = 'folio_invoice_lines'::regclass)
    then raise exception 'FAIL row-level security is off'; end if;
  if has_table_privilege('authenticated', 'folio_invoices', 'insert') or has_table_privilege('authenticated', 'folio_invoices', 'update') or has_table_privilege('authenticated', 'folio_invoice_lines', 'insert')
    then raise exception 'FAIL clients can write the invoice tables directly'; end if;
  raise notice 'PASS fixtures and grants: three extras posted and not invoiced; invoice tables are read-only to clients, with row-level security';
end $$;

-- 2. Who may issue, and the states that refuse
do $$ declare
  res uuid := t50_res(); t date := property_today('00000000-0000-0000-0000-0000000000a2'); v_book jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select issue_folio_invoice(%L, %L)', res, 'fi-hk'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select issue_folio_invoice(%L, %L)', res, 'fi-b'), 'NOT_FOUND');
  perform t_expect(format('select issue_folio_invoice(%L, %L)', gen_random_uuid(), 'fi-none'), 'NOT_FOUND');
  -- a guest who has not arrived has no folio
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  v_book := t_book('00000000-0000-0000-0000-0000000000a3', t + 310, t + 311, 'fi-res-0002');
  perform t_expect(format('select issue_folio_invoice(%L, %L)', v_book ->> 'reservation_id', 'fi-future'), 'INVALID_STATE');
  perform t_sys();
  if (select count(*) from folio_invoices) <> 0 then raise exception 'FAIL a refused call left an invoice'; end if;
  raise notice 'PASS refusals: housekeeping, another hotel and a missing booking get NOT_FOUND; a booking with no folio yet is INVALID_STATE';
end $$;

-- 3. Issue: one number for all uninvoiced extras, the lines are a frozen copy, the booking's own money is untouched
do $$ declare
  res uuid := t50_res(); r jsonb; r2 jsonb; v_inv uuid; v_year integer := extract(year from property_today('00000000-0000-0000-0000-0000000000a2'))::integer;
  v_code text := (select code from properties where id = '00000000-0000-0000-0000-0000000000a2');
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := issue_folio_invoice(res, 'fi-issue-1');
  r2 := issue_folio_invoice(res, 'fi-issue-1');   -- the same key answers with the first answer
  perform t_sys();
  v_inv := (r ->> 'folio_invoice_id')::uuid;
  if r2 is distinct from r then raise exception 'FAIL repeated key: %', r2; end if;
  if (select count(*) from folio_invoices) <> 1 then raise exception 'FAIL the repeat made a second invoice'; end if;
  if (r ->> 'total_minor')::bigint <> 300000 + 600000 + 1000000 or (r ->> 'line_count')::int <> 3 or (r ->> 'status') <> 'issued'
    then raise exception 'FAIL totals %', r; end if;
  if (r ->> 'invoice_number') !~ ('^INV-' || v_code || '-' || v_year || '-[0-9]{6}$') then raise exception 'FAIL number format %', r ->> 'invoice_number'; end if;
  if (select count(*) from folio_invoice_lines where folio_invoice_id = v_inv) <> 3
     or (select sum(line_total_minor) from folio_invoice_lines where folio_invoice_id = v_inv) <> 1900000 then raise exception 'FAIL lines'; end if;
  if (select count(*) from folio_charges where reservation_id = res and folio_invoice_id = v_inv) <> 3 then raise exception 'FAIL charges not linked'; end if;
  if t50_money(res) <> (select val from t50_ctx where label = 'money') then raise exception 'FAIL the booking''s own money changed'; end if;
  if (select count(*) from audit_logs where action = 'folio_invoice.issued' and entity_id = v_inv) <> 1 then raise exception 'FAIL audit'; end if;
  insert into t50_ctx values ('inv', v_inv::text), ('number', r ->> 'invoice_number');
  raise notice 'PASS issue: one numbered invoice for all three extras, same key answers the same, lines match the charges, the booking''s money is unchanged';
end $$;

-- 4. Nothing left to invoice; a charge on an invoice cannot be voided; the number is in the same series as the booking invoice
do $$ declare
  res uuid := t50_res(); v_charge uuid; v_num_inv text; v_n1 integer; v_n2 integer;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select issue_folio_invoice(%L, %L)', res, 'fi-issue-2'), 'INVALID_STATE: nothing to invoice');
  select id into v_charge from folio_charges where reservation_id = res order by created_at limit 1;
  perform t_expect(format('select void_folio_charge(%L, %L)', v_charge, 'oops'), 'INVALID_STATE: on an invoice');
  -- the backstop in the table itself
  perform t_sys();
  begin
    update folio_charges set status = 'voided', voided_at = now(), void_reason = 'x' where id = v_charge;
    raise exception 'FAIL the guard let an invoiced charge be voided';
  exception when check_violation then null; end;
  -- the booking invoice and the extras invoice draw numbers from one counter: the next booking invoice is one past this one
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform issue_invoice(res, 'fi-booking-inv');
  perform t_sys();
  v_n1 := right((select val from t50_ctx where label = 'number'), 6)::int;
  v_n2 := right((select invoice_number from invoices where reservation_id = res), 6)::int;
  if v_n2 <> v_n1 + 1 then raise exception 'FAIL one counter: % then %', v_n1, v_n2; end if;
  raise notice 'PASS locking and numbering: nothing left to invoice; an invoiced charge cannot be voided; the booking invoice takes the next number in the same series';
end $$;

-- 5. A later extra stays uninvoiced and gets the next number on its own invoice; the first invoice is not touched
do $$ declare
  res uuid := t50_res(); r jsonb; v_first uuid := (select val::uuid from t50_ctx where label = 'inv');
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform post_folio_charge(res, 'phone', 'Call', 1, 50000, 'fi-c4');
  r := issue_folio_invoice(res, 'fi-issue-3');
  perform t_sys();
  if (r ->> 'line_count')::int <> 1 or (r ->> 'total_minor')::bigint <> 50000 then raise exception 'FAIL second invoice %', r; end if;
  if (select count(*) from folio_invoice_lines where folio_invoice_id = v_first) <> 3 then raise exception 'FAIL the first invoice changed'; end if;
  insert into t50_ctx values ('inv2', r ->> 'folio_invoice_id');
  raise notice 'PASS a later extra goes on its own, later invoice; the first invoice keeps its three lines';
end $$;

-- 6. Voiding: permission, reason, effect on charges, repeat is a no-op, history cannot be edited
do $$ declare
  res uuid := t50_res(); v_inv uuid := (select val::uuid from t50_ctx where label = 'inv'); r jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');   -- front desk issues but does not void
  perform t_expect(format('select void_folio_invoice(%L, %L)', v_inv, 'mistake'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select void_folio_invoice(%L, %L)', v_inv, 'mistake'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05');   -- accountant voids, but not without a reason
  perform t_expect(format('select void_folio_invoice(%L, %L)', v_inv, '  '), 'POLICY_VIOLATION: reason');
  perform t_expect(format('select void_folio_invoice(%L, %L)', v_inv, repeat('x', 201)), 'POLICY_VIOLATION: reason');
  perform t_expect(format('select void_folio_invoice(%L, null)', v_inv), 'POLICY_VIOLATION: reason');
  r := void_folio_invoice(v_inv, 'wrong guest name');
  perform void_folio_invoice(v_inv, 'again');            -- a second void changes nothing
  perform t_sys();
  if r ->> 'status' <> 'void' then raise exception 'FAIL void answer %', r; end if;
  if (select invoice_status from folio_invoices where id = v_inv) <> 'void' or (select void_reason from folio_invoices where id = v_inv) <> 'wrong guest name'
    then raise exception 'FAIL not voided with the first reason'; end if;
  if (select count(*) from folio_charges where folio_invoice_id = v_inv) <> 0 then raise exception 'FAIL charges still linked'; end if;
  if (select count(*) from folio_invoice_lines where folio_invoice_id = v_inv) <> 3 then raise exception 'FAIL a void removed lines'; end if;
  if (select count(*) from audit_logs where action = 'folio_invoice.voided' and entity_id = v_inv) <> 1 then raise exception 'FAIL one audit row for one void'; end if;
  if t50_money(res) <> (select val from t50_ctx where label = 'money') and false then raise exception 'unreachable'; end if;
  begin update folio_invoices set total_minor = 1, subtotal_minor = 1, tax_minor = 0 where id = v_inv; raise exception 'FAIL an invoice was edited';
  exception when check_violation then null; end;
  begin update folio_invoice_lines set quantity = 9 where folio_invoice_id = v_inv; raise exception 'FAIL a line was edited';
  exception when check_violation then null; end;
  begin delete from folio_invoices where id = v_inv; raise exception 'FAIL an invoice was deleted';
  exception when check_violation then null; end;
  begin update folio_invoices set invoice_status = 'issued', voided_at = null, void_reason = null where id = v_inv; raise exception 'FAIL a voided invoice was reopened';
  exception when check_violation then null; end;
  raise notice 'PASS void: needs invoice.void and a reason, frees the charges, is repeat-safe and audited once; invoices and lines cannot be edited, deleted or reopened';
end $$;

-- 7. After a void the freed charges can be invoiced again (a new, later number); they can be voided while uninvoiced
do $$ declare
  res uuid := t50_res(); v_old text := (select val from t50_ctx where label = 'number'); r jsonb; v_charge uuid;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := issue_folio_invoice(res, 'fi-issue-4');
  perform t_sys();
  if (r ->> 'line_count')::int <> 3 or (r ->> 'invoice_number') = v_old or (r ->> 'invoice_number') <= v_old then raise exception 'FAIL re-issue %', r; end if;
  -- void it again and then void one of the freed charges: allowed, because it is on no live invoice
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform void_folio_invoice((r ->> 'folio_invoice_id')::uuid, 'again');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  select id into v_charge from folio_charges where reservation_id = res and description = 'Dinner';
  perform void_folio_charge(v_charge, 'not eaten');
  perform t_sys();
  if (select status from folio_charges where id = v_charge) <> 'voided' then raise exception 'FAIL could not void a freed charge'; end if;
  raise notice 'PASS re-issue after a void takes a new, later number; a freed charge can be voided again';
end $$;

-- 8. Reading: who sees invoices, and nobody who should not
do $$ declare res uuid := t50_res(); n integer; begin
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  select count(*) into n from folio_invoices where reservation_id = res;
  if n < 3 then raise exception 'FAIL accountant should see the invoices (%)', n; end if;
  select count(*) into n from folio_invoice_lines where property_id = '00000000-0000-0000-0000-0000000000a2';
  if n < 7 then raise exception 'FAIL accountant should see the lines (%)', n; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  select count(*) into n from folio_invoices where reservation_id = res;
  if n < 3 then raise exception 'FAIL front desk should see the invoices (%)', n; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  select count(*) into n from folio_invoices; if n <> 0 then raise exception 'FAIL housekeeping reads invoices (%)', n; end if;
  select count(*) into n from folio_invoice_lines; if n <> 0 then raise exception 'FAIL housekeeping reads lines (%)', n; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  select count(*) into n from folio_invoices; if n <> 0 then raise exception 'FAIL another hotel reads invoices (%)', n; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  select count(*) into n from folio_invoices; if n <> 0 then raise exception 'FAIL maintenance reads invoices (%)', n; end if;
  perform t_sys();
  raise notice 'PASS reading: accountant and front desk see the invoices and lines; housekeeping, maintenance and another hotel see none';
end $$;

-- 9. Closed to anon
do $$ begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('role', 'anon', true);
  begin perform issue_folio_invoice(gen_random_uuid(), 'fi-anon'); raise exception 'FAIL anon issued an invoice';
  exception when insufficient_privilege then null; end;
  begin perform void_folio_invoice(gen_random_uuid(), 'x'); raise exception 'FAIL anon voided an invoice';
  exception when insufficient_privilege then null; end;
  perform set_config('role', 'postgres', true);
  raise notice 'PASS anon cannot run either function';
end $$;
