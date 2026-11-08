-- 067 Fifth enforced flag: guest_cancel.
--
-- With a flag row `guest_cancel` set to enabled = false, a hotel group's guests cannot cancel from their booking link, the same
-- as the hotel's own guest_cancellation = 'off' policy (038): guest_cancel_preview answers why_not = 'disabled' (so
-- guest_cancel_reservation, which asks the preview, raises INVALID_STATE: disabled and the page says to contact the hotel) and
-- guest_policy reports "off" so the reserve page says it before booking. Staff cancellation is untouched. The plan flag and the
-- hotel's own setting are independent: either one off means off. No row means on. Both functions are copied from 038 with only
-- the flag check added.

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
    when current_policy(r.property_id, property_today(r.property_id)) ->> 'guest_cancellation' = 'off'
         or not tenant_feature_on(r.tenant_id, 'guest_cancel') then 'disabled'
    else null end;
  return jsonb_build_object('allowed', v_why is null, 'why_not', v_why, 'currency', r.currency,
    'charge_minor', v_charge, 'held_minor', v_held,
    'refund_minor', greatest(v_held - v_charge, 0), 'still_owed_minor', greatest(v_charge - v_held, 0),
    'hours_before_arrival', (v_quote ->> 'hours_before_arrival')::numeric);
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
    'guest_cancellation', case when v_cfg ->> 'guest_cancellation' = 'off' or not tenant_feature_on(v_tenant, 'guest_cancel') then '"off"'::jsonb else '"on"'::jsonb end);
end $$;
