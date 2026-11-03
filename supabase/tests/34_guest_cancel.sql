-- Guests cancelling their own booking (migration 035): guest_cancel_preview, guest_cancel_reservation, and the shared
-- cancel core. Reuses t_as / t_sys / t_expect / t_book (05) and t07_res (07). Users: aa01 owner A.
-- Offsets 1200 to 1300 (earlier files use up to about 1100). Cancellation rules are set per booking.
\set ON_ERROR_STOP on

create function t34_rule(p_type text, p_value numeric) returns jsonb language sql as $$
  select jsonb_build_object('cancellation_rules', jsonb_build_array(
    jsonb_build_object('within_hours', 100000, 'charge', jsonb_build_object('type', p_type, 'value', p_value))))
$$;
-- A confirmed staff booking of 2 nights with the given rule; optionally paid in full
create function t34_setup(p_off integer, p_key text, p_rule jsonb, p_pay boolean) returns uuid language plpgsql as $$
declare v_res uuid; v_total bigint;
begin
  perform t_sys();
  v_res := t07_res(p_off, 2, 't34-book-' || p_key);
  update reservations set policy_snapshot = policy_snapshot || p_rule where id = v_res;
  if p_pay then
    select total_minor into v_total from reservations where id = v_res;
    perform record_manual_payment(v_res, v_total, 'cash', 'r-' || p_key, null, 't34-pay-' || p_key);
  end if;
  return v_res;
end $$;
create function t34_audits(p_res uuid) returns bigint language sql stable as $$
  select count(*) from audit_logs where action = 'reservation.cancelled' and entity_id = p_res
$$;

-- 1. Only the server (service role) may use the guest functions
do $$ declare v_res uuid; begin
  v_res := t34_setup(1200, 'perm', t34_rule('percent', 30), false);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin perform guest_cancel_preview(v_res); raise exception 'FAIL a signed-in user ran the preview';
  exception when insufficient_privilege then null; end;
  begin perform guest_cancel_reservation(v_res, 0, 't34-perm'); raise exception 'FAIL a signed-in user cancelled as a guest';
  exception when insufficient_privilege then null; end;
  perform t_sys();
  perform t_expect(format('select guest_cancel_preview(%L)', gen_random_uuid()), 'NOT_FOUND');
  perform t_expect(format('select guest_cancel_reservation(%L, 0, %L)', gen_random_uuid(), 't34-none'), 'NOT_FOUND');
  if (select reservation_status from reservations where id = v_res) <> 'confirmed' then raise exception 'FAIL booking changed'; end if;
  raise notice 'PASS permissions: only the service role may preview or cancel; an unknown booking is NOT_FOUND';
end $$;

