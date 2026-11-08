-- 075 Sixth enforced flag: guest_changes.
--
-- A hotel group needs the plan flag `guest_changes` (no row means on) AND its own policy `guest_changes = 'on'` (069) for guests to
-- change things from their booking link. With the flag row set to enabled = false, guest_change_options answers why_not =
-- 'disabled', which is what every guest self-service function already asks first: guest_update_contact (phone), guest_request_change,
-- guest_withdraw_change_request's page, and guest_change_dates (071, the guest changing dates alone) all refuse, and the booking
-- page shows no change section. Staff can still change a booking and answer requests already open. Existing requests and past
-- changes are untouched. guest_change_options is copied from 069 with only the flag check added.

create or replace function guest_change_options(p_reservation_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r reservations%rowtype; v_pol jsonb; v_hours integer; v_until numeric; v_why text; v_open guest_change_requests%rowtype; v_phone text; v_last guest_change_requests%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_pol := current_policy(r.property_id, property_today(r.property_id));
  v_hours := coalesce(nullif(v_pol ->> 'guest_change_hours', '')::integer, 48);
  v_until := extract(epoch from ((r.arrival_date::timestamp + coalesce((select check_in_time from properties where id = r.property_id), time '14:00'))
                                 - (now() at time zone (select timezone from properties where id = r.property_id)))) / 3600.0;
  v_why := case
    when coalesce(v_pol ->> 'guest_changes', 'off') <> 'on' or not tenant_feature_on(r.tenant_id, 'guest_changes') then 'disabled'
    when r.reservation_status <> 'confirmed' then 'status'
    when exists (select 1 from reservation_rooms where reservation_id = r.id and room_status <> 'booked') then 'started'
    when v_until <= 0 then 'started'
    else null end;
  select * into v_open from guest_change_requests where reservation_id = r.id and status = 'open';
  select * into v_last from guest_change_requests where reservation_id = r.id and status in ('done', 'declined') order by resolved_at desc limit 1;
  select phone into v_phone from guests where id = r.primary_guest_id;
  return jsonb_build_object('allowed', v_why is null, 'why_not', v_why, 'dates_open', v_why is null and v_until > v_hours,
    'window_hours', v_hours, 'hours_before_arrival', round(v_until, 1), 'phone', v_phone,
    'open_request', case when v_open.id is null then null else jsonb_build_object('id', v_open.id, 'kind', v_open.kind,
        'arrival', v_open.requested_arrival, 'departure', v_open.requested_departure, 'message', v_open.message, 'created_at', v_open.created_at) end,
    'last_answer', case when v_last.id is null then null else jsonb_build_object('status', v_last.status, 'note', v_last.resolution_note, 'resolved_at', v_last.resolved_at) end);
end $$;
