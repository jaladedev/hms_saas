-- Group bookings, step four (migration 155): company accounts, credit terms, corporate rate. Hotel A as in tests 149, 153 and 154.
\set ON_ERROR_STOP on

do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; c jsonb; v_c uuid; v_c2 uuid; v_g uuid; v_g2 uuid; e jsonb; ra text; rb text; rc text; rd text; res jsonb; inv jsonb; l jsonb; v_sub bigint; v_tax bigint; v_tot bigint; begin
  -- who may
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select company_create(%L, ''Acme'', ''Ada'', null, null, 30, 10, null, null)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select company_list(%L)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select company_create(%L, '''', ''Ada'', null, null, 30, 10, null, null)', v_p), 'POLICY_VIOLATION: details');
  perform t_expect(format('select company_create(%L, ''X'', ''Ada'', null, null, 91, 10, null, null)', v_p), 'POLICY_VIOLATION: details');
  perform t_expect(format('select company_create(%L, ''X'', ''Ada'', null, null, 30, 51, null, null)', v_p), 'POLICY_VIOLATION: details');
  perform t_expect(format('select company_create(%L, ''X'', ''Ada'', ''nope'', null, 30, 10, null, null)', v_p), 'POLICY_VIOLATION: details');
  v_c := (company_create(v_p, '  Globex Nigeria ', 'Tola Bank', 'ap@globex.example', '08011112222', 30, 12.5, 'Net 30', null)::jsonb ->> 'company_id')::uuid;
  perform t_expect(format('select company_create(%L, ''GLOBEX nigeria'', ''x'', null, null, 0, 0, null, null)', v_p), 'POLICY_VIOLATION: name taken');
  v_c2 := (company_create(v_p, 'No Rate Co', 'Ngozi', null, null, 0, 0, null, null)::jsonb ->> 'company_id')::uuid;
  c := company_list(v_p);
  if jsonb_array_length(c) <> 2 or c -> 0 ->> 'name' <> 'Globex Nigeria' then raise exception 'FAIL list %', c; end if;

  -- attach to a group
  v_g := (t149_group('Corporate Group', 3, 0, 700, 4, 690)::jsonb ->> 'group_id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select set_group_company(%L, %L)', v_g, v_c), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select set_group_company(%L, %L)', v_g, gen_random_uuid()), 'POLICY_VIOLATION: company');
  perform set_group_company(v_g, v_c);
  if group_detail(v_g) ->> 'company_account' <> 'Globex Nigeria' then raise exception 'FAIL detail company'; end if;

  -- a rate needs a company with a rate
  v_g2 := (t149_group('No Rate Group', 1, 0, 720, 2, 710)::jsonb ->> 'group_id')::uuid;
  perform set_group_company(v_g2, v_c2);
  perform t_expect(format('select apply_company_rate_to_group(%L, ''cr-0'')', v_g2), 'POLICY_VIOLATION: no company rate');
  perform set_group_company(v_g2, null);
  perform t_expect(format('select apply_company_rate_to_group(%L, ''cr-0b'')', v_g2), 'POLICY_VIOLATION: no company rate');

  -- apply: confirmed with no discount gets it, the others are skipped
  ra := t150_ref(700, 702, 'g155-a'); rb := t150_ref(700, 703, 'g155-b'); rc := t150_ref(701, 703, 'g155-c'); rd := t150_ref(701, 702, 'g155-d');
  e := add_rooming_entry(v_g, 'A', null, null); perform link_rooming_reservation((e ->> 'entry_id')::uuid, ra);
  e := add_rooming_entry(v_g, 'B', null, null); perform link_rooming_reservation((e ->> 'entry_id')::uuid, rb);
  e := add_rooming_entry(v_g, 'C', null, null); perform link_rooming_reservation((e ->> 'entry_id')::uuid, rc);
  e := add_rooming_entry(v_g, 'D', null, null); perform link_rooming_reservation((e ->> 'entry_id')::uuid, rd);
  perform t_sys();
  update reservations set reservation_status = 'confirmed' where booking_reference in (ra, rb, rd);
  update reservations set reservation_status = 'pending' where booking_reference = rc;
  update reservations set discount_minor = 1000, discount_percent = 5, total_minor = subtotal_minor + tax_minor - 1000 where booking_reference = rb;
  -- D is a 95% booking: a very high discount must still invoice cleanly
  update reservations set discount_minor = round((subtotal_minor + tax_minor) * 0.95), discount_percent = 95,
         total_minor = subtotal_minor + tax_minor - round((subtotal_minor + tax_minor) * 0.95) where booking_reference = rd;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select apply_company_rate_to_group(%L, ''cr-1'')', v_g), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  res := apply_company_rate_to_group(v_g, 'cr-1');
  if (res ->> 'applied')::int <> 1 or (res ->> 'skipped')::int <> 3 then raise exception 'FAIL apply %', res; end if;
  select subtotal_minor, tax_minor, total_minor into v_sub, v_tax, v_tot from reservations where booking_reference = ra;
  if v_tot <> v_sub + v_tax - round((v_sub + v_tax) * 12.5 / 100) or (select discount_percent from reservations where booking_reference = ra) <> 12.5 then raise exception 'FAIL discount maths'; end if;
  if (select discount_minor from reservations where booking_reference = rb) <> 1000 then raise exception 'FAIL existing discount replaced'; end if;
  if apply_company_rate_to_group(v_g, 'cr-1') <> res then raise exception 'FAIL replay'; end if;
  res := apply_company_rate_to_group(v_g, 'cr-2');
  if (res ->> 'applied')::int <> 0 or (res ->> 'skipped')::int <> 4 then raise exception 'FAIL second apply %', res; end if;
  -- a later change of the rate leaves applied discounts alone
  perform company_update(v_c, 'Tola Bank', 'ap@globex.example', '08011112222', 45, 20, 'Net 45', 'active', null);
  if (select discount_percent from reservations where booking_reference = ra) <> 12.5 then raise exception 'FAIL rate change touched booking'; end if;

  -- invoice: bills the company account, suggests nothing else, and copes with the 95% booking
  perform t_sys(); update reservations set reservation_status = 'confirmed' where booking_reference = rc; perform t_as('00000000-0000-0000-0000-00000000aa01');
  inv := issue_group_invoice(v_g, current_date + 45, 'gi155-1');
  if (inv ->> 'line_count')::int <> 4 then raise exception 'FAIL invoice lines %', inv; end if;
  l := group_invoice_list(v_g);
  if l -> 0 ->> 'bill_to' <> 'Globex Nigeria' then raise exception 'FAIL bill to %', l -> 0 ->> 'bill_to'; end if;
  if (l -> 0 ->> 'total_minor')::bigint <> (select sum(total_minor) from reservations where booking_reference in (ra, rb, rc, rd)) then raise exception 'FAIL invoice total'; end if;
  if exists (select 1 from jsonb_array_elements(l -> 0 -> 'lines') x where (x ->> 'net_minor')::bigint < 0 or (x ->> 'tax_minor')::bigint < 0) then raise exception 'FAIL negative line'; end if;

  -- archived companies cannot be attached; the audit trail is there
  perform company_update(v_c2, 'Ngozi', null, null, 0, 0, null, 'archived', null);
  perform t_expect(format('select set_group_company(%L, %L)', v_g, v_c2), 'POLICY_VIOLATION: company');
  if (select count(*) from audit_logs where action in ('company.created', 'company.updated', 'group.company_set', 'group.company_rate_applied', 'reservation.company_rate_applied')
        and (entity_id = v_g or entity_id in (v_c, v_c2) or entity_id in (select id from reservations where booking_reference in (ra, rb, rc, rd)))) <> 8 then raise exception 'FAIL audit rows'; end if;
  raise notice 'PASS group bookings step four: company accounts, rate applied once and never over another discount, invoice bills the company, 95 percent booking invoices';
end $$;
