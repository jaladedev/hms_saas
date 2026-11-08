-- 070 A date change on a booking that has money on it (guest self-service part 2, step 1; TODO: "extend update_reservation_stay").
--
-- Until now update_reservation_stay (033) refused any booking with a payment or a live invoice, because a changed total
-- would break the money code (one invoice equal to the total; payments capped at it). The hotel's answer was "cancel and
-- book again". Now the edit goes through and the money code is brought up to date in the same transaction, the way early
-- check-out (060) already does it for a shorter stay:
--   1. nights, claims and totals change exactly as in 033/057 (nights already sold keep their price; the per-room levy moves
--      with the stay);
--   2. a live invoice is voided (reason 'stay change') and replaced by a new numbered one for the new nights and total, with
--      the money already held allocated to it. No live invoice, none issued;
--   3. if the guest has paid MORE than the new total, the booking is flagged attention_reason = 'stay_change_refund_due' (and
--      the notice goes out). NO refund is created: a person requests it from the booking's payments, so the second-person
--      approval still applies. The flag clears itself, in refresh_money_state, once refunds covering the surplus are in
--      progress or paid. If the guest has paid LESS than the new total, the booking simply shows a balance due: the payment
--      status is worked out again (a 'paid' booking becomes 'partially paid').
--   4. the answer and the audit row 'reservation.stay_changed' say whether the invoice was replaced and how much surplus there is.
-- Still refused, on purpose, and unchanged: a provider payment in flight ('INVALID_STATE: payment started'), and a booking
-- with a discount ('POLICY_VIOLATION: discount'): re-pricing a percentage or fixed discount on a changed stay is its own rule.
-- Folio (extras) charges are separate invoices and are not touched. Guest-side change (preview and confirm from the guest's
-- booking link) is the next step and builds on this function.

