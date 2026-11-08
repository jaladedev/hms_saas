-- A date change on a booking that has money on it (migration 070, update_reservation_stay + stay_change_reconcile).
-- Reuses t_as / t_sys / t_expect / t_book (05). Users: aa01 owner A, aa02 housekeeping A, aa04 front desk A.
-- Ids: a2 property A, a3 the STD room type. Dates use offsets 1500 to 1590 from today (nothing else comes near them).
\set ON_ERROR_STOP on

create table t71_ctx (label text primary key, val text not null);
create function t71_get(p_label text) returns text language sql stable as $$ select val from t71_ctx where label = p_label $$;
create function t71_upd(p_res uuid, p_arr date, p_dep date, p_guests text, p_key text) returns jsonb
language sql as $$ select update_reservation_stay(p_res, p_arr, p_dep, p_guests::jsonb, 'test', p_key) $$;
create function t71_live(p_res uuid) returns uuid language sql stable as $$ select id from invoices where reservation_id = p_res and invoice_status <> 'void' $$;
create function t71_live_count(p_res uuid) returns bigint language sql stable as $$ select count(*) from invoices where reservation_id = p_res and invoice_status <> 'void' $$;
create function t71_void_count(p_res uuid) returns bigint language sql stable as $$ select count(*) from invoices where reservation_id = p_res and invoice_status = 'void' $$;
create function t71_total(p_res uuid) returns bigint language sql stable as $$ select total_minor from reservations where id = p_res $$;
-- The live invoice says what the booking says, line by line, and what it holds is what the payments allocated to it
create function t71_sound(p_res uuid) returns boolean language sql stable as $$
  select exists (
    select 1 from reservations r join invoices i on i.reservation_id = r.id and i.invoice_status <> 'void'
     where r.id = p_res and i.subtotal_minor = r.subtotal_minor and i.tax_minor = r.tax_minor and i.total_minor = r.total_minor
       and (select coalesce(sum(l.line_total_minor), 0) from invoice_lines l where l.invoice_id = i.id) = r.total_minor
       and (select count(*) from invoice_lines l where l.invoice_id = i.id) = (select count(*) from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = r.id)
       and (select coalesce(sum(a.amount_minor), 0) from payment_allocations a where a.invoice_id = i.id) = least(reservation_money_held(r.id), r.total_minor))
$$;
create function t71_fp(p_res uuid) returns text language sql stable as $$
  select concat_ws('|', r.arrival_date, r.departure_date, r.total_minor, r.payment_status, r.attention_reason,
                   (select count(*) from invoices where reservation_id = r.id), (select count(*) from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = r.id))
    from reservations r where r.id = p_res
$$;

-- 1. Part-paid and invoiced, the stay gets LONGER: the invoice is replaced, the money moves to the new one, a balance is due
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; old_inv uuid; old_total bigint; paid bigint; r jsonb; old_no text;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1500, t + 1502, 'sm-1-b'); res := (b ->> 'reservation_id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000aa01'); perform issue_invoice(res, 'sm-1-i');
  perform t_sys(); old_total := t71_total(res); paid := old_total / 2; old_inv := t71_live(res);
  select invoice_number into old_no from invoices where id = old_inv;
  insert into t71_ctx values ('s1', res::text);
  perform t_as('00000000-0000-0000-0000-00000000aa04'); perform record_manual_payment(res, paid, 'cash', null, null, 'sm-1-p');
  r := t71_upd(res, t + 1500, t + 1503, null, 'sm-1-u');
  perform t_sys();
  if (select arrival_date from reservations where id = res) <> t + 1500 or (select departure_date from reservations where id = res) <> t + 1503 then raise exception 'FAIL dates not changed'; end if;
  if t71_total(res) <= old_total then raise exception 'FAIL a longer stay did not cost more'; end if;
  if t71_live_count(res) <> 1 or t71_live(res) = old_inv then raise exception 'FAIL the live invoice was not replaced'; end if;
  if (select invoice_status from invoices where id = old_inv) <> 'void' or (select void_reason from invoices where id = old_inv) <> 'stay change' then raise exception 'FAIL the old invoice is not void for a stay change'; end if;
  if (select invoice_number from invoices where id = t71_live(res)) = old_no then raise exception 'FAIL the new invoice reuses the number'; end if;
  if not t71_sound(res) then raise exception 'FAIL the new invoice does not match the booking'; end if;
  if (select payment_status from reservations where id = res) <> 'partially_paid' then raise exception 'FAIL status %', (select payment_status from reservations where id = res); end if;
  if (select invoice_status from invoices where id = t71_live(res)) <> 'partially_paid' then raise exception 'FAIL invoice status'; end if;
  if (select attention_reason from reservations where id = res) is not null then raise exception 'FAIL a flag with no surplus'; end if;
  if (r ->> 'invoice_replaced')::boolean is not true or (r ->> 'surplus_minor')::bigint <> 0 then raise exception 'FAIL the answer: %', r; end if;
  if (select count(*) from audit_logs where action = 'reservation.stay_changed' and entity_id = res and (metadata ->> 'invoice_replaced')::boolean) <> 1 then raise exception 'FAIL audit'; end if;
  -- a replay returns the first answer and replaces nothing again
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if t71_upd(res, t + 1500, t + 1503, null, 'sm-1-u') <> r then raise exception 'FAIL replay differs'; end if;
  perform t_sys();
  if t71_void_count(res) <> 1 or t71_live_count(res) <> 1 then raise exception 'FAIL a replay replaced the invoice again'; end if;
  raise notice 'PASS a longer stay on a part-paid, invoiced booking: invoice replaced once, money carried over, balance due, no flag';
