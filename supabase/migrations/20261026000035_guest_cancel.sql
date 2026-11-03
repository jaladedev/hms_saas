-- 035 Guests cancel their own booking.
--
-- A guest with a valid booking link (the server checks the signed token, then calls these as service_role) can see exactly
-- what cancelling would cost and then cancel. The rules are the staff rules, not new ones: the booking's own policy
-- snapshot decides the charge (the same arithmetic cancel_reservation always used), and the same settlement runs after:
-- a fee invoice for any charge, refund requests for money held beyond it (staff approve and pay those out, as for any refund).
--
-- What the guest may cancel: a CONFIRMED booking, before check-in time on the arrival day, with nobody checked in.
-- An unpaid online hold is not cancelled here: it frees itself when its time runs out. After the arrival time, or once a
-- guest is in the room, the hotel has to handle it.
--
-- To keep one set of rules, cancel_reservation is split: cancellation_quote (the charge) and cancel_reservation_apply
-- (lock, state check, release rooms, mark cancelled, audit) are shared by the staff and guest paths. cancel_reservation
-- behaves as before: same permission, same errors, same results.
--
-- Errors: NOT_FOUND, FORBIDDEN (not service_role), INVALID_STATE: <status> (not cancellable), INVALID_STATE: too late,
-- POLICY_VIOLATION: charge changed (the guest agreed to a different charge than applies now; they must look again).

