-- Group bookings, step nine (migration 165): the company rate is applied when a booking is linked to the group. Hotel A as in tests 149 to 164.
\set ON_ERROR_STOP on

do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_std constant uuid := '00000000-0000-0000-0000-0000000000a3';
  v_c uuid; v_g uuid; e jsonb; ra text; rb text; rc text; v_rate bigint; v_disc bigint;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_c := (company_create(v_p, 'Auto Co', 'Tola', null, null, 0, 0, null, null)::jsonb ->> 'company_id')::uuid;
  v_g := (t149_group('Auto Group', 3, 0, 1100, 4, 1090)::jsonb ->> 'group_id')::uuid;
  perform set_group_company(v_g, v_c);
  ra := t150_ref(1100, 1102, 'g165-a'); rb := t150_ref(1101, 1103, 'g165-b'); rc := t150_ref(1102, 1104, 'g165-c');
  perform t_sys();
  update reservations set reservation_status = 'confirmed' where booking_reference in (ra, rb);
  update reservations set reservation_status = 'pending' where booking_reference = rc;
  select min(n.rate_minor) into v_rate from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id join reservations r on r.id = x.reservation_id where r.booking_reference = ra;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform company_rate_set(v_c, v_std, 'fixed', v_rate / 2);

  -- switch off by default: linking changes nothing
  e := add_rooming_entry(v_g, 'A', null, null); perform link_rooming_reservation((e ->> 'entry_id')::uuid, ra);
  if (select discount_minor from reservations where booking_reference = ra) <> 0 then raise exception 'FAIL applied while off'; end if;

  -- who may switch it
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select company_set_auto_rate(%L, true)', v_c), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select company_set_auto_rate(%L, null)', v_c), 'POLICY_VIOLATION: details');
  perform company_set_auto_rate(v_c, true);
  perform company_set_auto_rate(v_c, true);
  if (select count(*) from audit_logs where entity_id = v_c and action = 'company.auto_rate_set') <> 1 then raise exception 'FAIL audit'; end if;
  if not (select (x ->> 'auto_apply_rate')::boolean from jsonb_array_elements(company_list(v_p)) x where x ->> 'id' = v_c::text) then raise exception 'FAIL list'; end if;

  -- on: a confirmed booking gets the rate at link time, with an audit row
  e := add_rooming_entry(v_g, 'B', null, null); perform link_rooming_reservation((e ->> 'entry_id')::uuid, rb);
  select discount_minor into v_disc from reservations where booking_reference = rb;
  if v_disc <= 0 or (select total_minor from reservations where booking_reference = rb) <> (select subtotal_minor + tax_minor - v_disc from reservations where booking_reference = rb) then raise exception 'FAIL not applied at link %', v_disc; end if;
  if (select count(*) from audit_logs where action = 'reservation.company_rate_applied' and entity_id = (select id from reservations where booking_reference = rb)) <> 1 then raise exception 'FAIL link audit'; end if;

  -- a booking that is not confirmed is linked but left alone
  e := add_rooming_entry(v_g, 'C', null, null); perform link_rooming_reservation((e ->> 'entry_id')::uuid, rc);
  if (select discount_minor from reservations where booking_reference = rc) <> 0 then raise exception 'FAIL pending booking discounted'; end if;
  raise notice 'PASS group bookings step nine: company rate applied at link time when on, not when off, not for unconfirmed bookings, audited';
end $$;
