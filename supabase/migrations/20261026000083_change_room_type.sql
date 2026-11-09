-- 083 Move a guest to a different room type (upgrade or downgrade), re-pricing the nights still to come.
--
-- transfer_room (008, 078) moves a booking between rooms of the SAME type, so the price never changes. This is the move to
-- another type. change_room_type(reservation_room, new type, effective date, reason, key):
--   * who: room.assign (the permission of a room move), as the signed-in person; NOT_FOUND to anyone else.
--   * which bookings: a confirmed booking, or a guest in the house (a room still 'booked' or 'checked_in'). Not a booking with a
--     discount (POLICY_VIOLATION: discount, as for a date change), and not one with a card payment in flight.
--   * effective date: the first night in the new type. At least today and at least the arrival, before the departure.
--     Nights before it are left alone and keep their price; nights from it on are re-priced at the NEW type's rate for that
--     night (the booking's own rate plan, then the default plan, then the type's base rate: resolve_rate) and its tax.
--     The fixed levy per stay (057) stays where it is, at the same amount.
--   * the claim: the old claim ends the day before the effective date (or is released if the stay starts that day) and the
--     first free room of the new type is claimed from the effective date to the end of the stay. No free room: ROOM_UNAVAILABLE
--     and nothing changes. The room left behind is marked dirty if the guest had checked in.
--   * the booking's room type becomes the new type, and the guest numbers must fit it (CAPACITY_EXCEEDED).
--   * the money, exactly as for a date change (070): a live invoice is voided and replaced, the payments are carried over, a
--     surplus (a downgrade of a paid booking) is flagged stay_change_refund_due for a person to refund, a shortfall (an upgrade)
--     shows as a balance due. Nothing is refunded or charged automatically.
--   * idempotent by key; audited as 'reservation.room_type_changed' with the old and new type, totals and surplus.

