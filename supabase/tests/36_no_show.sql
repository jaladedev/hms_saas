-- Marking a no-show (migration 037, mark_no_show). Reuses t_as / t_sys / t_expect (05) and t07_res (07).
-- Users: aa01 owner A (may cancel), aa04 front desk A (may not), aa02 housekeeping, bb01 owner of Hotel B.
-- A booking arriving today whose check-in time is set to midnight is "past check-in time". Future bookings use offset 1400.
\set ON_ERROR_STOP on

-- A confirmed booking arriving today (check-in time already passed) with the given rule; optionally paid in full
create function t36_setup(p_key text, p_rule jsonb, p_pay boolean, p_off integer default 0) returns uuid language plpgsql as $$
declare v_res uuid; v_total bigint; v_type uuid;
begin
  perform t_sys();
  -- Today's rooms may be taken by earlier fixtures when the whole suite runs, so try each room type of the property.
  for v_type in select id from room_types where property_id = '00000000-0000-0000-0000-0000000000a2' and status = 'active' order by (id = '00000000-0000-0000-0000-0000000000a3') desc, id loop
    begin
      v_res := (t_book(v_type, property_today('00000000-0000-0000-0000-0000000000a2') + p_off,
                       property_today('00000000-0000-0000-0000-0000000000a2') + p_off + 2, 't36-book-' || p_key) ->> 'reservation_id')::uuid;
      exit;
    exception when sqlstate 'P0001' then
      if sqlerrm not like 'ROOM_UNAVAILABLE%' and sqlerrm not like 'RATE_MISSING%' then raise; end if;
    end;
  end loop;
  if v_res is null then raise exception 'FAIL fixture: no room type free on that day'; end if;
  update reservations set policy_snapshot = policy_snapshot || '{"check_in_time":"00:00:00"}'::jsonb || p_rule where id = v_res;
  if p_pay then
    select total_minor into v_total from reservations where id = v_res;
    perform record_manual_payment(v_res, v_total, 'cash', 'r-' || p_key, null, 't36-pay-' || p_key);
  end if;
  return v_res;
end $$;
create function t36_ns(p_res uuid, p_note text, p_waive boolean, p_key text) returns jsonb language sql as $$
  select mark_no_show(p_res, p_note, p_waive, p_key)
$$;

-- 1. Who may mark it
do $$ declare v_res uuid; begin
  v_res := t36_setup('perm', '{"cancellation_rules":[{"within_hours":0,"charge":{"type":"percent","value":100}}]}'::jsonb, false);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t36_ns(%L, null, false, %L)', v_res, 't36-fd'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select t36_ns(%L, null, false, %L)', v_res, 't36-hk'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select t36_ns(%L, null, false, %L)', v_res, 't36-b'), 'NOT_FOUND');
  perform t_expect(format('select t36_ns(%L, null, false, %L)', gen_random_uuid(), 't36-none'), 'NOT_FOUND');
  perform t_sys();
  if (select reservation_status from reservations where id = v_res) <> 'confirmed' then raise exception 'FAIL a refused call changed the booking'; end if;
  raise notice 'PASS permissions: front desk, housekeeping, another hotel and an unknown booking get NOT_FOUND';
end $$;

-- 2. Paid in full, 100 percent no-show charge: settles like a cancellation, marked as a no-show
do $$ declare v_res uuid; v_total bigint; r jsonb; r2 jsonb; s jsonb; begin
  v_res := t36_setup('full', '{"cancellation_rules":[{"within_hours":0,"charge":{"type":"percent","value":100}}]}'::jsonb, true);
  select total_minor into v_total from reservations where id = v_res;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select t36_ns(%L, %L, false, %L)', v_res, repeat('x', 201), 't36-long'), 'POLICY_VIOLATION: note');
  r := t36_ns(v_res, '  did not call  ', false, 't36-full');
  r2 := t36_ns(v_res, '  did not call  ', false, 't36-full');
  perform t_sys();
  if r2 is distinct from r then raise exception 'FAIL repeat differs'; end if;
  if r ->> 'status' <> 'cancelled' or (r ->> 'cancellation_charge_minor')::bigint <> v_total then raise exception 'FAIL result %', r; end if;
  if (select no_show_at from reservations where id = v_res) is null then raise exception 'FAIL no_show_at not set'; end if;
  if (select cancel_reason from reservations where id = v_res) <> 'No-show: did not call' then raise exception 'FAIL reason %', (select cancel_reason from reservations where id = v_res); end if;
  if exists (select 1 from room_inventory_claims c join reservation_rooms x on x.id = c.reservation_room_id where x.reservation_id = v_res and c.status = 'active') then raise exception 'FAIL room still held'; end if;
  if (select count(*) from audit_logs where entity_id = v_res and action = 'reservation.no_show') <> 1
     or exists (select 1 from audit_logs where entity_id = v_res and action = 'reservation.cancelled') then raise exception 'FAIL audit'; end if;
  if (select total_minor from invoices where reservation_id = v_res and invoice_status <> 'void') <> v_total then raise exception 'FAIL fee invoice'; end if;
  if exists (select 1 from refunds where reservation_id = v_res) then raise exception 'FAIL refund when the charge is everything'; end if;
  s := reservation_settlement(v_res);
  if (s ->> 'settled') <> 'true' then raise exception 'FAIL settlement %', s; end if;
  -- it cannot be marked or cancelled again
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select t36_ns(%L, null, false, %L)', v_res, 't36-again'), 'INVALID_STATE: cancelled');
  perform t_expect(format('select cancel_reservation(%L, %L, %L)', v_res, 'x', 't36-cancel-after'), 'INVALID_STATE');
  raise notice 'PASS no-show: charged under the rules, fee invoice, settled, flagged and audited as a no-show, rooms released, repeat idempotent, cannot be done twice';