end $$;

-- 2. Fully paid and invoiced, the stay gets SHORTER: a refund is flagged, not made; asking for it clears the flag
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; old_total bigint; r jsonb; pay uuid; surplus bigint;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1510, t + 1513, 'sm-2-b'); res := (b ->> 'reservation_id')::uuid;
  perform t_sys(); old_total := t71_total(res);
  perform t_as('00000000-0000-0000-0000-00000000aa04'); perform record_manual_payment(res, old_total, 'cash', null, null, 'sm-2-p');
  perform t_as('00000000-0000-0000-0000-00000000aa01'); perform issue_invoice(res, 'sm-2-i');
  perform t_sys(); insert into t71_ctx values ('s2', res::text);
  if (select payment_status from reservations where id = res) <> 'paid' then raise exception 'FAIL not paid before the edit'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := t71_upd(res, t + 1510, t + 1512, null, 'sm-2-u');
  perform t_sys();
  surplus := old_total - t71_total(res);
  if surplus <= 0 then raise exception 'FAIL a shorter stay did not cost less'; end if;
  if (r ->> 'surplus_minor')::bigint <> surplus then raise exception 'FAIL surplus in the answer: % vs %', r ->> 'surplus_minor', surplus; end if;
  if (select attention_reason from reservations where id = res) is distinct from 'stay_change_refund_due' then raise exception 'FAIL the booking was not flagged'; end if;
  if (select count(*) from refunds where reservation_id = res) <> 0 then raise exception 'FAIL a refund was created by the edit'; end if;
  if not t71_sound(res) then raise exception 'FAIL the new invoice does not match the booking'; end if;
  if (select payment_status from reservations where id = res) <> 'paid' or (select invoice_status from invoices where id = t71_live(res)) <> 'paid' then raise exception 'FAIL the smaller total is not covered'; end if;
  if (select count(*) from notifications where entity_id = res and title like 'Refund due after a date change%') <> 1 then raise exception 'FAIL no notice'; end if;
  -- a person asks for the difference; the flag clears
  select id into pay from payments where reservation_id = res and payment_status = 'succeeded';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform request_refund(pay, surplus, 'dates shortened', 'sm-2-rf');
  perform t_sys();
  -- request_refund does not refresh the money state itself (test 61 does the same); the next refresh clears the flag
  if (select attention_reason from reservations where id = res) is null then raise exception 'FAIL the flag cleared before any refresh'; end if;
  perform refresh_money_state(res);
  if (select attention_reason from reservations where id = res) is not null then raise exception 'FAIL the flag did not clear after the refund was requested'; end if;
  raise notice 'PASS a shorter stay on a paid, invoiced booking: invoice replaced, surplus flagged and noticed, no refund made, flag clears once the refund is asked for';
end $$;

-- 3. Fully paid, the stay gets LONGER: no flag, the status drops to part-paid and the new invoice shows the balance
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; old_total bigint;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1520, t + 1522, 'sm-3-b'); res := (b ->> 'reservation_id')::uuid;
  perform t_sys(); old_total := t71_total(res);
  perform t_as('00000000-0000-0000-0000-00000000aa04'); perform record_manual_payment(res, old_total, 'cash', null, null, 'sm-3-p');
  perform t_as('00000000-0000-0000-0000-00000000aa01'); perform issue_invoice(res, 'sm-3-i');
  perform t_as('00000000-0000-0000-0000-00000000aa04'); perform t71_upd(res, t + 1519, t + 1523, null, 'sm-3-u');
  perform t_sys();
  if (select payment_status from reservations where id = res) <> 'partially_paid' then raise exception 'FAIL status after a longer stay'; end if;
  if (select attention_reason from reservations where id = res) is not null then raise exception 'FAIL flagged with a balance due'; end if;
  if not t71_sound(res) then raise exception 'FAIL the invoice does not match'; end if;
  raise notice 'PASS a longer stay on a paid booking leaves a balance due and no flag';
