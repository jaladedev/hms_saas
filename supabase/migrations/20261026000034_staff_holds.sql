-- 034 Staff holds: a room held for a guest who has not paid yet, confirmed when staff record the payment.
--
-- Online bookings already work this way (009, 011): a pending reservation holds its rooms for the hotel's hold time and
-- becomes confirmed when the guest's payment arrives. This gives staff the same thing for phone and walk-in guests
-- ("I'll come by and pay this afternoon"), reusing the same rules instead of inventing new ones:
--   * create_staff_hold(...) books like create_reservation (same checks, same prices, same rooms) but leaves the booking
--     PENDING with a timed HOLD on each room, for policy.hold_minutes (default 20), instead of a confirmed stay.
--     It is create_reservation plus a conversion in the same transaction, so nothing about pricing or claims is repeated.
--   * record_manual_payment now also confirms a pending booking once the money held reaches the required amount (the
--     same rule online payments use: policy_snapshot.online_payment, a deposit percent, else the full total). The holds
--     become stays in place, so the room never changes hands. Below the required amount the payment is recorded and the
--     booking stays pending; the hold is NOT extended by paying.
--   * A payment is refused (INVALID_STATE: hold lapsed) when the hold has run out: staff are taking real money, and the
--     room may already be gone. Rebook instead. Before this migration a desk payment on a pending booking was recorded
--     but never confirmed it; it now does, for online bookings too (the guest's confirmation email follows the same
--     trigger as for a provider payment).
--   * expire_lapsed_holds sweeps every pending booking, not only website ones, so a lapsed staff hold ends as 'expired'
--     like an online one. The room itself frees on its own when the hold time passes (claim_room releases lapsed holds).
--
-- Nothing else changes: money held, invoices, refunds and settlement see an ordinary pending booking.
--
-- Errors: as create_reservation, plus FORBIDDEN (no permission, or called without a signed-in person), POLICY_VIOLATION:
-- source (a hold cannot be an online booking), INVALID_STATE: hold lapsed (record_manual_payment).