end $$;

-- 3. A partial charge refunds the rest; waiving the charge refunds everything and says so in the audit
do $$ declare v_a uuid; v_b uuid; v_total bigint; v_fee bigint; r jsonb; begin
  v_a := t36_setup('part', '{"cancellation_rules":[{"within_hours":0,"charge":{"type":"percent","value":40}}]}'::jsonb, true);
  select total_minor into v_total from reservations where id = v_a;
  v_fee := round(v_total * 0.40)::bigint;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := t36_ns(v_a, null, false, 't36-part');
  perform t_sys();
  if (r ->> 'cancellation_charge_minor')::bigint <> v_fee or (select amount_minor from refunds where reservation_id = v_a) <> v_total - v_fee then raise exception 'FAIL partial charge or refund'; end if;
  if (select cancel_reason from reservations where id = v_a) <> 'No-show' then raise exception 'FAIL plain reason'; end if;

  v_b := t36_setup('waive', '{"cancellation_rules":[{"within_hours":0,"charge":{"type":"percent","value":100}}]}'::jsonb, true);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := t36_ns(v_b, null, true, 't36-waive');
  perform t_sys();
  if (r ->> 'cancellation_charge_minor')::bigint <> 0 then raise exception 'FAIL waived charge %', r; end if;
  if (select amount_minor from refunds where reservation_id = v_b) <> (select total_minor from reservations where id = v_b) then raise exception 'FAIL waived refund'; end if;
  if (select metadata ->> 'charge_waived' from audit_logs where entity_id = v_b and action = 'reservation.no_show') <> 'true' then raise exception 'FAIL waiver not audited'; end if;
  raise notice 'PASS charges: a partial charge refunds the rest; a waived charge refunds everything and the audit records the waiver';
end $$;

-- 4. Not before check-in time, not for a stay in progress, not for an unpaid hold; staff cancel is not marked as a no-show
do $$ declare t date := property_today('00000000-0000-0000-0000-0000000000a2'); v_res uuid; b jsonb; begin
  perform t_sys();
  v_res := t07_res(1400, 2, 't36-future');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select t36_ns(%L, null, false, %L)', v_res, 't36-early'), 'INVALID_STATE: too early');
  perform cancel_reservation(v_res, 'staff cancel', 't36-staff');
  perform t_sys();
  if (select no_show_at from reservations where id = v_res) is not null then raise exception 'FAIL a cancel was marked as a no-show'; end if;

  v_res := t36_setup('inhouse', '{"cancellation_rules":[]}'::jsonb, false);
  update reservation_rooms set room_status = 'checked_in' where reservation_id = v_res;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select t36_ns(%L, null, false, %L)', v_res, 't36-inhouse'), 'INVALID_STATE');

  perform t_sys();
  b := create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'website', t + 1410, t + 1412,
        jsonb_build_array(jsonb_build_object('room_type_id', '00000000-0000-0000-0000-0000000000a3', 'adults', 1)), 't36-web');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select t36_ns(%L, null, false, %L)', (b ->> 'reservation_id')::uuid, 't36-hold'), 'INVALID_STATE: pending');
  raise notice 'PASS limits: too early, a stay in progress and an unpaid hold are refused; a staff cancel is not flagged as a no-show';
end $$;
