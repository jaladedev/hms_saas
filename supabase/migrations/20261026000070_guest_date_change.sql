-- 070 Guest self-service, part 2: the guest changes the dates of a confirmed booking from their booking link.
--
-- Allowed only when ALL of this holds (anything else stays a change request, 069):
--   * the hotel has guest changes on and the booking is outside the notice window (guest_change_options.dates_open);
--   * every room is still 'booked', nothing is mid-payment, no discount is on the booking, and a live invoice holds only
--     room-night lines (so replacing it loses nothing);
--   * the new price is not higher than the old one, and the guest has not paid more than the new price.
--     So the change never needs extra payment up front and never leaves money to refund.
-- Nights the guest keeps keep their price; new nights take today's rate and tax; the per-stay levy (057) moves to the new first
-- night at the same amount. A live invoice is voided and replaced, and money already paid is allocated to the new one.
-- The room stays the same when it is free, else another room of the same type; if none is free the change is refused.
-- Staff get an info notice; an open dates request from this guest is closed as dealt with.

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in (
  'reservation_attention', 'refund_needs_bank_details', 'refund_needs_attention', 'email_failed', 'repair_urgent', 'repair_overdue',
  'guest_cancelled', 'website_booking', 'no_show', 'room_dirty_arrival', 'payment_unverified', 'guest_change_request', 'guest_stay_changed'));

-- What the booking would cost on these dates. Read-only. Raises RATE_MISSING when a new night has no rate.
create function stay_dates_new_totals(p_reservation uuid, p_arrival date, p_departure date)
returns table (subtotal bigint, tax bigint, total bigint, nights_added integer, nights_dropped integer)
language plpgsql stable security definer set search_path = public as $$
declare r reservations%rowtype; rr reservation_rooms%rowtype; v_sub bigint := 0; v_tax bigint := 0; v_levy bigint; v_night date; v_old record; v_rate record; v_add integer := 0; v_drop integer := 0;
begin
  select * into r from reservations where id = p_reservation;
  for rr in select * from reservation_rooms where reservation_id = r.id order by id loop
    select coalesce(sum(stay_tax_minor), 0) into v_levy from reservation_nights where reservation_room_id = rr.id;
    select v_drop + count(*) into v_drop from reservation_nights where reservation_room_id = rr.id and (night_date < p_arrival or night_date >= p_departure);
    for v_night in select generate_series(p_arrival, p_departure - 1, interval '1 day')::date loop
      select rate_minor, tax_minor - stay_tax_minor as tax_minor into v_old from reservation_nights where reservation_room_id = rr.id and night_date = v_night;
      if found then
        v_sub := v_sub + v_old.rate_minor; v_tax := v_tax + v_old.tax_minor;
      else
        select * into v_rate from resolve_rate(r.property_id, rr.room_type_id, rr.rate_plan_id, v_night);
        if v_rate.amount_minor is null then raise exception 'RATE_MISSING' using errcode = 'P0001'; end if;
        v_sub := v_sub + v_rate.amount_minor; v_tax := v_tax + calc_night_tax(r.property_id, v_night, v_rate.amount_minor);
        v_add := v_add + 1;
      end if;
    end loop;
    v_tax := v_tax + v_levy;
  end loop;
  return query select v_sub, v_tax, v_sub + v_tax, v_add, v_drop;
end $$;
revoke all on function stay_dates_new_totals(uuid, date, date) from public, anon, authenticated;

