-- 038 A hotel setting to switch guest self-cancel off.
--
-- The policy gains one key, guest_cancellation: 'on' (the default, and what a policy without the key means) or 'off'.
-- Off means guests cannot cancel from their booking link; they are told to contact the hotel, and staff cancel as before.
--
-- It is read from the policy in force TODAY at the property, not from the booking's own snapshot. The snapshot holds the
-- terms a guest booked under (charges, payment); whether guests may do this themselves is how the hotel runs its desk, so
-- switching it off applies at once, to bookings already made too. The charge a guest would pay is still the snapshot's.
--
-- guest_cancel_preview now answers why_not = 'disabled' (checked after status, started and too_late, so those still say
-- what is wrong with the booking), and guest_cancel_reservation raises INVALID_STATE: disabled. guest_policy returns the
-- setting too, so the reserve page can say it before the guest books.

create or replace function guest_cancel_preview(p_reservation_id uuid) returns jsonb
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
    when current_policy(r.property_id, property_today(r.property_id)) ->> 'guest_cancellation' = 'off' then 'disabled'
    else null end;
  return jsonb_build_object('allowed', v_why is null, 'why_not', v_why, 'currency', r.currency,
    'charge_minor', v_charge, 'held_minor', v_held,
    'refund_minor', greatest(v_held - v_charge, 0), 'still_owed_minor', greatest(v_charge - v_held, 0),
    'hours_before_arrival', (v_quote ->> 'hours_before_arrival')::numeric);
end $$;

create or replace function guest_cancel_reservation(p_reservation_id uuid, p_expected_charge_minor bigint, p_idempotency_key text)
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
  if v_why = 'disabled' then raise exception 'INVALID_STATE: disabled' using errcode = 'P0001'; end if;
  if v_why is not null then raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001'; end if;
  return cancel_reservation_apply(r.id, 'Cancelled by the guest', null, 'guest', p_idempotency_key, p_expected_charge_minor);
end $$;

create or replace function guest_policy(p_host text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid; v_property uuid; v_today date; v_cfg jsonb; v_currency text;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.tenant_id, h.property_id into v_tenant, v_property from resolve_host(p_host) h;
  v_today := property_today(v_property);
  v_cfg := current_policy(v_property, v_today);
  select currency into v_currency from properties where id = v_property;
  return jsonb_build_object(
    'currency', v_currency,
    'cancellation_rules', coalesce(v_cfg -> 'cancellation_rules', '[]'::jsonb),
    'online_payment', coalesce(v_cfg -> 'online_payment', '{"mode":"full"}'::jsonb),
    'checkin_payment', coalesce(v_cfg -> 'checkin_payment', '"none"'::jsonb),
    'guest_cancellation', case when v_cfg ->> 'guest_cancellation' = 'off' then '"off"'::jsonb else '"on"'::jsonb end);
end $$;