-- 2. Paid in full, 30 percent charge: the preview, a wrong amount refused, then the real cancel with settlement
do $$ declare v_res uuid; v_total bigint; v_fee bigint; p jsonb; r jsonb; r2 jsonb; f refunds%rowtype; v_fee_inv uuid; begin
  v_res := t34_setup(1210, 'full', t34_rule('percent', 30), true);
  select total_minor into v_total from reservations where id = v_res;
  v_fee := round(v_total * 0.30)::bigint;
  p := guest_cancel_preview(v_res);
  if not (p ->> 'allowed')::boolean or (p ->> 'charge_minor')::bigint <> v_fee or (p ->> 'held_minor')::bigint <> v_total
     or (p ->> 'refund_minor')::bigint <> v_total - v_fee or (p ->> 'still_owed_minor')::bigint <> 0 then raise exception 'FAIL preview %', p; end if;

  perform t_expect(format('select guest_cancel_reservation(%L, %s, %L)', v_res, v_fee + 1, 't34-wrong'), 'POLICY_VIOLATION: charge changed');
  perform t_expect(format('select guest_cancel_reservation(%L, %s, %L)', v_res, -1, 't34-neg'), 'POLICY_VIOLATION: charge changed');
  if (select reservation_status from reservations where id = v_res) <> 'confirmed' or t34_audits(v_res) <> 0
     or exists (select 1 from room_inventory_claims c join reservation_rooms x on x.id = c.reservation_room_id where x.reservation_id = v_res and c.status <> 'active')
     then raise exception 'FAIL a refused cancel changed something'; end if;

  r := guest_cancel_reservation(v_res, v_fee, 't34-full');
  if r ->> 'status' <> 'cancelled' or (r ->> 'cancellation_charge_minor')::bigint <> v_fee then raise exception 'FAIL cancel %', r; end if;
  r2 := guest_cancel_reservation(v_res, v_fee, 't34-full');
  if r2 is distinct from r then raise exception 'FAIL repeat differs'; end if;
  if t34_audits(v_res) <> 1 then raise exception 'FAIL audited % times', t34_audits(v_res); end if;
  if (select metadata ->> 'by' from audit_logs where action = 'reservation.cancelled' and entity_id = v_res) <> 'guest' then raise exception 'FAIL audit does not say the guest did it'; end if;
  if (select cancel_reason from reservations where id = v_res) <> 'Cancelled by the guest' then raise exception 'FAIL reason'; end if;
  if exists (select 1 from room_inventory_claims c join reservation_rooms x on x.id = c.reservation_room_id where x.reservation_id = v_res and c.status = 'active') then raise exception 'FAIL rooms still held'; end if;

  select id into v_fee_inv from invoices where reservation_id = v_res and invoice_status <> 'void';
  if v_fee_inv is null or (select total_minor from invoices where id = v_fee_inv) <> v_fee then raise exception 'FAIL fee invoice'; end if;
  select * into f from refunds where reservation_id = v_res;
  if f.amount_minor <> v_total - v_fee or f.refund_status <> 'requested' or f.requested_by is not null then raise exception 'FAIL refund %', f; end if;
  if (select count(*) from refunds where reservation_id = v_res) <> 1 then raise exception 'FAIL refund count'; end if;

  -- cancelled now: nothing more to cancel, and the preview says why
  p := guest_cancel_preview(v_res);
  if (p ->> 'allowed')::boolean or p ->> 'why_not' <> 'status' then raise exception 'FAIL preview after cancel %', p; end if;
  perform t_expect(format('select guest_cancel_reservation(%L, %s, %L)', v_res, v_fee, 't34-full-again'), 'INVALID_STATE: cancelled');
  raise notice 'PASS paid booking: preview, a wrong agreed charge refused with nothing changed, cancel settles (fee invoice, one refund request), repeat is idempotent, audited as the guest';
end $$;

-- 3. Unpaid with a charge: the guest still owes it; free cancellation of a paid booking refunds everything
do $$ declare v_res uuid; v_total bigint; v_fee bigint; p jsonb; v_res2 uuid; begin
  v_res := t34_setup(1220, 'unpaid', t34_rule('percent', 50), false);
  select total_minor into v_total from reservations where id = v_res;
  v_fee := round(v_total * 0.5)::bigint;
  p := guest_cancel_preview(v_res);
  if (p ->> 'refund_minor')::bigint <> 0 or (p ->> 'still_owed_minor')::bigint <> v_fee then raise exception 'FAIL unpaid preview %', p; end if;
  perform guest_cancel_reservation(v_res, v_fee, 't34-unpaid');
  if (select count(*) from refunds where reservation_id = v_res) <> 0 then raise exception 'FAIL refund for an unpaid booking'; end if;
  if (reservation_settlement(v_res) ->> 'charge_due_minor')::bigint <> v_fee then raise exception 'FAIL charge due'; end if;

  v_res2 := t34_setup(1230, 'free', '{"cancellation_rules":[]}'::jsonb, true);
  select total_minor into v_total from reservations where id = v_res2;
  p := guest_cancel_preview(v_res2);
  if (p ->> 'charge_minor')::bigint <> 0 or (p ->> 'refund_minor')::bigint <> v_total then raise exception 'FAIL free preview %', p; end if;
  perform guest_cancel_reservation(v_res2, 0, 't34-free');
  if (select amount_minor from refunds where reservation_id = v_res2) <> v_total then raise exception 'FAIL full refund'; end if;
  if exists (select 1 from invoices where reservation_id = v_res2 and invoice_status <> 'void') then raise exception 'FAIL fee invoice on a free cancel'; end if;
  raise notice 'PASS charges: an unpaid booking owes its charge and gets no refund; a free cancel refunds everything with no fee invoice';