create function stay_change_reconcile(p_reservation uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; v_inv uuid; v_new uuid; v_year integer; v_n integer; v_number text; v_prop record;
  v_held bigint; v_live bigint; v_surplus bigint := 0;
begin
  select * into r from reservations where id = p_reservation for update;

  select id into v_inv from invoices where reservation_id = r.id and invoice_status <> 'void';
  if v_inv is not null then
    update invoices set invoice_status = 'void', void_reason = 'stay change', voided_at = now(), voided_by = p_actor where id = v_inv;
    select code, check_in_time, timezone into v_prop from properties where id = r.property_id;
    v_year := extract(year from property_today(r.property_id))::integer;
    insert into invoice_sequences (property_id, year, last_number) values (r.property_id, v_year, 1)
    on conflict (property_id, year) do update set last_number = invoice_sequences.last_number + 1
    returning last_number into v_n;
    v_number := 'INV-' || v_prop.code || '-' || v_year || '-' || lpad(v_n::text, 6, '0');
    v_new := gen_random_uuid();
    insert into invoices (id, tenant_id, property_id, reservation_id, invoice_number, currency, subtotal_minor, tax_minor, discount_minor, total_minor, due_at, created_by)
    values (v_new, r.tenant_id, r.property_id, r.id, v_number, r.currency, r.subtotal_minor, r.tax_minor, 0, r.total_minor,
            (r.arrival_date + v_prop.check_in_time) at time zone v_prop.timezone, p_actor);
    insert into invoice_lines (tenant_id, invoice_id, description, quantity, unit_amount_minor, tax_amount_minor, line_total_minor, service_date)
    select r.tenant_id, v_new, rt.name || ', night of ' || n.night_date, 1, n.rate_minor, n.tax_minor, n.rate_minor + n.tax_minor, n.night_date
      from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id join room_types rt on rt.id = x.room_type_id
     where x.reservation_id = r.id order by n.night_date, rt.name, x.id;
    perform allocate_payments_to_invoice(v_new);
  end if;

  v_held := reservation_money_held(r.id);
  select coalesce(sum(amount_minor), 0) into v_live from refunds
   where reservation_id = r.id and refund_status in ('requested', 'approved', 'processing');
  v_surplus := greatest(v_held - v_live - r.total_minor, 0);
  if v_surplus > 0 and r.attention_reason is null then
    update reservations set attention_reason = 'stay_change_refund_due' where id = r.id;
  end if;
  perform refresh_money_state(r.id);

  return jsonb_build_object('invoice_replaced', v_inv is not null, 'held_minor', v_held, 'surplus_minor', v_surplus);
end $$;
revoke all on function stay_change_reconcile(uuid, uuid) from public, anon, authenticated;

-- ---- notice wording for the new reason ----------------------------------------------------------------------------
create or replace function notify_reservation_attention() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_title text; v_body text; v_sev text := 'attention';
begin
  case
    when new.attention_reason = 'paid_inventory_lost' then
      v_title := 'Paid, but the room is gone: ' || new.booking_reference; v_sev := 'urgent';
      v_body := 'The guest paid after the hold lapsed and the room was taken. Arrange another room or a full refund.';
    when new.attention_reason = 'paid_after_cancel' then
      v_title := 'Payment arrived for a cancelled booking: ' || new.booking_reference; v_sev := 'urgent';
      v_body := 'Money was received after the booking was cancelled. Check it and refund it if it is due.';
    when new.attention_reason = 'cancellation_charge_unpaid' then
      v_title := 'Cancellation charge not covered: ' || new.booking_reference;
      v_body := 'The booking was cancelled with a charge larger than what was paid.';
    when new.attention_reason = 'early_checkout_refund_due' then
      v_title := 'Refund due after early check-out: ' || new.booking_reference;
      v_body := 'The guest left early and has paid more than the reduced total. Request a refund for the difference from the settlement page.';
    when new.attention_reason = 'stay_change_refund_due' then
      v_title := 'Refund due after a date change: ' || new.booking_reference;
      v_body := 'The dates were changed and the guest has paid more than the new total. Request a refund for the difference from the booking''s payments.';
    when new.attention_reason like 'payment\_%' then
      v_title := 'A payment needs a look: ' || new.booking_reference;
      v_body := 'Reason: ' || replace(substr(new.attention_reason, 9), '_', ' ') || '.';
    else
      v_title := 'Booking needs attention: ' || new.booking_reference;
      v_body := 'Reason: ' || replace(new.attention_reason, '_', ' ') || '.';
  end case;
  perform enqueue_notification(new.property_id, 'reservation_attention', 'money', v_sev, v_title, v_body,
                               '/app/reservations/' || new.id, 'payment.verify', 'reservation', new.id);
  return null;
end $$;

-- ---- the flag clears itself ------------------------------------------------------------------------------------
create or replace function refresh_money_state(p_reservation uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_inv uuid; r reservations%rowtype; v_held bigint; v_live bigint;
begin
  select id into v_inv from invoices where reservation_id = p_reservation and invoice_status <> 'void';
  if v_inv is not null then perform refresh_invoice_status(v_inv); end if;
  perform refresh_reservation_payment_status(p_reservation);
  select * into r from reservations where id = p_reservation;
  if r.reservation_status = 'cancelled' then
    v_held := reservation_money_held(p_reservation);
    if r.cancellation_charge_minor > v_held and r.attention_reason is null then
      update reservations set attention_reason = 'cancellation_charge_unpaid' where id = p_reservation;
    elsif r.cancellation_charge_minor <= v_held and r.attention_reason = 'cancellation_charge_unpaid' then
      update reservations set attention_reason = null where id = p_reservation;
    end if;
  elsif r.attention_reason in ('early_checkout_refund_due', 'stay_change_refund_due') then
    v_held := reservation_money_held(p_reservation);
    select coalesce(sum(amount_minor), 0) into v_live from refunds
     where reservation_id = p_reservation and refund_status in ('requested', 'approved', 'processing');
    if v_held - v_live <= r.total_minor then update reservations set attention_reason = null where id = p_reservation; end if;
  end if;
end $$;

-- ---- the date change itself (033 / 057 body, with the money checks removed and the reconcile added) ------------
create or replace function update_reservation_stay(
  p_reservation_id  uuid,
  p_arrival         date,
  p_departure       date,
  p_guests          jsonb,      -- [{"reservation_room_id": ..., "adults": 2, "children": 0}]; rooms left out keep their numbers
  p_reason          text,
  p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; rr reservation_rooms%rowtype; v_type room_types%rowtype;
  v_actor uuid; v_idem record; v_hash text; v_today date; v_reason text := nullif(btrim(p_reason), '');
  v_guests jsonb := coalesce(p_guests, '[]'::jsonb);
  e jsonb; v_rr uuid; v_adults integer; v_children integer; v_seen uuid[] := '{}';
  v_dates_changed boolean; v_guests_changed boolean := false;
  v_keep uuid; v_claim uuid; v_room uuid; v_night date; v_rate record; v_n integer;
  v_old_arr date; v_old_dep date; v_old_total bigint; v_levy bigint;
  v_sub bigint; v_tax bigint; v_out jsonb := '[]'::jsonb; v_result jsonb; v_moved boolean; v_moves integer := 0;
  v_recon jsonb := '{}'::jsonb;
begin
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(r.property_id, 'reservation.modify', 'NOT_FOUND');

  -- input shape (the checks that need no lock)
  if v_reason is null or length(v_reason) > 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;
  if p_arrival is null or p_departure is null or p_departure <= p_arrival then
    raise exception 'POLICY_VIOLATION: departure must follow arrival' using errcode = 'P0001';
  end if;
  if p_departure - p_arrival > 30 then raise exception 'POLICY_VIOLATION: stay too long' using errcode = 'P0001'; end if;
  if jsonb_typeof(v_guests) <> 'array' or jsonb_array_length(v_guests) > 10 then
    raise exception 'POLICY_VIOLATION: guests' using errcode = 'P0001';
  end if;
  v_today := property_today(r.property_id);
  if p_arrival <> r.arrival_date and p_arrival < v_today then
    raise exception 'POLICY_VIOLATION: arrival in the past' using errcode = 'P0001';
  end if;

  v_hash := md5(concat_ws('|', p_reservation_id, p_arrival, p_departure, v_guests::text, v_reason));
  select * into v_idem from idem_begin(r.tenant_id, 'update_reservation_stay', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  -- 1. the booking row first: this serialises edits, cancellations, payments and invoices on one booking
  select * into r from reservations where id = p_reservation_id for update;
  if r.reservation_status <> 'confirmed' then
    raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001';
  end if;
  if exists (select 1 from reservation_rooms where reservation_id = r.id and room_status <> 'booked') then
    raise exception 'INVALID_STATE: room' using errcode = 'P0001';
  end if;
  -- 070: a payment or a live invoice no longer stops the edit; stay_change_reconcile (below) replaces the invoice and
  -- flags a surplus. A provider payment still in flight does stop it, and so does a discount (its own rule, not touched here).
  if exists (select 1 from payment_attempts where reservation_id = r.id and status = 'initiated') then
    raise exception 'INVALID_STATE: payment started' using errcode = 'P0001';
  end if;
  if r.discount_minor > 0 then raise exception 'POLICY_VIOLATION: discount' using errcode = 'P0001'; end if;
  v_old_arr := r.arrival_date; v_old_dep := r.departure_date; v_old_total := r.total_minor;

  -- 2. the guest numbers: check every entry before changing anything
  for e in select * from jsonb_array_elements(v_guests) loop
    begin
      v_rr := (e ->> 'reservation_room_id')::uuid;
      v_adults := (e ->> 'adults')::integer;
      v_children := coalesce((e ->> 'children')::integer, 0);
    exception when others then
      raise exception 'POLICY_VIOLATION: guests' using errcode = 'P0001';
    end;
    if v_rr is null or v_adults is null or v_rr = any (v_seen) then raise exception 'POLICY_VIOLATION: guests' using errcode = 'P0001'; end if;
    v_seen := v_seen || v_rr;
    select * into rr from reservation_rooms where id = v_rr and reservation_id = r.id;
    if not found then raise exception 'POLICY_VIOLATION: room' using errcode = 'P0001'; end if;
    select * into v_type from room_types where id = rr.room_type_id;
    if v_adults < 1 or v_children < 0 or v_adults > v_type.max_adults or v_children > v_type.max_children
       or v_adults + v_children > v_type.max_occupancy then
      raise exception 'CAPACITY_EXCEEDED' using errcode = 'P0001';
    end if;
    if v_adults <> rr.adults or v_children <> rr.children then v_guests_changed := true; end if;
  end loop;

  v_dates_changed := (p_arrival <> r.arrival_date or p_departure <> r.departure_date);
  if not v_dates_changed and not v_guests_changed then
    v_result := jsonb_build_object('reservation_id', r.id, 'changed', false, 'arrival_date', r.arrival_date,
                                   'departure_date', r.departure_date, 'total_minor', r.total_minor);
    perform idem_finish(r.tenant_id, 'update_reservation_stay', p_idempotency_key, v_result);
    return v_result;
  end if;

  -- 3. new dates: claims, then nights, then totals
  if v_dates_changed then
    -- the claim rows first, then the room types (the order transfer_room uses)
    perform 1 from room_inventory_claims
     where reservation_room_id in (select id from reservation_rooms where reservation_id = r.id)
       and status = 'active' and claim_type in ('stay', 'hold')
     order by id for update;
    perform lock_room_types(r.property_id, array(select room_type_id from reservation_rooms where reservation_id = r.id));

    for rr in select * from reservation_rooms where reservation_id = r.id order by id loop
      select count(*) into v_n from room_inventory_claims
       where reservation_room_id = rr.id and status = 'active' and claim_type in ('stay', 'hold');
      if v_n <> 1 then raise exception 'INVALID_STATE: split stay' using errcode = 'P0001'; end if;
      select room_id into v_keep from room_inventory_claims
       where reservation_room_id = rr.id and status = 'active' and claim_type in ('stay', 'hold');

      update room_inventory_claims set status = 'released'
       where reservation_room_id = rr.id and status = 'active' and claim_type in ('stay', 'hold');
      v_claim := null;
      begin
        v_claim := claim_room(r.property_id, null, v_keep, p_arrival, p_departure, 'stay', rr.id, null, null, v_actor);
      exception when sqlstate 'P0001' then
        if sqlerrm <> 'ROOM_UNAVAILABLE' then raise; end if;
      end;
      if v_claim is null then
        v_claim := claim_room(r.property_id, rr.room_type_id, null, p_arrival, p_departure, 'stay', rr.id, null, null, v_actor);
      end if;
      select room_id into v_room from room_inventory_claims where id = v_claim;
      v_moved := v_room <> v_keep;
      if v_moved then v_moves := v_moves + 1; end if;

      -- nights already sold keep their price; nights that fall away go; new nights take today's price and tax.
      -- 057: the stay levy (fixed per stay) was charged once on the old first night; it moves with the stay to the new first
      -- night at the same amount, so changing dates never adds a second levy and never drops the one already charged.
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

    select coalesce(sum(n.rate_minor), 0), coalesce(sum(n.tax_minor), 0) into v_sub, v_tax
      from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = r.id;
    update reservations set arrival_date = p_arrival, departure_date = p_departure,
           subtotal_minor = v_sub, tax_minor = v_tax, total_minor = v_sub + v_tax
     where id = r.id;
    -- 070: a live invoice is for the old nights and total; replace it, then see whether the guest has paid too much
    v_recon := stay_change_reconcile(r.id, v_actor);
  end if;

  -- 4. the guest numbers
  for e in select * from jsonb_array_elements(v_guests) loop
    update reservation_rooms set adults = (e ->> 'adults')::integer, children = coalesce((e ->> 'children')::integer, 0)
     where id = (e ->> 'reservation_room_id')::uuid and reservation_id = r.id;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('reservation_room_id', x.id, 'room_id', c.room_id, 'adults', x.adults, 'children', x.children) order by x.id), '[]'::jsonb)
    into v_out
    from reservation_rooms x
    left join room_inventory_claims c on c.reservation_room_id = x.id and c.status = 'active' and c.claim_type in ('stay', 'hold')
   where x.reservation_id = r.id;
  select * into r from reservations where id = r.id;
  v_result := jsonb_build_object('reservation_id', r.id, 'changed', true, 'arrival_date', r.arrival_date, 'departure_date', r.departure_date,
                                 'subtotal_minor', r.subtotal_minor, 'tax_minor', r.tax_minor, 'total_minor', r.total_minor,
                                 'rooms_moved', v_moves, 'rooms', v_out,
                                 'invoice_replaced', coalesce((v_recon ->> 'invoice_replaced')::boolean, false),
                                 'surplus_minor', coalesce((v_recon ->> 'surplus_minor')::bigint, 0));
  perform idem_finish(r.tenant_id, 'update_reservation_stay', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'reservation.stay_changed', 'reservation', r.id, p_idempotency_key,
                      jsonb_build_object('reason', v_reason, 'dates_changed', v_dates_changed, 'guests_changed', v_guests_changed, 'rooms_moved', v_moves,
                                         'from_arrival', v_old_arr, 'from_departure', v_old_dep, 'from_total_minor', v_old_total,
                                         'to_arrival', r.arrival_date, 'to_departure', r.departure_date, 'to_total_minor', r.total_minor,
                                         'invoice_replaced', coalesce((v_recon ->> 'invoice_replaced')::boolean, false),
                                         'held_minor', coalesce((v_recon ->> 'held_minor')::bigint, 0),
                                         'surplus_minor', coalesce((v_recon ->> 'surplus_minor')::bigint, 0)));
  return v_result;
end $$;
