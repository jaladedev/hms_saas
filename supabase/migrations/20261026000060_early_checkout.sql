-- 060 Early check-out: what happens to the nights a guest does not stay (TODO: "settlement or credit on early check-out").
--
-- Until now a guest who left early had their rooms released and nothing else changed: the booking still showed the full price.
-- A hotel can now choose, in its policy, what leaving early means. The policy key is early_checkout:
--   absent or anything else   the hotel keeps the whole price (what always happened). Nothing below runs.
--   'credit'                  every night from today on that the guest does not stay is taken off the booking.
--   'one_night'               as 'credit', except the first of those nights (tonight's) is kept as an early-departure charge.
-- Read from the policy in force TODAY at the property, like guest_cancellation (038): it is how the hotel runs its desk.
-- (The policy JSON check from 035 allows keys it does not know, so the screen writes it and the database accepts it.)
--
-- When check_out finds an early departure under a credit policy, in the same transaction:
--   1. the credited nights are deleted from reservation_nights (so reports, which read nights, stop counting them);
--   2. the booking's subtotal and tax are summed again, and a percentage discount (058) is applied again to the smaller
--      price, so the guest gets the same percentage off what they actually stay. No discount is left on a free booking;
--   3. a live invoice is voided (reason 'early check-out') and replaced by one for the nights that remain, with the money
--      already held allocated to it, exactly as cancellation does for its charge invoice (016). No invoice, none issued;
--   4. if the guest has paid more than the new total, the booking is flagged attention_reason = 'early_checkout_refund_due'
--      (and the notice for it goes out). NO refund is created: a person raises it from the settlement page with the normal
--      refund flow, so the second-person approval still applies. The flag clears itself once refunds covering the surplus
--      are in progress or paid;
--   5. reservations.early_checkout_credit_minor adds up the credit given, and an audit row 'reservation.early_checkout_credited'
--      records the mode, the nights, and the old and new totals.
-- Tax on a credited night goes with the night. A fixed-per-stay levy (057) sits on a room's FIRST night, so it is only
-- credited when that first night is itself credited (a guest who checks in and leaves the same day under 'credit').
-- The booking's arrival and departure dates are left as booked: the rooms' checked_out_at and the audit row say when they left.
-- Folio (extras) charges are untouched.
--
-- early_checkout_quote(room) shows staff, before they press check-out, what it will do. Same permission as check_out.
-- reservation_settlement now also answers for a booking that was credited: kind 'early_checkout', how much is held against
-- the reduced total, and the refund still to request. Check-out itself still works exactly as before when the policy is off.

alter table reservations add column early_checkout_credit_minor bigint not null default 0 check (early_checkout_credit_minor >= 0);

create function early_checkout_mode(p_property uuid, p_on date) returns text
language sql stable security definer set search_path = public as $$
  select case current_policy(p_property, p_on) ->> 'early_checkout' when 'credit' then 'credit' when 'one_night' then 'one_night' else 'none' end
$$;
revoke all on function early_checkout_mode(uuid, date) from public, anon, authenticated;

-- The nights of one room that the policy would credit on p_today.
create function early_credit_nights(p_reservation_room uuid, p_today date, p_mode text) returns setof reservation_nights
language sql stable security definer set search_path = public as $$
  select n.* from reservation_nights n
   where n.reservation_room_id = p_reservation_room and n.night_date >= p_today
     and (p_mode = 'credit' or (p_mode = 'one_night' and n.night_date > p_today))
$$;
revoke all on function early_credit_nights(uuid, date, text) from public, anon, authenticated;

-- What the booking would cost after crediting the given nights of one room (discount re-applied).
create function early_checkout_new_totals(p_reservation uuid, p_reservation_room uuid, p_today date, p_mode text)
returns table (subtotal bigint, tax bigint, discount bigint, total bigint, nights_credited integer)
language plpgsql stable security definer set search_path = public as $$
declare r reservations%rowtype; v_sub bigint; v_tax bigint; v_disc bigint := 0; v_n integer;
begin
  select * into r from reservations where id = p_reservation;
  select coalesce(sum(n.rate_minor), 0), coalesce(sum(n.tax_minor), 0) into v_sub, v_tax
    from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id
   where x.reservation_id = r.id
     and n.id not in (select c.id from early_credit_nights(p_reservation_room, p_today, p_mode) c);
  select count(*) into v_n from early_credit_nights(p_reservation_room, p_today, p_mode);
  if r.discount_percent is not null and v_sub + v_tax > 0 then v_disc := round((v_sub + v_tax) * r.discount_percent / 100)::bigint; end if;
  return query select v_sub, v_tax, v_disc, v_sub + v_tax - v_disc, v_n;
end $$;
revoke all on function early_checkout_new_totals(uuid, uuid, date, text) from public, anon, authenticated;

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

-- ---- the flag clears itself ---------------------------------------------------------------------------------------
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
  elsif r.attention_reason = 'early_checkout_refund_due' then
    v_held := reservation_money_held(p_reservation);
    select coalesce(sum(amount_minor), 0) into v_live from refunds
     where reservation_id = p_reservation and refund_status in ('requested', 'approved', 'processing');
    if v_held - v_live <= r.total_minor then update reservations set attention_reason = null where id = p_reservation; end if;
  end if;
end $$;

-- ---- the credit itself --------------------------------------------------------------------------------------------
create function early_checkout_apply(p_reservation uuid, p_reservation_room uuid, p_today date, p_mode text, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; t record; v_old_total bigint; v_inv uuid; v_new uuid; v_year integer; v_n integer; v_number text; v_prop record;
  v_held bigint; v_live bigint; v_credit bigint; v_surplus bigint := 0; v_alloc bigint; v_nights date[];
begin
  select * into r from reservations where id = p_reservation for update;
  select * into t from early_checkout_new_totals(p_reservation, p_reservation_room, p_today, p_mode);
  if t.nights_credited = 0 then
    return jsonb_build_object('credit_minor', 0, 'nights_credited', 0);
  end if;
  v_old_total := r.total_minor;
  select array_agg(night_date order by night_date) into v_nights from early_credit_nights(p_reservation_room, p_today, p_mode);

  delete from reservation_nights where id in (select c.id from early_credit_nights(p_reservation_room, p_today, p_mode) c);
  update reservations set subtotal_minor = t.subtotal, tax_minor = t.tax, discount_minor = t.discount,
         discount_percent = case when t.discount > 0 then discount_percent else null end,
         discount_reason = case when t.discount > 0 then discount_reason else null end,
         total_minor = t.total, early_checkout_credit_minor = early_checkout_credit_minor + (v_old_total - t.total)
   where id = r.id;
  v_credit := v_old_total - t.total;

  -- a live invoice is for the old total: replace it with one for what remains
  select id into v_inv from invoices where reservation_id = r.id and invoice_status <> 'void';
  if v_inv is not null then
    update invoices set invoice_status = 'void', void_reason = 'early check-out', voided_at = now(), voided_by = p_actor where id = v_inv;
    if t.subtotal + t.tax > 0 then
      select code, check_in_time, timezone into v_prop from properties where id = r.property_id;
      v_year := extract(year from property_today(r.property_id))::integer;
      insert into invoice_sequences (property_id, year, last_number) values (r.property_id, v_year, 1)
      on conflict (property_id, year) do update set last_number = invoice_sequences.last_number + 1
      returning last_number into v_n;
      v_number := 'INV-' || v_prop.code || '-' || v_year || '-' || lpad(v_n::text, 6, '0');
      v_new := gen_random_uuid();
      insert into invoices (id, tenant_id, property_id, reservation_id, invoice_number, currency, subtotal_minor, tax_minor, discount_minor, total_minor, due_at, created_by)
      values (v_new, r.tenant_id, r.property_id, r.id, v_number, r.currency, t.subtotal, t.tax, t.discount, t.total,
              (r.arrival_date + v_prop.check_in_time) at time zone v_prop.timezone, p_actor);
      insert into invoice_lines (tenant_id, invoice_id, description, quantity, unit_amount_minor, tax_amount_minor, line_total_minor, service_date)
      select r.tenant_id, v_new, rt.name || ', night of ' || n.night_date, 1, n.rate_minor, n.tax_minor, n.rate_minor + n.tax_minor, n.night_date
        from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id join room_types rt on rt.id = x.room_type_id
       where x.reservation_id = r.id order by n.night_date, rt.name, x.id;
      v_alloc := allocate_payments_to_invoice(v_new);
    end if;
  end if;

  v_held := reservation_money_held(r.id);
  select coalesce(sum(amount_minor), 0) into v_live from refunds where reservation_id = r.id and refund_status in ('requested', 'approved', 'processing');
  v_surplus := greatest(v_held - v_live - t.total, 0);
  if v_surplus > 0 and r.attention_reason is null then
    update reservations set attention_reason = 'early_checkout_refund_due' where id = r.id;
  end if;
  perform refresh_money_state(r.id);

  perform write_audit(r.tenant_id, r.property_id, p_actor, 'reservation.early_checkout_credited', 'reservation', r.id, null,
                      jsonb_build_object('mode', p_mode, 'reservation_room_id', p_reservation_room, 'nights', to_jsonb(v_nights),
                                         'from_total_minor', v_old_total, 'to_total_minor', t.total, 'credit_minor', v_credit,
                                         'held_minor', v_held, 'surplus_minor', v_surplus,
                                         'invoice_replaced', v_inv is not null and v_new is not null));
  return jsonb_build_object('credit_minor', v_credit, 'nights_credited', t.nights_credited, 'new_total_minor', t.total, 'surplus_minor', v_surplus);
end $$;
revoke all on function early_checkout_apply(uuid, uuid, date, text, uuid) from public, anon, authenticated;

-- ---- check_out: the 008 body, plus the credit ---------------------------------------------------------------------
create or replace function check_out(p_reservation_room_id uuid, p_override_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  rr reservation_rooms%rowtype; r reservations%rowtype; v_actor uuid; v_today date;
  v_early boolean; v_room uuid; v_mode text; v_credit jsonb := jsonb_build_object('credit_minor', 0, 'nights_credited', 0);
begin
  select * into rr from reservation_rooms where id = p_reservation_room_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(rr.property_id, 'reservation.checkout', 'NOT_FOUND');

  select * into r from reservations where id = rr.reservation_id for update;
  select * into rr from reservation_rooms where id = p_reservation_room_id for update;
  v_today := property_today(r.property_id);

  if rr.room_status <> 'checked_in' then
    raise exception 'INVALID_STATE: room %', rr.room_status using errcode = 'P0001';
  end if;
  v_early := v_today < r.departure_date;

  select room_id into v_room from room_inventory_claims
   where reservation_room_id = rr.id and status = 'active' and claim_type = 'stay'
   order by (start_date <= v_today and end_date > v_today) desc, end_date desc limit 1;

  update reservation_rooms set room_status = 'checked_out', checked_out_at = now() where id = rr.id;

  if v_early then
    update room_inventory_claims set status = 'released'
     where reservation_room_id = rr.id and status = 'active' and start_date >= v_today;
    update room_inventory_claims set end_date = v_today
     where reservation_room_id = rr.id and status = 'active' and start_date < v_today and end_date > v_today;
    v_mode := early_checkout_mode(r.property_id, v_today);
    if v_mode <> 'none' then v_credit := early_checkout_apply(r.id, rr.id, v_today, v_mode, v_actor); end if;
  end if;

  if v_room is not null then
    update rooms set housekeeping_status = 'dirty' where id = v_room;
  end if;

  if not exists (select 1 from reservation_rooms where reservation_id = r.id and room_status in ('booked', 'checked_in')) then
    update reservations set reservation_status = 'checked_out' where id = r.id;
  end if;

  perform write_audit(r.tenant_id, r.property_id, v_actor, 'reservation.checked_out', 'reservation', r.id, null,
                      jsonb_build_object('reservation_room_id', rr.id, 'early_departure', v_early,
                                         'override_reason', p_override_reason, 'credit_minor', (v_credit ->> 'credit_minor')::bigint));
  return jsonb_build_object('reservation_id', r.id, 'reservation_room_id', rr.id, 'status', 'checked_out',
                            'early_departure', v_early, 'credit_minor', (v_credit ->> 'credit_minor')::bigint,
                            'nights_credited', (v_credit ->> 'nights_credited')::integer);
end $$;

-- ---- what check-out would do ---------------------------------------------------------------------------------------
create function early_checkout_quote(p_reservation_room_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare rr reservation_rooms%rowtype; r reservations%rowtype; v_today date; v_mode text; t record; v_held bigint;
begin
  select * into rr from reservation_rooms where id = p_reservation_room_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  perform require_permission(rr.property_id, 'reservation.checkout', 'NOT_FOUND');
  select * into r from reservations where id = rr.reservation_id;
  v_today := property_today(r.property_id);
  if rr.room_status <> 'checked_in' or v_today >= r.departure_date then
    return jsonb_build_object('early', false, 'mode', 'none', 'credit_minor', 0, 'nights_credited', 0, 'currency', r.currency);
  end if;
  v_mode := early_checkout_mode(r.property_id, v_today);
  if v_mode = 'none' then
    return jsonb_build_object('early', true, 'mode', 'none', 'credit_minor', 0, 'nights_credited', 0, 'currency', r.currency);
  end if;
  select * into t from early_checkout_new_totals(r.id, rr.id, v_today, v_mode);
  v_held := reservation_money_held(r.id);
  return jsonb_build_object('early', true, 'mode', v_mode, 'nights_credited', t.nights_credited, 'currency', r.currency,
                            'credit_minor', r.total_minor - t.total, 'new_total_minor', t.total,
                            'surplus_minor', case when can_view_money(r.property_id) then greatest(v_held - t.total, 0) else 0 end);
end $$;

-- ---- settlement for a credited booking ----------------------------------------------------------------------------
create or replace function reservation_settlement(p_reservation_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r reservations%rowtype; v_held bigint; v_live bigint; v_ok bigint; v_refund_due bigint; v_charge_due bigint; v_early boolean;
begin
  select * into r from reservations where id = p_reservation_id;
  if not found or not (is_system_caller() or can_view_money(r.property_id)) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_held := reservation_money_held(r.id);
  v_early := r.reservation_status <> 'cancelled' and r.early_checkout_credit_minor > 0;
  select coalesce(sum(amount_minor) filter (where refund_status in ('requested', 'approved', 'processing')), 0),
         coalesce(sum(amount_minor) filter (where refund_status = 'succeeded'), 0)
    into v_live, v_ok from refunds where reservation_id = r.id;
  v_refund_due := case when r.reservation_status = 'cancelled' then greatest(v_held - r.cancellation_charge_minor - v_live, 0)
                       when v_early then greatest(v_held - r.total_minor - v_live, 0) else 0 end;
  v_charge_due := case when r.reservation_status = 'cancelled' then greatest(r.cancellation_charge_minor - v_held, 0)
                       when v_early then greatest(r.total_minor - v_held, 0) else 0 end;
  return jsonb_build_object(
    'applicable', r.reservation_status = 'cancelled' or v_early, 'reservation_status', r.reservation_status,
    'kind', case when r.reservation_status = 'cancelled' then 'cancelled' when v_early then 'early_checkout' else null end,
    'charge_minor', case when v_early then r.total_minor else r.cancellation_charge_minor end,
    'credit_minor', r.early_checkout_credit_minor, 'held_minor', v_held,
    'refunds_in_flight_minor', v_live, 'refunded_minor', v_ok,
    'refund_still_to_request_minor', v_refund_due, 'charge_due_minor', v_charge_due,
    'settled', (r.reservation_status = 'cancelled' or v_early) and v_refund_due = 0 and v_live = 0 and v_charge_due = 0);
end $$;

revoke all on function early_checkout_quote(uuid) from public, anon;
grant execute on function early_checkout_quote(uuid) to authenticated;
