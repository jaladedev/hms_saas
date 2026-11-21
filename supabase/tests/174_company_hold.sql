-- Group bookings, step fourteen (migration 174): hold a company that pays late. Hotel A as in tests 149 to 173.
\set ON_ERROR_STOP on

do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_c uuid; v_g uuid; v_g2 uuid; e jsonb; ra text; v_id uuid; v_today date;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_c := (company_create(v_p, 'Hold Co', 'Tola', 'accounts@hold.example', null, 7, 0, null, null)::jsonb ->> 'company_id')::uuid;
  v_g := (t149_group('Hold Group', 3, 0, 1400, 4, 1390)::jsonb ->> 'group_id')::uuid;
  v_g2 := (t149_group('Hold Group 2', 3, 0, 1410, 4, 1405)::jsonb ->> 'group_id')::uuid;
  perform set_group_company(v_g, v_c);
  ra := t150_ref(1400, 1402, 'g174-a');
  e := add_rooming_entry(v_g, 'A', null, null); perform link_rooming_reservation((e ->> 'entry_id')::uuid, ra);
  perform t_sys(); update reservations set reservation_status = 'confirmed' where booking_reference = ra; perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_id := (issue_group_invoice(v_g, current_date + 7, 'hd-1') ->> 'group_invoice_id')::uuid;

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select company_set_hold(%L, 10)', v_c), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select company_set_hold(%L, 0)', v_c), 'POLICY_VIOLATION: details');
  perform t_expect(format('select company_set_hold(%L, 400)', v_c), 'POLICY_VIOLATION: details');

  -- invoice 20 days late, no hold set: linking works
  perform t_sys(); v_today := property_today(v_p);
  alter table group_invoices disable trigger group_invoices_guard_trg;
  update group_invoices set due_date = v_today - 20 where id = v_id;
  alter table group_invoices enable trigger group_invoices_guard_trg;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if (select (x ->> 'on_hold')::boolean from jsonb_array_elements(company_list(v_p)) x where x ->> 'id' = v_c::text) then raise exception 'FAIL on hold without a rule'; end if;

  -- hold after 30 days: 20 is fine; after 15 it trips
  perform company_set_hold(v_c, 30); perform company_set_hold(v_c, 30);
  if (select count(*) from audit_logs where entity_id = v_c and action = 'company.hold_set') <> 1 then raise exception 'FAIL audit'; end if;
  perform set_group_company(v_g2, v_c);
  perform set_group_company(v_g2, null);
  perform company_set_hold(v_c, 15);
  if not (select (x ->> 'on_hold')::boolean from jsonb_array_elements(company_list(v_p)) x where x ->> 'id' = v_c::text) then raise exception 'FAIL not on hold'; end if;
  perform t_expect(format('select set_group_company(%L, %L)', v_g2, v_c), 'POLICY_VIOLATION: company on hold');
  -- the group already linked can be set again, and unlinking is allowed
  perform set_group_company(v_g, v_c);

  -- paying clears it; clearing the rule clears it too
  perform mark_group_invoice_paid(v_id, 'bank_transfer', 'REF-174');
  perform set_group_company(v_g2, v_c);
  perform set_group_company(v_g2, null);
  perform company_set_hold(v_c, null);
  if (select hold_after_days from company_accounts where id = v_c) is not null then raise exception 'FAIL clear'; end if;
  raise notice 'PASS group bookings step fourteen: hold rule validated and audited, blocks new links only while overdue, paying or clearing lifts it';
end $$;
