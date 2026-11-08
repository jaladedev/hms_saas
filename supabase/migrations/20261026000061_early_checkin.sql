-- 061 Early check-in: a guest who arrives BEFORE their booked arrival date (db-spec 12.4: "validate an authorized early check-in").
--
-- check_in (008) still refuses it (EARLY_CHECKIN_NOT_SUPPORTED) and is not changed. A new function, early_check_in, does it, and
-- only when the hotel has switched it on. Chosen rules:
--   * Policy key early_checkin_days: a whole number 1 to 7, how many days before arrival a guest may be checked in. Absent (or
--     anything else) means off, which is what always happened. Read from the policy in force TODAY at the property (like
--     early_checkout and guest_cancellation); the policy screen has a field.
--   * Who: anyone with reservation.checkin, but a written reason is REQUIRED (it is audited, and it also stands in for the
--     "room not ready" override that check_in takes). A waiver of the charge is NOT built: the earlier nights are sold like any
--     other night. (A reservation_night cannot be free, and a discount only works on a booking with no money on it.)
--   * What it does, in one transaction: the room's stay claim is extended back to today (the same room when it is free for the
--     earlier nights, otherwise the first free room of the same type, like update_reservation_stay), a night is added for every
--     date from today to the day before arrival at that night's rate and tax (RATE_MISSING if a night has no price), a fixed
--     per-stay levy (057) moves to the new first night at the same amount, the booking's subtotal and tax are summed again, a
--     percentage discount (058) is applied again to the larger price, arrival_date becomes today, a live invoice is voided
--     ('early check-in') and replaced by one covering every night with the held money allocated, and the guest is checked in.
--   * The balance goes UP, never down, so nothing is refunded and no flag is raised. If the booking's policy requires payment in
--     full before check-in and the larger total is not covered, PAYMENT_REQUIRED applies as in check_in (payment.verify may
--     override with the reason).
--   * Only a CONFIRMED booking whose room is still 'booked', with one active stay claim for that room (a planned room change
--     partway through is refused: INVALID_STATE split stay), and no provider payment attempt in flight (the total would move
--     under it). One room at a time: the other rooms of the booking keep their dates.
--   * Audit 'reservation.early_checked_in': days early, nights added, old and new totals, the reason.
-- early_checkin_quote(room) tells the screen whether it is allowed, why not, and what it will add.
--
-- Errors: NOT_FOUND, INVALID_STATE (status, room, split stay, payment started, ROOM_NOT_ACTIVE), POLICY_VIOLATION
-- (EARLY_CHECKIN_NOT_SUPPORTED when off or not early, EARLY_CHECKIN_TOO_EARLY, reason, PAYMENT_REQUIRED), ROOM_UNAVAILABLE, RATE_MISSING.

create function early_checkin_days(p_property uuid, p_on date) returns integer
language sql stable security definer set search_path = public as $$
  select case when jsonb_typeof(current_policy(p_property, p_on) -> 'early_checkin_days') = 'number'
               and (current_policy(p_property, p_on) ->> 'early_checkin_days')::numeric between 1 and 7
               and (current_policy(p_property, p_on) ->> 'early_checkin_days')::numeric = trunc((current_policy(p_property, p_on) ->> 'early_checkin_days')::numeric)
              then (current_policy(p_property, p_on) ->> 'early_checkin_days')::integer else 0 end
$$;
revoke all on function early_checkin_days(uuid, date) from public, anon, authenticated;

-- The booking's totals once the room has the nights from p_today to the day before arrival (discount re-applied). Raises RATE_MISSING.
create function early_checkin_new_totals(p_reservation uuid, p_reservation_room uuid, p_today date)
returns table (subtotal bigint, tax bigint, discount bigint, total bigint, nights_added integer, added_minor bigint)
language plpgsql stable security definer set search_path = public as $$
declare r reservations%rowtype; rr reservation_rooms%rowtype; v_sub bigint; v_tax bigint; v_disc bigint := 0; v_night date; v_rate record; v_n integer := 0; v_new bigint;
begin
  select * into r from reservations where id = p_reservation;
  select * into rr from reservation_rooms where id = p_reservation_room;
  select coalesce(sum(n.rate_minor), 0), coalesce(sum(n.tax_minor), 0) into v_sub, v_tax
    from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = r.id;
  for v_night in select generate_series(p_today, r.arrival_date - 1, interval '1 day')::date loop
    select * into v_rate from resolve_rate(r.property_id, rr.room_type_id, rr.rate_plan_id, v_night);
    if v_rate.amount_minor is null then raise exception 'RATE_MISSING' using errcode = 'P0001'; end if;
    v_sub := v_sub + v_rate.amount_minor;
    v_tax := v_tax + calc_night_tax(r.property_id, v_night, v_rate.amount_minor);
    v_n := v_n + 1;
  end loop;
  if r.discount_percent is not null then v_disc := round((v_sub + v_tax) * r.discount_percent / 100)::bigint; end if;
  v_new := v_sub + v_tax - v_disc;
  return query select v_sub, v_tax, v_disc, v_new, v_n, v_new - r.total_minor;