-- What a pending booking must have paid before it is confirmed: the policy's deposit percent of the total, else all of it.
-- The same arithmetic as create_payment_attempt (011), so staff and online guests face the same requirement.
create function pending_required_minor(p_reservation uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select case when coalesce(r.policy_snapshot -> 'online_payment' ->> 'mode', 'full') = 'deposit_percent'
              then least(r.total_minor, ceil(r.total_minor * coalesce((r.policy_snapshot -> 'online_payment' ->> 'value')::numeric, 100) / 100)::bigint)
              else r.total_minor end
    from reservations r where r.id = p_reservation
$$;
revoke all on function pending_required_minor(uuid) from public, anon, authenticated;

create function create_staff_hold(
  p_property_id      uuid,
  p_primary_guest_id uuid,
  p_source           text,
  p_arrival          date,
  p_departure        date,
  p_rooms            jsonb,
  p_idempotency_key  text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid(); v_tenant uuid; v_idem record; v_hash text; v_res jsonb; v_id uuid; r reservations%rowtype;
  v_minutes integer; v_expires timestamptz; v_result jsonb;
begin
  select tenant_id into v_tenant from properties where id = p_property_id and status = 'active';
  if v_tenant is null then raise exception 'NOT_FOUND: property' using errcode = 'P0001'; end if;
  if v_actor is null or not has_permission(p_property_id, 'reservation.create') then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if p_source is null or p_source not in ('walk_in', 'phone', 'staff_entry', 'partner') then
    raise exception 'POLICY_VIOLATION: source' using errcode = 'P0001';
  end if;

  v_hash := md5(concat_ws('|', p_property_id, p_primary_guest_id, p_source, p_arrival, p_departure, p_rooms::text));
  select * into v_idem from idem_begin(v_tenant, 'create_staff_hold', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  -- an ordinary staff booking first (every check, price and claim of create_reservation), then turned into a hold
  v_res := create_reservation(p_property_id, p_primary_guest_id, p_source, p_arrival, p_departure, p_rooms, 'hold:' || p_idempotency_key);
  v_id := (v_res ->> 'reservation_id')::uuid;
  select * into r from reservations where id = v_id for update;
  v_minutes := greatest(coalesce((r.policy_snapshot ->> 'hold_minutes')::integer, 20), 1);
  v_expires := now() + make_interval(mins => v_minutes);

  update room_inventory_claims set claim_type = 'hold', hold_expires_at = v_expires
   where status = 'active' and claim_type = 'stay'
     and reservation_room_id in (select id from reservation_rooms where reservation_id = v_id);
  update reservations set reservation_status = 'pending' where id = v_id;

  v_result := v_res || jsonb_build_object('status', 'pending', 'hold_expires_at', v_expires, 'hold_minutes', v_minutes,
                                          'required_minor', pending_required_minor(v_id));
  perform idem_finish(v_tenant, 'create_staff_hold', p_idempotency_key, v_result);
  perform write_audit(v_tenant, p_property_id, v_actor, 'reservation.hold_created', 'reservation', v_id, p_idempotency_key,
                      jsonb_build_object('booking_reference', r.booking_reference, 'source', p_source, 'hold_minutes', v_minutes,
                                         'total_minor', r.total_minor));
  return v_result;
end $$;

revoke all on function create_staff_hold(uuid, uuid, text, date, date, jsonb, text) from public, anon;
grant execute on function create_staff_hold(uuid, uuid, text, date, date, jsonb, text) to authenticated;

-- record_manual_payment (010) with the pending-booking rules added; everything else is as it was.
create or replace function record_manual_payment(
  p_reservation_id uuid, p_amount_minor bigint, p_method text, p_reference text, p_note text,
  p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; v_actor uuid; v_idem record; v_hash text; v_paid bigint; v_cap bigint; v_pay uuid := gen_random_uuid();
  v_ref text; v_inv uuid; v_alloc bigint := 0; v_out bigint; v_result jsonb; v_status text; v_confirmed boolean := false;
begin
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(r.property_id, 'payment.record', 'NOT_FOUND');
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'POLICY_VIOLATION: amount must be positive' using errcode = 'P0001';
  end if;
  if p_method is null or p_method not in ('cash', 'bank_transfer', 'pos', 'other') then
    raise exception 'POLICY_VIOLATION: payment method' using errcode = 'P0001';
  end if;

  v_hash := md5(concat_ws('|', p_reservation_id, p_amount_minor, p_method, coalesce(p_reference, ''), coalesce(p_note, '')));
  select * into v_idem from idem_begin(r.tenant_id, 'record_manual_payment', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  select * into r from reservations where id = p_reservation_id for update;
  v_paid := reservation_money_held(r.id);
  v_cap := r.total_minor;
  if r.reservation_status = 'cancelled' and r.cancellation_charge_minor > v_paid then
    v_cap := r.cancellation_charge_minor;      -- an unpaid cancellation charge can still be collected
  elsif r.reservation_status in ('cancelled', 'expired', 'no_show') then
    raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001';
  end if;
  -- a pending booking is only a hold: if the hold has run out the room may be gone, so no money is taken for it
  if r.reservation_status = 'pending' and exists (
       select 1 from reservation_rooms rr
        where rr.reservation_id = r.id and rr.room_status = 'booked'
          and not exists (select 1 from room_inventory_claims c
                           where c.reservation_room_id = rr.id and c.status = 'active'
                             and (c.claim_type = 'stay' or (c.claim_type = 'hold' and c.hold_expires_at > now())))) then
    raise exception 'INVALID_STATE: hold lapsed' using errcode = 'P0001';
  end if;
  if v_paid + p_amount_minor > v_cap then
    raise exception 'POLICY_VIOLATION: OVERPAYMENT outstanding %', v_cap - v_paid using errcode = 'P0001';
  end if;

  loop
    v_ref := 'PAY-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    exit when not exists (select 1 from payments where tenant_id = r.tenant_id and internal_reference = v_ref);
  end loop;
  insert into payments (id, tenant_id, property_id, reservation_id, payment_method, provider_reference,
                        internal_reference, amount_minor, currency, note, recorded_by)
  values (v_pay, r.tenant_id, r.property_id, r.id, p_method, nullif(trim(p_reference), ''), v_ref,
          p_amount_minor, r.currency, nullif(trim(p_note), ''), v_actor);

  select id into v_inv from invoices where reservation_id = r.id and invoice_status <> 'void';
  if v_inv is not null then v_alloc := allocate_payments_to_invoice(v_inv); end if;

  -- enough money for a pending booking: the holds become stays in place and the booking is confirmed
  if r.reservation_status = 'pending' and reservation_money_held(r.id) >= pending_required_minor(r.id) then
    update room_inventory_claims set claim_type = 'stay', hold_expires_at = null
     where claim_type = 'hold' and status = 'active'
       and reservation_room_id in (select id from reservation_rooms where reservation_id = r.id);
    update reservations set reservation_status = 'confirmed', attention_reason = null where id = r.id;
    v_confirmed := true;
  end if;

  perform refresh_money_state(r.id);       -- invoice and reservation status, and the cancellation-charge flag (012, 016)
  select payment_status into v_status from reservations where id = r.id;

  v_result := jsonb_build_object('payment_id', v_pay, 'internal_reference', v_ref, 'amount_minor', p_amount_minor,
                                 'invoice_id', v_inv, 'allocated_minor', v_alloc,
                                 'payment_status', v_status, 'outstanding_minor', v_cap - v_paid - p_amount_minor,
                                 'reservation_status', (select reservation_status from reservations where id = r.id),
                                 'confirmed', v_confirmed);
  perform idem_finish(r.tenant_id, 'record_manual_payment', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'payment.recorded', 'payment', v_pay, p_idempotency_key,
                      jsonb_build_object('reservation_id', r.id, 'amount_minor', p_amount_minor, 'method', p_method,
                                         'internal_reference', v_ref, 'confirmed_booking', v_confirmed));
  return v_result;
end $$;

-- expire_lapsed_holds (011) without the "website only" filter: any pending booking whose holds have all run out ends as expired.
create or replace function expire_lapsed_holds(p_limit integer default 200) returns integer
language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  for r in
    select res.id, res.tenant_id, res.property_id from reservations res
     where res.reservation_status = 'pending'
       and not exists (select 1 from reservation_rooms rr join room_inventory_claims c on c.reservation_room_id = rr.id
                        where rr.reservation_id = res.id and c.status = 'active'
                          and (c.claim_type = 'stay' or (c.claim_type = 'hold' and c.hold_expires_at > now())))
       and not exists (select 1 from payment_attempts pa
                        where pa.reservation_id = res.id and pa.status = 'initiated'
                          and pa.created_at > now() - interval '30 minutes')
     order by res.created_at
     limit p_limit
     for update of res skip locked
  loop
    update room_inventory_claims set status = 'expired'
     where claim_type = 'hold' and status = 'active'
       and reservation_room_id in (select id from reservation_rooms where reservation_id = r.id);
    update reservations set reservation_status = 'expired' where id = r.id;
    perform write_audit(r.tenant_id, r.property_id, null, 'reservation.expired', 'reservation', r.id, null, '{}'::jsonb);
    n := n + 1;
  end loop;
  return n;
end $$;
