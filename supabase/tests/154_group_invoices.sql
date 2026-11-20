-- Group bookings, step three (migration 154): a numbered invoice to the company. Hotel A as in tests 149 and 153.
\set ON_ERROR_STOP on

do $$ declare v_g uuid; e1 jsonb; e2 jsonb; e3 jsonb; r1 text; r2 text; r3 text; inv jsonb; inv2 jsonb; v_id uuid; l jsonb; v_sum bigint; v_booking_invoices integer; v_pay integer; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_g := (t149_group('Invoice Group', 3, 0, 600, 4, 590)::jsonb ->> 'group_id')::uuid;
  e1 := add_rooming_entry(v_g, 'Chidi Eze', null, null);
  e2 := add_rooming_entry(v_g, 'Bola Ade', null, null);
  e3 := add_rooming_entry(v_g, 'Cancelled Guy', null, null);
  r1 := t150_ref(600, 602, 'g154-a'); r2 := t150_ref(601, 603, 'g154-b'); r3 := t150_ref(600, 601, 'g154-c');
  perform link_rooming_reservation((e1 ->> 'entry_id')::uuid, r1);
  perform link_rooming_reservation((e2 ->> 'entry_id')::uuid, r2);
  perform link_rooming_reservation((e3 ->> 'entry_id')::uuid, r3);
  perform t_sys();
  update reservations set reservation_status = 'confirmed' where booking_reference in (r1, r2);
  update reservations set reservation_status = 'cancelled' where booking_reference = r3;
  update group_bookings set company = 'Acme Ltd' where id = v_g;
  select count(*) into v_booking_invoices from invoices; select count(*) into v_pay from payments;

  -- who may
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select issue_group_invoice(%L, current_date + 30, ''gi-1'')', v_g), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select issue_group_invoice(%L, current_date + 30, ''gi-1'')', v_g), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select issue_group_invoice(%L, current_date - 1, ''gi-1'')', v_g), 'POLICY_VIOLATION: due date');
  perform t_expect(format('select issue_group_invoice(%L, current_date + 400, ''gi-1'')', v_g), 'POLICY_VIOLATION: due date');

  -- issue: two live bookings, the cancelled one is left out
  inv := issue_group_invoice(v_g, current_date + 30, 'gi-1');
  if (inv ->> 'line_count')::int <> 2 or inv ->> 'invoice_number' !~ '^INV-.+-[0-9]{4}-[0-9]{6}$' then raise exception 'FAIL issue %', inv; end if;
  select sum(total_minor) into v_sum from reservations where booking_reference in (r1, r2);
  if (inv ->> 'total_minor')::bigint <> v_sum or v_sum <= 0 then raise exception 'FAIL total % vs %', inv, v_sum; end if;
  if issue_group_invoice(v_g, current_date + 30, 'gi-1') <> inv then raise exception 'FAIL replay'; end if;
  if (select count(*) from group_invoices where group_id = v_g) <> 1 then raise exception 'FAIL duplicate invoice'; end if;
  perform t_expect(format('select issue_group_invoice(%L, current_date + 30, ''gi-2'')', v_g), 'INVALID_STATE: nothing to invoice');
  l := group_invoice_list(v_g);
  if jsonb_array_length(l) <> 1 or l -> 0 ->> 'bill_to' <> 'Acme Ltd' or jsonb_array_length(l -> 0 -> 'lines') <> 2 then raise exception 'FAIL list %', l; end if;
  -- the bookings' own money is untouched
  if (select count(*) from invoices) <> v_booking_invoices or (select count(*) from payments) <> v_pay then raise exception 'FAIL booking money touched'; end if;

  -- reading needs money permission
  perform t_sys();
  insert into role_permissions (role_id, permission_id) select r.id, p.id from roles r, permissions p where r.key = 'housekeeping' and p.key = 'group.manage';
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select group_invoice_list(%L)', v_g), 'NOT_FOUND');
  perform t_sys();
  delete from role_permissions where role_id = (select id from roles where key = 'housekeeping') and permission_id = (select id from permissions where key = 'group.manage');
  perform t_as('00000000-0000-0000-0000-00000000aa01');

  -- mark paid, then it is final
  v_id := (inv ->> 'group_invoice_id')::uuid;
  perform t_expect(format('select mark_group_invoice_paid(%L, ''cheque'', null)', v_id), 'POLICY_VIOLATION: method');
  perform mark_group_invoice_paid(v_id, 'bank_transfer', 'TRF-998');
  perform t_expect(format('select mark_group_invoice_paid(%L, ''cash'', null)', v_id), 'INVALID_STATE: paid');
  perform t_expect(format('select void_group_invoice(%L, ''oops'')', v_id), 'INVALID_STATE: paid');
  if (select (group_invoice_list(v_g) -> 0 ->> 'status')) <> 'paid' then raise exception 'FAIL paid status'; end if;
  if (select count(*) from payments) <> v_pay then raise exception 'FAIL mark paid posted a booking payment'; end if;

  -- history cannot be edited
  perform t_sys();
  begin update group_invoices set total_minor = total_minor + 1 where id = v_id; raise exception 'FAIL invoice edited';
  exception when check_violation then null; end;
  begin delete from group_invoice_lines where group_invoice_id = v_id; raise exception 'FAIL lines deleted';
  exception when check_violation then null; end;

  -- a second invoice: add a booking, void-and-reissue path
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  e1 := add_rooming_entry(v_g, 'Late Guest', null, null);
  r1 := t150_ref(602, 604, 'g154-d');
  perform link_rooming_reservation((e1 ->> 'entry_id')::uuid, r1);
  perform t_sys(); update reservations set reservation_status = 'confirmed' where booking_reference = r1; perform t_as('00000000-0000-0000-0000-00000000aa01');
  inv2 := issue_group_invoice(v_g, current_date + 20, 'gi-3');
  if (inv2 ->> 'line_count')::int <> 1 or inv2 ->> 'invoice_number' = inv ->> 'invoice_number' then raise exception 'FAIL second invoice %', inv2; end if;
  perform t_expect(format('select void_group_invoice(%L, '''')', (inv2 ->> 'group_invoice_id')::uuid), 'POLICY_VIOLATION: reason');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select void_group_invoice(%L, ''x'')', (inv2 ->> 'group_invoice_id')::uuid), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform void_group_invoice((inv2 ->> 'group_invoice_id')::uuid, 'wrong due date');
  perform t_expect(format('select void_group_invoice(%L, ''again'')', (inv2 ->> 'group_invoice_id')::uuid), 'INVALID_STATE: void');
  -- a voided invoice frees its booking to be billed again
  inv2 := issue_group_invoice(v_g, current_date + 25, 'gi-4');
  if (inv2 ->> 'line_count')::int <> 1 then raise exception 'FAIL reissue %', inv2; end if;
  if (select count(*) from audit_logs where action like 'group_invoice.%' and entity_id in (select id from group_invoices where group_id = v_g)) <> 5 then raise exception 'FAIL audit rows'; end if;
  raise notice 'PASS group bookings step three: group invoice issue, replay, skip cancelled, paid and void rules, history, money untouched';
end $$;
