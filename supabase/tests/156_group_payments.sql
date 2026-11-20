-- Group bookings, step six (migration 156): one company payment settling a group's bookings. Hotel A as in tests 149 to 155.
\set ON_ERROR_STOP on

create function t156_held(p uuid) returns bigint language sql security definer set search_path = public as $$ select reservation_money_held(p) $$;

do $$ declare v_g uuid; e jsonb; ra text; rb text; rc text; v_a uuid; v_b uuid; v_c uuid; ta bigint; tb bigint; tc bigint; gp jsonb; gp2 jsonb; s jsonb; v_n integer; l jsonb; v_pay_before integer; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_g := (t149_group('Pay Group', 3, 0, 800, 4, 790)::jsonb ->> 'group_id')::uuid;
  ra := t150_ref(800, 802, 'g156-a'); rb := t150_ref(800, 803, 'g156-b'); rc := t150_ref(801, 803, 'g156-c');
  e := add_rooming_entry(v_g, 'A', null, null); perform link_rooming_reservation((e ->> 'entry_id')::uuid, ra);
  e := add_rooming_entry(v_g, 'B', null, null); perform link_rooming_reservation((e ->> 'entry_id')::uuid, rb);
  e := add_rooming_entry(v_g, 'C', null, null); perform link_rooming_reservation((e ->> 'entry_id')::uuid, rc);
  perform t_sys();
  update reservations set reservation_status = 'confirmed' where booking_reference in (ra, rb, rc);
  -- references are random: fix them so the arrival order the auto split depends on (A, then B, then C) is what the test says it is
  update reservations set booking_reference = 'BK-156AAAA1' where booking_reference = ra;
  update reservations set booking_reference = 'BK-156AAAA2' where booking_reference = rb;
  update reservations set booking_reference = 'BK-156AAAA3' where booking_reference = rc;
  ra := 'BK-156AAAA1'; rb := 'BK-156AAAA2'; rc := 'BK-156AAAA3';
  select id, total_minor into v_a, ta from reservations where booking_reference = ra;
  select id, total_minor into v_b, tb from reservations where booking_reference = rb;
  select id, total_minor into v_c, tc from reservations where booking_reference = rc;
  if least(ta, tb, tc) < 5000 then raise exception 'FAIL fixture totals % % %', ta, tb, tc; end if;
  select count(*) into v_pay_before from payments;

  -- who may
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select record_group_payment(%L, 1000, ''cash'', null, null, null, ''gp-x'')', v_g), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select record_group_payment(%L, 1000, ''cash'', null, null, null, ''gp-x'')', v_g), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');

  -- what is accepted
  perform t_expect(format('select record_group_payment(%L, 0, ''cash'', null, null, null, ''gp-1'')', v_g), 'POLICY_VIOLATION: amount');
  perform t_expect(format('select record_group_payment(%L, 1000, ''cheque'', null, null, null, ''gp-1'')', v_g), 'POLICY_VIOLATION: method');
  perform t_expect(format('select record_group_payment(%L, 1000, ''cash'', null, null, ''[{"reservation_id": "%s", "amount_minor": 900}]'', ''gp-1'')', v_g, v_a), 'POLICY_VIOLATION: allocation total');
  perform t_expect(format('select record_group_payment(%L, 1000, ''cash'', null, null, ''[{"reservation_id": "%s", "amount_minor": 1000}]'', ''gp-1'')', v_g, gen_random_uuid()), 'POLICY_VIOLATION: allocation');
  perform t_expect(format('select record_group_payment(%L, %s, ''cash'', null, null, ''[{"reservation_id": "%s", "amount_minor": %s}]'', ''gp-1'')', v_g, ta + 1, v_a, ta + 1), 'POLICY_VIOLATION: OVERPAYMENT outstanding ' || ta);
  perform t_expect(format('select record_group_payment(%L, %s, ''cash'', null, null, null, ''gp-2'')', v_g, ta + tb + tc + 1), 'POLICY_VIOLATION: exceeds outstanding');
  if (select count(*) from payments) <> v_pay_before or (select count(*) from group_payments where group_id = v_g) <> 0 then raise exception 'FAIL a refused payment left rows'; end if;

  -- auto split: fills A completely, then part of B, in arrival order (A and B arrive first; A has the lower reference)
  gp := record_group_payment(v_g, ta + 1000, 'bank_transfer', 'TRF-777', 'Acme June', null, 'gp-3');
  if (gp ->> 'line_count')::int <> 2 then raise exception 'FAIL lines %', gp; end if;
  if t156_held(v_a) <> ta or t156_held(v_b) <> 1000 or t156_held(v_c) <> 0 then raise exception 'FAIL split % % %', t156_held(v_a), t156_held(v_b), t156_held(v_c); end if;
  if (select payment_status from reservations where id = v_a) <> 'paid' then raise exception 'FAIL booking A status'; end if;
  if record_group_payment(v_g, ta + 1000, 'bank_transfer', 'TRF-777', 'Acme June', null, 'gp-3') <> gp then raise exception 'FAIL replay'; end if;
  if (select count(*) from payments) <> v_pay_before + 2 then raise exception 'FAIL duplicate payments'; end if;
  if (select count(*) from payments where reservation_id in (v_a, v_b) and provider_reference = 'TRF-777' and payment_method = 'bank_transfer') <> 2 then raise exception 'FAIL payment fields'; end if;

  -- explicit shares: the rest of B and part of C
  gp2 := record_group_payment(v_g, (tb - 1000) + 2000, 'cash', null, null, format('[{"reservation_id": "%s", "amount_minor": %s}, {"reservation_id": "%s", "amount_minor": 2000}]', v_b, tb - 1000, v_c)::jsonb, 'gp-4');
  if t156_held(v_b) <> tb or t156_held(v_c) <> 2000 then raise exception 'FAIL explicit split'; end if;
  perform t_expect(format('select record_group_payment(%L, 10, ''cash'', null, null, ''[{"reservation_id": "%s", "amount_minor": 5}, {"reservation_id": "%s", "amount_minor": 5}]'', ''gp-5'')', v_g, v_c, v_c), 'POLICY_VIOLATION: allocation');

  -- the statement and the list
  s := group_statement(v_g);
  if (s ->> 'held_minor')::bigint <> ta + tb + 2000 or (s ->> 'outstanding_minor')::bigint <> tc - 2000 then raise exception 'FAIL statement %', s; end if;
  l := group_payment_list(v_g);
  if jsonb_array_length(l) <> 2 or l -> 0 ->> 'state' <> 'recorded' or jsonb_array_length(l -> 0 -> 'lines') <> 2 then raise exception 'FAIL list %', l; end if;

  -- reverse: needs refund.approve as well; every line goes back; a second reversal is refused
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select reverse_group_payment(%L, ''wrong'', ''rv-1'')', (gp ->> 'group_payment_id')::uuid), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select reverse_group_payment(%L, '''', ''rv-1'')', (gp ->> 'group_payment_id')::uuid), 'POLICY_VIOLATION: reason');
  perform reverse_group_payment((gp ->> 'group_payment_id')::uuid, 'Company bounced the transfer', 'rv-2');
  if t156_held(v_a) <> 0 or t156_held(v_b) <> tb - 1000 then raise exception 'FAIL reverse maths'; end if;
  if (select payment_status from reservations where id = v_a) = 'paid' then raise exception 'FAIL booking A still paid'; end if;
  perform t_expect(format('select reverse_group_payment(%L, ''again'', ''rv-3'')', (gp ->> 'group_payment_id')::uuid), 'INVALID_STATE: reversed');
  if (select x ->> 'state' from jsonb_array_elements(group_payment_list(v_g)) x where x ->> 'id' = gp ->> 'group_payment_id') <> 'reversed' then raise exception 'FAIL reversed state'; end if;

  -- history cannot be edited
  perform t_sys();
  begin update group_payments set amount_minor = amount_minor + 1 where id = (gp ->> 'group_payment_id')::uuid; raise exception 'FAIL edited';
  exception when check_violation then null; end;
  begin delete from group_payment_lines where group_payment_id = (gp ->> 'group_payment_id')::uuid; raise exception 'FAIL deleted';
  exception when check_violation then null; end;
  if (select count(*) from audit_logs where action in ('group_payment.recorded', 'group_payment.reversed') and entity_id in ((gp ->> 'group_payment_id')::uuid, (gp2 ->> 'group_payment_id')::uuid)) <> 3 then raise exception 'FAIL audit rows'; end if;
  raise notice 'PASS group bookings step six: group payment split, all or nothing, replay safe, statement, reversal, history, audited';
end $$;