create function change_room_type(p_reservation_room_id uuid, p_new_room_type uuid, p_effective date, p_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  rr reservation_rooms%rowtype; r reservations%rowtype; o room_inventory_claims%rowtype; v_new_type room_types%rowtype;
  v_actor uuid; v_idem record; v_hash text; v_today date; v_reason text := trim(coalesce(p_reason, ''));
  v_old_type uuid; v_old_total bigint; v_old_room uuid; v_claim uuid; v_new_room uuid; v_end date;
  v_night record; v_rate record; v_sub bigint; v_tax bigint; v_recon jsonb; v_result jsonb; v_repriced integer := 0;
begin
  select * into rr from reservation_rooms where id = p_reservation_room_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(rr.property_id, 'room.assign', 'NOT_FOUND');
  if length(v_reason) = 0 or length(v_reason) > 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;
  if p_effective is null then raise exception 'POLICY_VIOLATION: effective date' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', p_reservation_room_id, p_new_room_type, p_effective, v_reason));
  select * into v_idem from idem_begin(rr.tenant_id, 'change_room_type', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  -- the booking row first: it serialises this against edits, cancellations, payments and invoices on the booking
  select * into r from reservations where id = rr.reservation_id for update;
  select * into rr from reservation_rooms where id = p_reservation_room_id;
  if r.reservation_status not in ('confirmed', 'checked_in') then
    raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001';
  end if;
  if rr.room_status not in ('booked', 'checked_in') then raise exception 'INVALID_STATE: room %', rr.room_status using errcode = 'P0001'; end if;
  if exists (select 1 from payment_attempts where reservation_id = r.id and status = 'initiated') then
    raise exception 'INVALID_STATE: payment started' using errcode = 'P0001';
  end if;
  if r.discount_minor > 0 then raise exception 'POLICY_VIOLATION: discount' using errcode = 'P0001'; end if;

  select * into v_new_type from room_types where id = p_new_room_type and property_id = rr.property_id;
  if not found or v_new_type.status <> 'active' then raise exception 'NOT_FOUND: room type' using errcode = 'P0001'; end if;
  if v_new_type.id = rr.room_type_id then raise exception 'POLICY_VIOLATION: same room type' using errcode = 'P0001'; end if;
  if rr.adults > v_new_type.max_adults or rr.children > v_new_type.max_children or rr.adults + rr.children > v_new_type.max_occupancy then
    raise exception 'CAPACITY_EXCEEDED' using errcode = 'P0001';
  end if;

  v_today := property_today(rr.property_id);
  if p_effective < greatest(v_today, r.arrival_date) or p_effective >= r.departure_date then
    raise exception 'POLICY_VIOLATION: effective date' using errcode = 'P0001';
  end if;
  v_old_type := rr.room_type_id; v_old_total := r.total_minor;

  -- the claim rows first, then the room types (the order transfer_room and the stay edit use)
  select * into o from room_inventory_claims
   where reservation_room_id = rr.id and status = 'active' and claim_type in ('stay', 'hold')
     and start_date <= p_effective and end_date > p_effective for update;
  if not found then raise exception 'POLICY_VIOLATION: effective date' using errcode = 'P0001'; end if;
  v_old_room := o.room_id; v_end := o.end_date;
  perform lock_room_types(rr.property_id, array[v_old_type, v_new_type.id]);

  if o.start_date = p_effective then
    update room_inventory_claims set status = 'released' where id = o.id;
  else
    update room_inventory_claims set end_date = p_effective where id = o.id;
  end if;
  -- no free room of the new type: claim_room raises ROOM_UNAVAILABLE and the whole call, claim release included, rolls back
  v_claim := claim_room(rr.property_id, v_new_type.id, null, p_effective, v_end, o.claim_type, rr.id, o.hold_expires_at, null, o.created_by);
  select room_id into v_new_room from room_inventory_claims where id = v_claim;
  if rr.room_status = 'checked_in' then update rooms set housekeeping_status = 'dirty' where id = v_old_room; end if;

  update reservation_rooms set room_type_id = v_new_type.id where id = rr.id;

  -- nights from the effective date on take the new type's price and tax; the stay levy keeps its place and its amount
  for v_night in select id, night_date, stay_tax_minor from reservation_nights where reservation_room_id = rr.id and night_date >= p_effective order by night_date loop
    select * into v_rate from resolve_rate(rr.property_id, v_new_type.id, rr.rate_plan_id, v_night.night_date);
    update reservation_nights
       set rate_minor = v_rate.amount_minor, rate_source = v_rate.source,
           tax_minor = calc_night_tax(rr.property_id, v_night.night_date, v_rate.amount_minor) + v_night.stay_tax_minor
     where id = v_night.id;
    v_repriced := v_repriced + 1;
  end loop;

  select coalesce(sum(n.rate_minor), 0), coalesce(sum(n.tax_minor), 0) into v_sub, v_tax
    from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = r.id;
  update reservations set subtotal_minor = v_sub, tax_minor = v_tax, total_minor = v_sub + v_tax where id = r.id;
  v_recon := stay_change_reconcile(r.id, v_actor);

  v_result := jsonb_build_object('reservation_room_id', rr.id, 'from_room_id', v_old_room, 'to_room_id', v_new_room, 'from_room_type_id', v_old_type,
                                 'to_room_type_id', v_new_type.id, 'effective', p_effective, 'nights_repriced', v_repriced,
                                 'old_total_minor', v_old_total, 'new_total_minor', v_sub + v_tax,
                                 'invoice_replaced', coalesce((v_recon ->> 'invoice_replaced')::boolean, false),
                                 'surplus_minor', coalesce((v_recon ->> 'surplus_minor')::bigint, 0));
  perform idem_finish(rr.tenant_id, 'change_room_type', p_idempotency_key, v_result);
  perform write_audit(rr.tenant_id, rr.property_id, v_actor, 'reservation.room_type_changed', 'reservation', r.id, p_idempotency_key,
                      v_result || jsonb_build_object('reason', v_reason, 'held_minor', coalesce((v_recon ->> 'held_minor')::bigint, 0)));
  return v_result;
end $$;
revoke all on function change_room_type(uuid, uuid, date, text, text) from public, anon;
grant execute on function change_room_type(uuid, uuid, date, text, text) to authenticated;