-- why_not: the guest_change_options reasons, plus 'window', 'dates' (not valid), 'busy' (payment started), 'discount', 'extras',
-- 'no_rate', 'dearer' (the new price is higher), 'overpaid' (the guest has paid more than the new price), 'same'.
create function guest_change_dates_quote(p_reservation_id uuid, p_arrival date, p_departure date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r reservations%rowtype; v_opt jsonb; v_why text; v_held bigint; v_today date; v_total bigint; v_add integer; v_drop integer;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_opt := guest_change_options(r.id);
  v_held := reservation_money_held(r.id);
  v_today := property_today(r.property_id);
  v_why := case
    when v_opt ->> 'why_not' is not null then v_opt ->> 'why_not'
    when not (v_opt ->> 'dates_open')::boolean then 'window'
    when p_arrival is null or p_departure is null or p_departure <= p_arrival or p_departure - p_arrival > 30 or p_arrival < v_today then 'dates'
    when p_arrival = r.arrival_date and p_departure = r.departure_date then 'same'
    when exists (select 1 from payment_attempts where reservation_id = r.id and status = 'initiated') then 'busy'
    when r.discount_minor > 0 or r.discount_percent is not null then 'discount'
    when exists (select 1 from invoices i join invoice_lines l on l.invoice_id = i.id
                  where i.reservation_id = r.id and i.invoice_status <> 'void' and l.service_date is null) then 'extras'
    else null end;
  if v_why is null then
    begin
      select total, nights_added, nights_dropped into v_total, v_add, v_drop from stay_dates_new_totals(r.id, p_arrival, p_departure);
    exception when sqlstate 'P0001' then
      if sqlerrm <> 'RATE_MISSING' then raise; end if;
      v_why := 'no_rate';
    end;
  end if;
  if v_why is null then
    v_why := case when v_total > r.total_minor then 'dearer' when v_held > v_total then 'overpaid' else null end;
  end if;
  return jsonb_build_object('allowed', v_why is null, 'why_not', v_why, 'currency', r.currency,
    'old_total_minor', r.total_minor, 'new_total_minor', v_total, 'difference_minor', v_total - r.total_minor,
    'paid_minor', v_held, 'nights_added', v_add, 'nights_dropped', v_drop);
end $$;
revoke all on function guest_change_dates_quote(uuid, date, date) from public, anon, authenticated;
grant execute on function guest_change_dates_quote(uuid, date, date) to service_role;

create function guest_change_dates(p_reservation_id uuid, p_arrival date, p_departure date, p_expected_total_minor bigint, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; rr reservation_rooms%rowtype; v_idem record; v_q jsonb; t record; v_keep uuid; v_claim uuid; v_room uuid; v_n integer; v_night date; v_rate record; v_levy bigint;
  v_inv uuid; v_new uuid; v_year integer; v_num integer; v_number text; v_prop record; v_moves integer := 0; v_old_arr date; v_old_dep date; v_old_total bigint; v_result jsonb;
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

  -- a live invoice is for the old nights: replace it, and the money already paid moves onto the new one
  select id into v_inv from invoices where reservation_id = r.id and invoice_status <> 'void';
  if v_inv is not null then
    update invoices set invoice_status = 'void', void_reason = 'dates changed by the guest', voided_at = now() where id = v_inv;
    select code, check_in_time, timezone into v_prop from properties where id = r.property_id;
    v_year := extract(year from property_today(r.property_id))::integer;
    insert into invoice_sequences (property_id, year, last_number) values (r.property_id, v_year, 1)
    on conflict (property_id, year) do update set last_number = invoice_sequences.last_number + 1 returning last_number into v_num;
    v_number := 'INV-' || v_prop.code || '-' || v_year || '-' || lpad(v_num::text, 6, '0');
    v_new := gen_random_uuid();
    insert into invoices (id, tenant_id, property_id, reservation_id, invoice_number, currency, subtotal_minor, tax_minor, discount_minor, total_minor, due_at, created_by)
    values (v_new, r.tenant_id, r.property_id, r.id, v_number, r.currency, t.subtotal, t.tax, 0, t.total,
            (p_arrival + v_prop.check_in_time) at time zone v_prop.timezone, null);
    insert into invoice_lines (tenant_id, invoice_id, description, quantity, unit_amount_minor, tax_amount_minor, line_total_minor, service_date)
    select r.tenant_id, v_new, rt.name || ', night of ' || n.night_date, 1, n.rate_minor, n.tax_minor, n.rate_minor + n.tax_minor, n.night_date
      from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id join room_types rt on rt.id = x.room_type_id
     where x.reservation_id = r.id order by n.night_date, rt.name, x.id;
    perform allocate_payments_to_invoice(v_new);
  end if;
  perform refresh_money_state(r.id);

  -- the guest's own open dates request is answered by doing it
  update guest_change_requests set status = 'done', resolution_note = 'The guest changed the dates themselves.', resolved_at = now()
   where reservation_id = r.id and status = 'open' and kind = 'dates';

  select * into r from reservations where id = r.id;
  perform write_audit(r.tenant_id, r.property_id, null, 'reservation.stay_changed', 'reservation', r.id, p_idempotency_key,
                      jsonb_build_object('by', 'guest', 'dates_changed', true, 'from_arrival', v_old_arr, 'from_departure', v_old_dep, 'from_total_minor', v_old_total,
                                         'to_arrival', r.arrival_date, 'to_departure', r.departure_date, 'to_total_minor', r.total_minor,
                                         'rooms_moved', v_moves, 'invoice_replaced', v_inv is not null));
  perform enqueue_notification(r.property_id, 'guest_stay_changed', 'booking', 'info', 'Guest changed their dates: ' || r.booking_reference,
    'Now ' || r.arrival_date || ' to ' || r.departure_date || ' (was ' || v_old_arr || ' to ' || v_old_dep || ').',
    '/app/reservations/' || r.id, 'reservation.view', 'reservation', r.id, 'gdates:' || p_idempotency_key);
  v_result := jsonb_build_object('reservation_id', r.id, 'arrival_date', r.arrival_date, 'departure_date', r.departure_date,
                                 'total_minor', r.total_minor, 'rooms_moved', v_moves);
  perform idem_finish(r.tenant_id, 'guest_change_dates', p_idempotency_key, v_result);
  return v_result;
end $$;
revoke all on function guest_change_dates(uuid, date, date, bigint, text) from public, anon, authenticated;
grant execute on function guest_change_dates(uuid, date, date, bigint, text) to service_role;