end $$;
revoke all on function early_checkin_new_totals(uuid, uuid, date) from public, anon, authenticated;

create function early_checkin_quote(p_reservation_room_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare rr reservation_rooms%rowtype; r reservations%rowtype; v_today date; v_max integer; v_days integer; v_why text; v_n integer := 0; v_added bigint := 0; v_total bigint;
begin
  select * into rr from reservation_rooms where id = p_reservation_room_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  perform require_permission(rr.property_id, 'reservation.checkin', 'NOT_FOUND');
  select * into r from reservations where id = rr.reservation_id;
  v_today := property_today(r.property_id);
  v_days := r.arrival_date - v_today;
  v_max := early_checkin_days(r.property_id, v_today);
  v_why := case
    when r.reservation_status <> 'confirmed' or rr.room_status <> 'booked' then 'status'
    when v_days <= 0 then 'not_early'
    when v_max = 0 then 'off'
    when v_days > v_max then 'too_early'
    when exists (select 1 from payment_attempts where reservation_id = r.id and status = 'initiated') then 'payment_started'
    else null end;
  if v_why is null then
    begin
      select nights_added, added_minor, total into v_n, v_added, v_total from early_checkin_new_totals(r.id, rr.id, v_today);
    exception when sqlstate 'P0001' then
      if sqlerrm <> 'RATE_MISSING' then raise; end if;
      v_why := 'no_rate';
    end;
  end if;
  return jsonb_build_object('allowed', v_why is null, 'why_not', v_why, 'days_early', greatest(v_days, 0), 'max_days', v_max, 'currency', r.currency,
                            'nights_added', v_n, 'added_minor', v_added, 'new_total_minor', v_total);
end $$;

create function early_check_in(p_reservation_room_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  rr reservation_rooms%rowtype; r reservations%rowtype; t record; v_actor uuid; v_today date; v_reason text := nullif(btrim(p_reason), '');
  v_days integer; v_max integer; v_n integer; v_keep uuid; v_claim uuid; v_room uuid; v_end date; v_levy bigint; v_night date; v_rate record;
  v_old_total bigint; v_old_arr date; v_inv uuid; v_new uuid; v_year integer; v_num integer; v_number text; v_prop record; v_rooms rooms%rowtype;
begin
  select * into rr from reservation_rooms where id = p_reservation_room_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(rr.property_id, 'reservation.checkin', 'NOT_FOUND');
  if v_reason is null or length(v_reason) > 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;

  select * into r from reservations where id = rr.reservation_id for update;
  select * into rr from reservation_rooms where id = p_reservation_room_id for update;
  v_today := property_today(r.property_id);
  if r.reservation_status <> 'confirmed' or rr.room_status <> 'booked' then
    raise exception 'INVALID_STATE: reservation % room %', r.reservation_status, rr.room_status using errcode = 'P0001';
  end if;
  v_days := r.arrival_date - v_today;
  v_max := early_checkin_days(r.property_id, v_today);
  if v_days <= 0 or v_max = 0 then raise exception 'POLICY_VIOLATION: EARLY_CHECKIN_NOT_SUPPORTED' using errcode = 'P0001'; end if;
  if v_days > v_max then raise exception 'POLICY_VIOLATION: EARLY_CHECKIN_TOO_EARLY' using errcode = 'P0001'; end if;
  if exists (select 1 from payment_attempts where reservation_id = r.id and status = 'initiated') then
    raise exception 'INVALID_STATE: payment started' using errcode = 'P0001';
  end if;
  v_old_total := r.total_minor; v_old_arr := r.arrival_date;

  -- claims first, then the room types (the order transfer_room and update_reservation_stay use)
  perform 1 from room_inventory_claims where reservation_room_id = rr.id and status = 'active' and claim_type in ('stay', 'hold') order by id for update;
  perform lock_room_types(r.property_id, array[rr.room_type_id]);
  select count(*) into v_n from room_inventory_claims where reservation_room_id = rr.id and status = 'active' and claim_type in ('stay', 'hold');
  if v_n <> 1 then raise exception 'INVALID_STATE: split stay' using errcode = 'P0001'; end if;
  select room_id, end_date into v_keep, v_end from room_inventory_claims where reservation_room_id = rr.id and status = 'active' and claim_type in ('stay', 'hold');

  select * into t from early_checkin_new_totals(r.id, rr.id, v_today);       -- raises RATE_MISSING before anything changes

  update room_inventory_claims set status = 'released' where reservation_room_id = rr.id and status = 'active' and claim_type in ('stay', 'hold');
  v_claim := null;
  begin
    v_claim := claim_room(r.property_id, null, v_keep, v_today, v_end, 'stay', rr.id, null, null, v_actor);
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'ROOM_UNAVAILABLE' then raise; end if;
  end;
  if v_claim is null then
    v_claim := claim_room(r.property_id, rr.room_type_id, null, v_today, v_end, 'stay', rr.id, null, null, v_actor);
  end if;
  select room_id into v_room from room_inventory_claims where id = v_claim;
  select * into v_rooms from rooms where id = v_room;
  if v_rooms.operational_status <> 'active' then raise exception 'INVALID_STATE: ROOM_NOT_ACTIVE' using errcode = 'P0001'; end if;

  -- the earlier nights, and the per-stay levy moving to the new first night at the same amount (057)
  select coalesce(sum(stay_tax_minor), 0) into v_levy from reservation_nights where reservation_room_id = rr.id;
  for v_night in select generate_series(v_today, r.arrival_date - 1, interval '1 day')::date loop
    select * into v_rate from resolve_rate(r.property_id, rr.room_type_id, rr.rate_plan_id, v_night);
    insert into reservation_nights (tenant_id, reservation_room_id, night_date, rate_minor, tax_minor, rate_source)
    values (r.tenant_id, rr.id, v_night, v_rate.amount_minor, calc_night_tax(r.property_id, v_night, v_rate.amount_minor), v_rate.source);
  end loop;
  if v_levy > 0 then
    update reservation_nights set tax_minor = tax_minor - stay_tax_minor, stay_tax_minor = 0 where reservation_room_id = rr.id and stay_tax_minor > 0;
    update reservation_nights set tax_minor = tax_minor + v_levy, stay_tax_minor = v_levy where reservation_room_id = rr.id and night_date = v_today;
  end if;

  update reservations set arrival_date = v_today, subtotal_minor = t.subtotal, tax_minor = t.tax, discount_minor = t.discount, total_minor = t.total where id = r.id;

  -- a live invoice is for the old total: replace it with one that covers every night
  select id into v_inv from invoices where reservation_id = r.id and invoice_status <> 'void';
  if v_inv is not null then
    update invoices set invoice_status = 'void', void_reason = 'early check-in', voided_at = now(), voided_by = v_actor where id = v_inv;
    select code, check_in_time, timezone into v_prop from properties where id = r.property_id;
    v_year := extract(year from property_today(r.property_id))::integer;
    insert into invoice_sequences (property_id, year, last_number) values (r.property_id, v_year, 1)
    on conflict (property_id, year) do update set last_number = invoice_sequences.last_number + 1 returning last_number into v_num;
    v_number := 'INV-' || v_prop.code || '-' || v_year || '-' || lpad(v_num::text, 6, '0');
    v_new := gen_random_uuid();
    insert into invoices (id, tenant_id, property_id, reservation_id, invoice_number, currency, subtotal_minor, tax_minor, discount_minor, total_minor, due_at, created_by)
    values (v_new, r.tenant_id, r.property_id, r.id, v_number, r.currency, t.subtotal, t.tax, t.discount, t.total,
            (v_today + v_prop.check_in_time) at time zone v_prop.timezone, v_actor);
    insert into invoice_lines (tenant_id, invoice_id, description, quantity, unit_amount_minor, tax_amount_minor, line_total_minor, service_date)
    select r.tenant_id, v_new, rt.name || ', night of ' || n.night_date, 1, n.rate_minor, n.tax_minor, n.rate_minor + n.tax_minor, n.night_date
      from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id join room_types rt on rt.id = x.room_type_id
     where x.reservation_id = r.id order by n.night_date, rt.name, x.id;
    perform allocate_payments_to_invoice(v_new);
  end if;
  perform refresh_money_state(r.id);

  -- payment in full before check-in, if the booking's policy asks for it: the larger total must be covered (payment.verify may override)
  select * into r from reservations where id = r.id;
  if r.policy_snapshot ->> 'checkin_payment' = 'full' and r.payment_status <> 'paid'
     and not (v_actor is null or has_permission(r.property_id, 'payment.verify')) then
    raise exception 'POLICY_VIOLATION: PAYMENT_REQUIRED' using errcode = 'P0001';
  end if;

  update reservation_rooms set room_status = 'checked_in', checked_in_at = now() where id = rr.id;
  update reservations set reservation_status = 'checked_in' where id = r.id and reservation_status = 'confirmed';

  perform write_audit(r.tenant_id, r.property_id, v_actor, 'reservation.early_checked_in', 'reservation', r.id, null,
                      jsonb_build_object('reservation_room_id', rr.id, 'room_id', v_room, 'days_early', v_days, 'nights_added', t.nights_added,
                                         'from_arrival', v_old_arr, 'from_total_minor', v_old_total, 'to_total_minor', t.total,
                                         'room_changed', v_room <> v_keep, 'invoice_replaced', v_inv is not null, 'reason', v_reason));
  return jsonb_build_object('reservation_id', r.id, 'reservation_room_id', rr.id, 'room_id', v_room, 'status', 'checked_in',
                            'days_early', v_days, 'nights_added', t.nights_added, 'added_minor', t.total - v_old_total, 'new_total_minor', t.total);
end $$;

revoke all on function early_checkin_quote(uuid), early_check_in(uuid, text) from public, anon;
grant execute on function early_checkin_quote(uuid), early_check_in(uuid, text) to authenticated;
