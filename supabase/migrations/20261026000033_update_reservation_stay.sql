-- 033 Edit a booking's stay: its dates and how many adults and children are in each room.
--
-- Why this is narrow. A booking's total feeds the money code from 010-016 (one live invoice equal to the total,
-- payments capped at it, money held, settlement). Changing the total while money or an invoice exists would mean
-- changing all of that, so this function only works while NONE of it exists. Once anything is paid or invoiced,
-- the booking is cancelled and booked again. That is a deliberate first rule, not a limit of the database.
--
-- Rules:
--   * Permission reservation.modify (front desk, general manager, owner). Anyone else, and any other hotel: NOT_FOUND.
--   * Only a CONFIRMED booking whose rooms are all still 'booked'. A pending online booking is in the guest's payment
--     flow; a guest in the house, a cancelled, expired or no-show booking cannot change.
--   * Refused (INVALID_STATE) when the booking has any payment (even refunded or reversed), any invoice that is not
--     void, or a provider payment attempt still in flight: a total that moved under one of those would be wrong.
--   * Each room keeps the nights it already has at the price it was booked at. Only nights that are NEW get today's
--     price and tax; nights that fall away are removed. So lengthening a stay never re-prices the nights already sold.
--   * Each room keeps its physical room when that room is free for the new dates, otherwise it moves to the first free
--     room of the same type. All or nothing: if any room cannot be held for the new dates, nothing changes.
--   * A room that already has a planned change of room partway through (two active claims) is refused: merging the
--     claims would silently drop the move.
--   * Capacity is checked per room against its room type. A stay is at most 30 nights. A new arrival cannot be in the
--     past (an unchanged arrival may be, for a late guest whose departure is being moved).
--   * Needs a reason. Takes an idempotency key (same key and words returns the first answer; other words is
--     IDEMPOTENCY_MISMATCH). Nothing to change is answered as {"changed": false} and is not audited.
--   * Locks, in this order: the booking row, the claim rows of its rooms, then the room types (the same order as
--     transfer_room, which takes a claim row before the room-type lock, so the two cannot deadlock).
--
-- Errors: NOT_FOUND, POLICY_VIOLATION (departure must follow arrival, stay too long, arrival in the past, reason,
-- guests, room, discount), CAPACITY_EXCEEDED, ROOM_UNAVAILABLE, RATE_MISSING, INVALID_STATE (<status>, room,
-- money held, invoice, payment started, split stay).

create function update_reservation_stay(
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
  v_old_arr date; v_old_dep date; v_old_total bigint;
  v_sub bigint; v_tax bigint; v_out jsonb := '[]'::jsonb; v_result jsonb; v_moved boolean; v_moves integer := 0;
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
  if exists (select 1 from payments where reservation_id = r.id) then raise exception 'INVALID_STATE: money held' using errcode = 'P0001'; end if;
  if exists (select 1 from invoices where reservation_id = r.id and invoice_status <> 'void') then
    raise exception 'INVALID_STATE: invoice' using errcode = 'P0001';
  end if;
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

      -- nights already sold keep their price; nights that fall away go; new nights take today's price and tax
      delete from reservation_nights where reservation_room_id = rr.id and (night_date < p_arrival or night_date >= p_departure);
      for v_night in select generate_series(p_arrival, p_departure - 1, interval '1 day')::date loop
        if not exists (select 1 from reservation_nights where reservation_room_id = rr.id and night_date = v_night) then
          select * into v_rate from resolve_rate(r.property_id, rr.room_type_id, rr.rate_plan_id, v_night);
          insert into reservation_nights (tenant_id, reservation_room_id, night_date, rate_minor, tax_minor, rate_source)
          values (r.tenant_id, rr.id, v_night, v_rate.amount_minor, calc_night_tax(r.property_id, v_night, v_rate.amount_minor), v_rate.source);
        end if;
      end loop;
    end loop;

    select coalesce(sum(n.rate_minor), 0), coalesce(sum(n.tax_minor), 0) into v_sub, v_tax
      from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = r.id;
    update reservations set arrival_date = p_arrival, departure_date = p_departure,
           subtotal_minor = v_sub, tax_minor = v_tax, total_minor = v_sub + v_tax
     where id = r.id;
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
                                 'rooms_moved', v_moves, 'rooms', v_out);
  perform idem_finish(r.tenant_id, 'update_reservation_stay', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'reservation.stay_changed', 'reservation', r.id, p_idempotency_key,
                      jsonb_build_object('reason', v_reason, 'dates_changed', v_dates_changed, 'guests_changed', v_guests_changed, 'rooms_moved', v_moves,
                                         'from_arrival', v_old_arr, 'from_departure', v_old_dep, 'from_total_minor', v_old_total,
                                         'to_arrival', r.arrival_date, 'to_departure', r.departure_date, 'to_total_minor', r.total_minor));
  return v_result;
end $$;

revoke all on function update_reservation_stay(uuid, date, date, jsonb, text, text) from public, anon;
grant execute on function update_reservation_stay(uuid, date, date, jsonb, text, text) to authenticated;
