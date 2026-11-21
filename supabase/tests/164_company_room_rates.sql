-- Group bookings, step eight (migration 164): corporate rates per room type. Hotel A as in tests 149 to 157.
\set ON_ERROR_STOP on

do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_std constant uuid := '00000000-0000-0000-0000-0000000000a3';
  v_c uuid; v_c0 uuid; v_g uuid; v_g0 uuid; e jsonb; ra text; rb text; res jsonb; v_rate bigint; v_fixed bigint; v_expect bigint; v_disc bigint; v_tot bigint; v_sub bigint; v_tax bigint; l jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_c := (company_create(v_p, 'Rates Co', 'Tola', null, null, 0, 0, null, null)::jsonb ->> 'company_id')::uuid;
  v_c0 := (company_create(v_p, 'Plain Co', 'Ngozi', null, null, 0, 0, null, null)::jsonb ->> 'company_id')::uuid;
  v_g := (t149_group('Rates Group', 3, 0, 1000, 4, 990)::jsonb ->> 'group_id')::uuid;
  perform set_group_company(v_g, v_c);
  ra := t150_ref(1000, 1002, 'g164-a'); rb := t150_ref(1001, 1003, 'g164-b');
  e := add_rooming_entry(v_g, 'A', null, null); perform link_rooming_reservation((e ->> 'entry_id')::uuid, ra);
  e := add_rooming_entry(v_g, 'B', null, null); perform link_rooming_reservation((e ->> 'entry_id')::uuid, rb);
  perform t_sys();
  update reservations set reservation_status = 'confirmed' where booking_reference in (ra, rb);
  select min(n.rate_minor) into v_rate from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id join reservations r on r.id = x.reservation_id where r.booking_reference = ra;
  perform t_as('00000000-0000-0000-0000-00000000aa01');

  -- who may set rates, and what is accepted
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select company_rate_set(%L, %L, ''fixed'', 1000)', v_c, v_std), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select company_rate_set(%L, %L, ''fixed'', 0)', v_c, v_std), 'POLICY_VIOLATION: details');
  perform t_expect(format('select company_rate_set(%L, %L, ''fixed'', 1000.5)', v_c, v_std), 'POLICY_VIOLATION: details');
  perform t_expect(format('select company_rate_set(%L, %L, ''percent'', 51)', v_c, v_std), 'POLICY_VIOLATION: details');
  perform t_expect(format('select company_rate_set(%L, %L, ''weird'', 5)', v_c, v_std), 'POLICY_VIOLATION: details');
  perform t_expect(format('select company_rate_set(%L, %L, ''fixed'', 1000)', v_c, gen_random_uuid()), 'POLICY_VIOLATION: details');

  -- no flat percent and no rates: nothing to apply
  perform set_group_company(v_g, v_c0);
  perform t_expect(format('select apply_company_rate_to_group(%L, ''rr-0'')', v_g), 'POLICY_VIOLATION: no company rate');
  perform set_group_company(v_g, v_c);

  -- a fixed rate ABOVE the nightly price gives nothing: the booking is skipped
  perform company_rate_set(v_c, v_std, 'fixed', v_rate * 10);
  res := apply_company_rate_to_group(v_g, 'rr-1');
  if (res ->> 'applied')::int <> 0 or (res ->> 'skipped')::int <> 2 then raise exception 'FAIL high fixed rate %', res; end if;

  -- a fixed rate below it: each night is brought down, tax scaled; booking A only (B gets the percent rate below)
  v_fixed := v_rate / 2;
  perform company_rate_set(v_c, v_std, 'fixed', v_fixed);
  perform t_sys(); update reservations set reservation_status = 'pending' where booking_reference = rb; perform t_as('00000000-0000-0000-0000-00000000aa01');
  select coalesce(sum(case when v_fixed < n.rate_minor then (n.rate_minor + n.tax_minor) - round((n.rate_minor + n.tax_minor) * v_fixed::numeric / n.rate_minor)::bigint else 0 end), 0)
    into v_expect from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id join reservations r on r.id = x.reservation_id where r.booking_reference = ra;
  res := apply_company_rate_to_group(v_g, 'rr-2');
  if (res ->> 'applied')::int <> 1 or (res ->> 'skipped')::int <> 1 then raise exception 'FAIL fixed apply %', res; end if;
  select discount_minor, total_minor, subtotal_minor, tax_minor into v_disc, v_tot, v_sub, v_tax from reservations where booking_reference = ra;
  if v_disc <> v_expect or v_disc <= 0 or v_tot <> v_sub + v_tax - v_disc then raise exception 'FAIL fixed maths % vs %', v_disc, v_expect; end if;
  if (select discount_amount_minor from reservations where booking_reference = ra) <> v_disc or (select discount_percent from reservations where booking_reference = ra) is not null then raise exception 'FAIL fixed-amount columns'; end if;
  if apply_company_rate_to_group(v_g, 'rr-2') <> res then raise exception 'FAIL replay'; end if;

  -- percent mode on the room type, applied to B (now confirmed again); A already has a discount and is left alone
  perform t_sys(); update reservations set reservation_status = 'confirmed' where booking_reference = rb; perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform company_rate_set(v_c, v_std, 'percent', 10);
  res := apply_company_rate_to_group(v_g, 'rr-3');
  if (res ->> 'applied')::int <> 1 or (res ->> 'skipped')::int <> 1 then raise exception 'FAIL percent apply %', res; end if;
  select discount_minor, subtotal_minor + tax_minor into v_disc, v_tot from reservations where booking_reference = rb;
  select coalesce(sum(round((n.rate_minor + n.tax_minor) * 10 / 100)), 0) into v_expect from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id join reservations r on r.id = x.reservation_id where r.booking_reference = rb;
  if v_disc <> v_expect or v_disc <= 0 then raise exception 'FAIL percent maths % vs %', v_disc, v_expect; end if;
  if (select discount_minor from reservations where booking_reference = ra) <> (select discount_amount_minor from reservations where booking_reference = ra) then raise exception 'FAIL A changed'; end if;

  -- the list carries the rates; removing one works and is audited; a flat percent still applies where no rate is set
  l := company_list(v_p);
  if jsonb_array_length((select x -> 'rates' from jsonb_array_elements(l) x where x ->> 'id' = v_c::text)) <> 1 then raise exception 'FAIL rates in list'; end if;
  perform company_rate_remove(v_c, v_std);
  if jsonb_array_length((select x -> 'rates' from jsonb_array_elements(company_list(v_p)) x where x ->> 'id' = v_c::text)) <> 0 then raise exception 'FAIL rate not removed'; end if;
  if (select count(*) from audit_logs where entity_id = v_c and action in ('company.rate_set', 'company.rate_removed')) <> 4 then raise exception 'FAIL audit rows'; end if;
  raise notice 'PASS group bookings step eight: per room type rates fixed and percent, skipped when no gain, never over a discount, list, audit';
end $$;