end $$;

-- 4. What a guest may not cancel: a hold, a started stay, after check-in time on the arrival day
do $$ declare t date := property_today('00000000-0000-0000-0000-0000000000a2'); v_res uuid; b jsonb; p jsonb; begin
  perform t_sys();
  b := create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'website', t + 1240, t + 1242,
        jsonb_build_array(jsonb_build_object('room_type_id', '00000000-0000-0000-0000-0000000000a3', 'adults', 1)), 't34-web');
  v_res := (b ->> 'reservation_id')::uuid;
  p := guest_cancel_preview(v_res);
  if (p ->> 'allowed')::boolean or p ->> 'why_not' <> 'status' then raise exception 'FAIL hold preview %', p; end if;
  perform t_expect(format('select guest_cancel_reservation(%L, 0, %L)', v_res, 't34-hold'), 'INVALID_STATE: pending');

  v_res := t34_setup(1250, 'started', '{"cancellation_rules":[]}'::jsonb, false);
  update reservation_rooms set room_status = 'checked_in' where reservation_id = v_res;
  p := guest_cancel_preview(v_res);
  if (p ->> 'allowed')::boolean or p ->> 'why_not' <> 'started' then raise exception 'FAIL started preview %', p; end if;
  perform t_expect(format('select guest_cancel_reservation(%L, 0, %L)', v_res, 't34-started'), 'INVALID_STATE');

  -- arriving today with a check-in time already past (midnight): the stay is under way as far as the rules go
  v_res := t34_setup(0, 'late', '{"cancellation_rules":[],"check_in_time":"00:00:00"}'::jsonb, false);
  p := guest_cancel_preview(v_res);
  if (p ->> 'allowed')::boolean or p ->> 'why_not' <> 'too_late' then raise exception 'FAIL late preview %', p; end if;
  perform t_expect(format('select guest_cancel_reservation(%L, 0, %L)', v_res, 't34-late'), 'INVALID_STATE: too late');
  if (select reservation_status from reservations where id = v_res) <> 'confirmed' then raise exception 'FAIL a refused cancel changed the booking'; end if;
  raise notice 'PASS limits: an unpaid hold, a started stay and a late cancel are refused and say why';
end $$;

-- 5. The key reused for a different booking is refused; staff cancel is unchanged
do $$ declare v_a uuid; v_b uuid; r jsonb; begin
  v_a := t34_setup(1270, 'ka', '{"cancellation_rules":[]}'::jsonb, false);
  v_b := t34_setup(1280, 'kb', '{"cancellation_rules":[]}'::jsonb, false);
  perform guest_cancel_reservation(v_a, 0, 't34-key');
  perform t_expect(format('select guest_cancel_reservation(%L, 0, %L)', v_b, 't34-key'), 'IDEMPOTENCY_MISMATCH');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := cancel_reservation(v_b, 'staff cancel', 't34-staff');
  perform t_sys();
  if r ->> 'status' <> 'cancelled' or t34_audits(v_b) <> 1 or (select metadata ? 'by' from audit_logs where action = 'reservation.cancelled' and entity_id = v_b) then raise exception 'FAIL staff cancel %', r; end if;
  raise notice 'PASS key reuse across bookings is refused; staff cancel still works and is not marked as the guest';
end $$;