end $$;

-- 4. Money but no invoice: no invoice is invented; a surplus is still flagged
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; old_total bigint;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1530, t + 1533, 'sm-4-b'); res := (b ->> 'reservation_id')::uuid;
  perform t_sys(); old_total := t71_total(res);
  perform t_as('00000000-0000-0000-0000-00000000aa04'); perform record_manual_payment(res, old_total, 'cash', null, null, 'sm-4-p');
  perform t71_upd(res, t + 1530, t + 1531, null, 'sm-4-u');
  perform t_sys();
  if (select count(*) from invoices where reservation_id = res) <> 0 then raise exception 'FAIL an invoice was invented'; end if;
  if (select attention_reason from reservations where id = res) is distinct from 'stay_change_refund_due' then raise exception 'FAIL surplus not flagged without an invoice'; end if;
  raise notice 'PASS with money and no invoice: nothing is invoiced, the surplus is flagged';
end $$;

-- 5. No money, no invoice: the edit behaves exactly as before (033)
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; r jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1540, t + 1542, 'sm-5-b'); res := (b ->> 'reservation_id')::uuid;
  r := t71_upd(res, t + 1540, t + 1543, null, 'sm-5-u');
  perform t_sys();
  if (select count(*) from invoices where reservation_id = res) <> 0 or (select attention_reason from reservations where id = res) is not null then raise exception 'FAIL an unpaid booking grew money records'; end if;
  if (r ->> 'invoice_replaced')::boolean is not false or (r ->> 'surplus_minor')::bigint <> 0 then raise exception 'FAIL the answer: %', r; end if;
  raise notice 'PASS an unpaid, uninvoiced booking is edited exactly as before';
end $$;

-- 6. Guests only on a paid, invoiced booking: the invoice is left alone
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; inv uuid; fp text; rr uuid;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1550, t + 1552, 'sm-6-b'); res := (b ->> 'reservation_id')::uuid; rr := (b -> 'rooms' -> 0 ->> 'reservation_room_id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000aa04'); perform record_manual_payment(res, 1000, 'cash', null, null, 'sm-6-p');
  perform t_as('00000000-0000-0000-0000-00000000aa01'); perform issue_invoice(res, 'sm-6-i');
  perform t_sys(); inv := t71_live(res); fp := t71_fp(res);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t71_upd(res, t + 1550, t + 1552, format('[{"reservation_room_id":"%s","adults":2,"children":0}]', rr), 'sm-6-u');
  perform t_sys();
  if t71_live(res) <> inv or t71_void_count(res) <> 0 or t71_fp(res) <> fp then raise exception 'FAIL a guests-only edit touched the money'; end if;
  raise notice 'PASS a guests-only edit leaves the invoice and money alone';
end $$;

-- 7. What still refuses: a discount, a payment in flight; and who may edit. Nothing changes.
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; fp text; v_att uuid := gen_random_uuid();
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1560, t + 1562, 'sm-7-b'); res := (b ->> 'reservation_id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000aa04'); perform record_manual_payment(res, 1000, 'cash', null, null, 'sm-7-p');
  perform t_as('00000000-0000-0000-0000-00000000aa01'); perform apply_discount(res, 5, 'regular guest', 'sm-7-d');
  perform t_sys(); fp := t71_fp(res);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t71_upd(%L,%L,%L,null,%L)', res, t + 1560, t + 1563, 'sm-7-u1'), 'POLICY_VIOLATION: discount');
  perform t_sys(); if t71_fp(res) <> fp then raise exception 'FAIL a discounted booking changed'; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1570, t + 1572, 'sm-7-b2'); res := (b ->> 'reservation_id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000aa04'); perform record_manual_payment(res, 1000, 'cash', null, null, 'sm-7-p2');
  perform t_sys();
  insert into payment_attempts (id, tenant_id, property_id, reservation_id, provider, reference, amount_minor, currency, status)
  select v_att, tenant_id, property_id, id, 'paystack', 'sm-7-ref', 100000, currency, 'initiated' from reservations where id = res;
  fp := t71_fp(res);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t71_upd(%L,%L,%L,null,%L)', res, t + 1570, t + 1573, 'sm-7-u2'), 'INVALID_STATE: payment started');
  perform t_sys(); if t71_fp(res) <> fp then raise exception 'FAIL a booking with a payment in flight changed'; end if;

  -- housekeeping still sees nothing
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select t71_upd(%L,%L,%L,null,%L)', t71_get('s1')::uuid, t + 1500, t + 1504, 'sm-7-hk'), 'NOT_FOUND');
  perform t_sys();
  raise notice 'PASS a discount and a payment in flight still refuse the edit and change nothing; housekeeping still sees nothing';
end $$;
