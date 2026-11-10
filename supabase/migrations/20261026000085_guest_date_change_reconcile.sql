-- 085 The guest's date change (071) now settles the money with stay_change_reconcile (070), the same code a staff date change uses,
-- instead of its own copy of the invoice replacement. The two can no longer drift on invoice numbering, lines, allocation or
-- payment state. Visible differences: the voided invoice's reason reads 'stay change' (was 'dates changed by the guest'; the
-- audit row still says by = guest). Nights, claims and the guest's own rules (not dearer, not overpaid) are unchanged.
-- Still separate: the night re-pricing and claim moving, which differ on purpose (the guest path keeps the room type and refuses
-- any price rise); folding those together is not worth the risk to the money paths.

create or replace function guest_change_dates(p_reservation_id uuid, p_arrival date, p_departure date, p_expected_total_minor bigint, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; rr reservation_rooms%rowtype; v_idem record; v_q jsonb; t record; v_keep uuid; v_claim uuid; v_room uuid; v_n integer; v_night date; v_rate record; v_levy bigint;
  v_recon jsonb; v_moves integer := 0; v_old_arr date; v_old_dep date; v_old_total bigint; v_result jsonb;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_expected_total_minor is null or p_expected_total_minor < 0 then raise exception 'POLICY_VIOLATION: total changed' using errcode = 'P0001'; end if;
  select * into v_idem from idem_begin(r.tenant_id, 'guest_change_dates', p_idempotency_key, md5(concat_ws('|', p_reservation_id, p_arrival, p_departure, p_expected_total_minor)));
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  -- the booking row first: this serialises the change against payments, cancellations, staff edits and other requests
  select * into r from reservations where id = p_reservation_id for update;
  v_q := guest_change_dates_quote(r.id, p_arrival, p_departure);
  if v_q ->> 'why_not' is not null then
    raise exception 'INVALID_STATE: dates %', v_q ->> 'why_not' using errcode = 'P0001';
  end if;
  if (v_q ->> 'new_total_minor')::bigint <> p_expected_total_minor then raise exception 'POLICY_VIOLATION: total changed' using errcode = 'P0001'; end if;
  v_old_arr := r.arrival_date; v_old_dep := r.departure_date; v_old_total := r.total_minor;

  perform 1 from room_inventory_claims
   where reservation_room_id in (select id from reservation_rooms where reservation_id = r.id) and status = 'active' and claim_type in ('stay', 'hold') order by id for update;
  perform lock_room_types(r.property_id, array(select room_type_id from reservation_rooms where reservation_id = r.id));

  select * into t from stay_dates_new_totals(r.id, p_arrival, p_departure);

  for rr in select * from reservation_rooms where reservation_id = r.id order by id loop
    select count(*) into v_n from room_inventory_claims where reservation_room_id = rr.id and status = 'active' and claim_type in ('stay', 'hold');
    if v_n <> 1 then raise exception 'INVALID_STATE: split stay' using errcode = 'P0001'; end if;
    select room_id into v_keep from room_inventory_claims where reservation_room_id = rr.id and status = 'active' and claim_type in ('stay', 'hold');
    update room_inventory_claims set status = 'released' where reservation_room_id = rr.id and status = 'active' and claim_type in ('stay', 'hold');
    v_claim := null;
    begin
      v_claim := claim_room(r.property_id, null, v_keep, p_arrival, p_departure, 'stay', rr.id, null, null, null);
    exception when sqlstate 'P0001' then
      if sqlerrm <> 'ROOM_UNAVAILABLE' then raise; end if;
    end;
    if v_claim is null then
      v_claim := claim_room(r.property_id, rr.room_type_id, null, p_arrival, p_departure, 'stay', rr.id, null, null, null);   -- ROOM_UNAVAILABLE ends the change, nothing is kept
    end if;
    select room_id into v_room from room_inventory_claims where id = v_claim;
    if v_room <> v_keep then v_moves := v_moves + 1; end if;

    select coalesce(sum(stay_tax_minor), 0) into v_levy from reservation_nights where reservation_room_id = rr.id;
    delete from reservation_nights where reservation_room_id = rr.id and (night_date < p_arrival or night_date >= p_departure);
    for v_night in select generate_series(p_arrival, p_departure - 1, interval '1 day')::date loop
      if not exists (select 1 from reservation_nights where reservation_room_id = rr.id and night_date = v_night) then
        select * into v_rate from resolve_rate(r.property_id, rr.room_type_id, rr.rate_plan_id, v_night);
        insert into reservation_nights (tenant_id, reservation_room_id, night_date, rate_minor, tax_minor, rate_source)
        values (r.tenant_id, rr.id, v_night, v_rate.amount_minor, calc_night_tax(r.property_id, v_night, v_rate.amount_minor), v_rate.source);
      end if;
    end loop;
    update reservation_nights set tax_minor = tax_minor - stay_tax_minor, stay_tax_minor = 0 where reservation_room_id = rr.id and stay_tax_minor > 0;
    if v_levy > 0 then
      update reservation_nights set tax_minor = tax_minor + v_levy, stay_tax_minor = v_levy where reservation_room_id = rr.id and night_date = p_arrival;
    end if;
  end loop;

  update reservations set arrival_date = p_arrival, departure_date = p_departure, subtotal_minor = t.subtotal, tax_minor = t.tax, total_minor = t.total where id = r.id;

  -- the money follows the same code as a staff date change (070): a live invoice is voided and replaced for the new nights,
  -- the money already paid is allocated to it, and the payment state is worked out again. The guest rules (not dearer, not
  -- overpaid) mean no surplus can arise here, so nothing is flagged.
  v_recon := stay_change_reconcile(r.id, null);

  -- the guest's own open dates request is answered by doing it
  update guest_change_requests set status = 'done', resolution_note = 'The guest changed the dates themselves.', resolved_at = now()
   where reservation_id = r.id and status = 'open' and kind = 'dates';

  select * into r from reservations where id = r.id;
  perform write_audit(r.tenant_id, r.property_id, null, 'reservation.stay_changed', 'reservation', r.id, p_idempotency_key,
                      jsonb_build_object('by', 'guest', 'dates_changed', true, 'from_arrival', v_old_arr, 'from_departure', v_old_dep, 'from_total_minor', v_old_total,
                                         'to_arrival', r.arrival_date, 'to_departure', r.departure_date, 'to_total_minor', r.total_minor,
                                         'rooms_moved', v_moves, 'invoice_replaced', (v_recon ->> 'invoice_replaced')::boolean));
  perform enqueue_notification(r.property_id, 'guest_stay_changed', 'booking', 'info', 'Guest changed their dates: ' || r.booking_reference,
    'Now ' || r.arrival_date || ' to ' || r.departure_date || ' (was ' || v_old_arr || ' to ' || v_old_dep || ').',
    '/app/reservations/' || r.id, 'reservation.view', 'reservation', r.id, 'gdates:' || p_idempotency_key);
  v_result := jsonb_build_object('reservation_id', r.id, 'arrival_date', r.arrival_date, 'departure_date', r.departure_date,
                                 'total_minor', r.total_minor, 'rooms_moved', v_moves);
  perform idem_finish(r.tenant_id, 'guest_change_dates', p_idempotency_key, v_result);
  return v_result;
end $$;
