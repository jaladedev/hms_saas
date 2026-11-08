-- 073 Early check-in: waiving the added nights.
--
-- 061 left a waiver out because a night cannot be free and a discount could not go on a booking with money. Discounts can now
-- (065, 072), so the waiver is a fixed-amount discount (062) equal to the nights added:
--   * early_check_in gains p_waive (default false; nothing changes when it is false). The old two-argument function is replaced.
--   * Needs discount.apply as well as reservation.checkin (POLICY_VIOLATION: waiver), only when the booking has NO discount
--     (POLICY_VIOLATION: discount), and only within the person's own discount limit, counted as a share of the new price like
--     any amount discount (POLICY_VIOLATION: discount limit <cap>). Nothing is waived when any of it fails: the check-in itself
--     is refused, no half-way.
--   * The nights are still added and priced; the booking's discount_minor and discount_amount_minor become the added amount, the
--     reason is 'Early check-in waiver: <reason>', the total stays what it was, and the replacement invoice carries the discount.
--   * The audit row (reservation.early_checked_in) gets waived_minor; the answer gets waived_minor too. A later change to the
--     discount follows the normal rules (a live invoice must be voided first).
-- Everything else in the function is 061's.

drop function early_check_in(uuid, text);
create function early_check_in(p_reservation_room_id uuid, p_reason text, p_waive boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  rr reservation_rooms%rowtype; r reservations%rowtype; t record; v_actor uuid; v_today date; v_reason text := nullif(btrim(p_reason), '');
  v_days integer; v_max integer; v_n integer; v_keep uuid; v_claim uuid; v_room uuid; v_end date; v_levy bigint; v_night date; v_rate record;
  v_old_total bigint; v_old_arr date; v_inv uuid; v_new uuid; v_year integer; v_num integer; v_number text; v_prop record; v_rooms rooms%rowtype;
  v_waive bigint := 0; v_disc bigint; v_total bigint; v_cap numeric;
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

  -- 073: the waiver. The added nights are taken off as a fixed-amount discount (062) inside the person's own discount limit.
  if p_waive then
    if v_actor is null or not has_permission(r.property_id, 'discount.apply') then raise exception 'POLICY_VIOLATION: waiver' using errcode = 'P0001'; end if;
    if r.discount_minor > 0 then raise exception 'POLICY_VIOLATION: discount' using errcode = 'P0001'; end if;
    v_waive := t.total - v_old_total;
    v_cap := discount_cap_for(v_actor, r.tenant_id, r.property_id);
    if v_waive * 100 > v_cap * (t.subtotal + t.tax) then raise exception 'POLICY_VIOLATION: discount limit %', v_cap using errcode = 'P0001'; end if;
  end if;
  v_disc := case when p_waive then v_waive else t.discount end;
  v_total := t.subtotal + t.tax - v_disc;

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

  update reservations set arrival_date = v_today, subtotal_minor = t.subtotal, tax_minor = t.tax, discount_minor = v_disc, total_minor = v_total,
         discount_amount_minor = case when p_waive and v_waive > 0 then v_waive else discount_amount_minor end,
         discount_reason = case when p_waive then 'Early check-in waiver: ' || v_reason else discount_reason end
   where id = r.id;

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
    values (v_new, r.tenant_id, r.property_id, r.id, v_number, r.currency, t.subtotal, t.tax, v_disc, v_total,
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
                                         'from_arrival', v_old_arr, 'from_total_minor', v_old_total, 'to_total_minor', v_total, 'waived_minor', v_waive,
                                         'room_changed', v_room <> v_keep, 'invoice_replaced', v_inv is not null, 'reason', v_reason));
  return jsonb_build_object('reservation_id', r.id, 'reservation_room_id', rr.id, 'room_id', v_room, 'status', 'checked_in',
                            'days_early', v_days, 'nights_added', t.nights_added, 'added_minor', v_total - v_old_total, 'waived_minor', v_waive, 'new_total_minor', v_total);
end $$;

revoke all on function early_check_in(uuid, text, boolean) from public, anon;
grant execute on function early_check_in(uuid, text, boolean) to authenticated;