create function cancellation_quote(p_reservation uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  r reservations%rowtype; v_prop record; v_checkin time; v_hours numeric; v_rule jsonb; v_type text; v_val numeric; v_charge bigint := 0;
begin
  select * into r from reservations where id = p_reservation;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select timezone, check_in_time into v_prop from properties where id = r.property_id;
  v_checkin := coalesce((r.policy_snapshot ->> 'check_in_time')::time, v_prop.check_in_time);
  v_hours := extract(epoch from (((r.arrival_date + v_checkin) at time zone v_prop.timezone) - now())) / 3600;

  select rule into v_rule
    from jsonb_array_elements(coalesce(r.policy_snapshot -> 'cancellation_rules', '[]'::jsonb)) rule
   where (rule ->> 'within_hours')::numeric >= v_hours
   order by (rule ->> 'within_hours')::numeric asc limit 1;

  if v_rule is not null then
    v_type := v_rule -> 'charge' ->> 'type';
    v_val  := (v_rule -> 'charge' ->> 'value')::numeric;
    if v_type = 'percent' then
      v_charge := round(r.total_minor * v_val / 100)::bigint;
    elsif v_type = 'nights' then
      select coalesce(sum(x.rate_minor + x.tax_minor), 0)::bigint into v_charge from (
        select n.rate_minor, n.tax_minor,
               row_number() over (partition by n.reservation_room_id order by n.night_date) as rn
          from reservation_nights n join reservation_rooms rr on rr.id = n.reservation_room_id
         where rr.reservation_id = r.id) x
       where x.rn <= v_val;
    elsif v_type = 'fixed' then
      v_charge := round(v_val)::bigint;
    else
      raise exception 'POLICY_VIOLATION: unknown charge type %', v_type using errcode = 'P0001';
    end if;
    v_charge := least(v_charge, r.total_minor);
  end if;
  return jsonb_build_object('charge_minor', v_charge, 'hours_before_arrival', round(v_hours, 1));
end $$;
revoke all on function cancellation_quote(uuid) from public, anon, authenticated;

-- Lock, check, release and mark cancelled. The caller has already checked who may do this and handled idempotency.
create function cancel_reservation_apply(p_reservation_id uuid, p_reason text, p_actor uuid, p_by text, p_idempotency_key text,
                                         p_expected_charge bigint default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r reservations%rowtype; v_quote jsonb; v_charge bigint; v_result jsonb;
begin
  select * into r from reservations where id = p_reservation_id for update;
  if r.reservation_status not in ('pending', 'confirmed')
     or exists (select 1 from reservation_rooms where reservation_id = r.id and room_status in ('checked_in','checked_out')) then
    raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001';
  end if;
  v_quote := cancellation_quote(r.id);
  v_charge := (v_quote ->> 'charge_minor')::bigint;
  if p_expected_charge is not null and p_expected_charge <> v_charge then
    raise exception 'POLICY_VIOLATION: charge changed' using errcode = 'P0001';
  end if;

  update room_inventory_claims set status = 'released'
   where status = 'active' and reservation_room_id in (select id from reservation_rooms where reservation_id = r.id);
  update reservation_rooms set room_status = 'cancelled' where reservation_id = r.id;
  update reservations set reservation_status = 'cancelled', cancelled_at = now(),
         cancellation_charge_minor = v_charge, cancel_reason = p_reason
   where id = r.id;

  v_result := jsonb_build_object('reservation_id', r.id, 'status', 'cancelled', 'cancellation_charge_minor', v_charge,
                                 'hours_before_arrival', (v_quote ->> 'hours_before_arrival')::numeric);
  perform idem_finish(r.tenant_id, case when p_by = 'guest' then 'guest_cancel_reservation' else 'cancel_reservation' end, p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, p_actor, 'reservation.cancelled', 'reservation', r.id,
                      p_idempotency_key, jsonb_build_object('reason', p_reason, 'charge_minor', v_charge)
                                         || case when p_by = 'guest' then jsonb_build_object('by', 'guest') else '{}'::jsonb end);
  return v_result;
end $$;
revoke all on function cancel_reservation_apply(uuid, text, uuid, text, text, bigint) from public, anon, authenticated;

create or replace function cancel_reservation(p_reservation_id uuid, p_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r reservations%rowtype; v_actor uuid; v_idem record; v_hash text;
begin
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(r.property_id, 'reservation.cancel', 'NOT_FOUND');
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'POLICY_VIOLATION: reason required' using errcode = 'P0001';
  end if;
  v_hash := md5(concat_ws('|', p_reservation_id, p_reason));
  select * into v_idem from idem_begin(r.tenant_id, 'cancel_reservation', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;
  return cancel_reservation_apply(p_reservation_id, p_reason, v_actor, 'staff', p_idempotency_key);
end $$;

-- What cancelling would mean for the guest, as of now. Never changes anything.
create function guest_cancel_preview(p_reservation_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r reservations%rowtype; v_quote jsonb; v_held bigint; v_charge bigint; v_why text;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_quote := cancellation_quote(r.id);
  v_charge := (v_quote ->> 'charge_minor')::bigint;
  v_held := reservation_money_held(r.id);
  v_why := case
    when r.reservation_status <> 'confirmed' then 'status'
    when exists (select 1 from reservation_rooms where reservation_id = r.id and room_status in ('checked_in', 'checked_out')) then 'started'
    when (v_quote ->> 'hours_before_arrival')::numeric <= 0 then 'too_late'
    else null end;
  return jsonb_build_object('allowed', v_why is null, 'why_not', v_why, 'currency', r.currency,
    'charge_minor', v_charge, 'held_minor', v_held,
    'refund_minor', greatest(v_held - v_charge, 0), 'still_owed_minor', greatest(v_charge - v_held, 0),
    'hours_before_arrival', (v_quote ->> 'hours_before_arrival')::numeric);
end $$;

-- The guest cancels, having been shown p_expected_charge_minor. If the charge is not that any more (a rule boundary passed
-- while they were reading), nothing happens and they are asked to look again.
create function guest_cancel_reservation(p_reservation_id uuid, p_expected_charge_minor bigint, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r reservations%rowtype; v_idem record; v_hash text; v_prev jsonb; v_why text;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_expected_charge_minor is null or p_expected_charge_minor < 0 then
    raise exception 'POLICY_VIOLATION: charge changed' using errcode = 'P0001';
  end if;
  v_hash := md5(concat_ws('|', p_reservation_id, p_expected_charge_minor));
  select * into v_idem from idem_begin(r.tenant_id, 'guest_cancel_reservation', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  select * into r from reservations where id = p_reservation_id for update;
  v_prev := guest_cancel_preview(r.id);
  v_why := v_prev ->> 'why_not';
  if v_why = 'too_late' then raise exception 'INVALID_STATE: too late' using errcode = 'P0001'; end if;
  if v_why is not null then raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001'; end if;
  return cancel_reservation_apply(r.id, 'Cancelled by the guest', null, 'guest', p_idempotency_key, p_expected_charge_minor);
end $$;

revoke all on function guest_cancel_preview(uuid), guest_cancel_reservation(uuid, bigint, text) from public, anon, authenticated;
grant execute on function guest_cancel_preview(uuid), guest_cancel_reservation(uuid, bigint, text) to service_role;
