-- 069 Guest self-service, part 1: contact details and change requests, from the guest's booking link.
--
-- The hotel switches it on with the policy key `guest_changes` = 'on' (absent means off) and may set
-- `guest_change_hours` (default 48): dates and room requests close that many hours before arrival.
--   * guest_update_contact: the guest corrects the phone number on the booking's guest record.
--     (Name and email are not editable here: the name is on invoices, and the email is how a lost link is recovered.)
--   * guest_request_change: a request for new dates, a different room, or anything else. Staff see it as a notice and in a
--     queue and answer it. Nothing about the booking, its price or its money changes by asking; one open request per booking.
--   * guest_withdraw_change_request: the guest takes an open request back.
--   * resolve_change_request: staff (reservation.modify) mark it done, after making the change on the booking, or decline it
--     with a note the guest sees.
-- Changing dates by the guest alone is a later step: the staff date change refuses bookings with money, and that comes first.

create table guest_change_requests (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  property_id        uuid not null,
  reservation_id     uuid not null,
  kind               text not null check (kind in ('dates', 'room', 'other')),
  requested_arrival  date,
  requested_departure date,
  message            text check (message is null or length(message) <= 500),
  status             text not null default 'open' check (status in ('open', 'done', 'declined', 'withdrawn')),
  resolution_note    text check (resolution_note is null or length(resolution_note) <= 500),
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz,
  resolved_by        uuid,
  foreign key (tenant_id, property_id, reservation_id) references reservations (tenant_id, property_id, id),
  check (kind <> 'dates' or (requested_arrival is not null and requested_departure is not null and requested_departure > requested_arrival)),
  check (kind = 'dates' or message is not null)
);
create unique index guest_change_requests_one_open on guest_change_requests (reservation_id) where status = 'open';
create index guest_change_requests_queue on guest_change_requests (property_id, status, created_at);

alter table guest_change_requests enable row level security;
create policy guest_change_requests_select on guest_change_requests for select to authenticated
  using (has_permission(property_id, 'reservation.modify'));
revoke insert, update, delete on guest_change_requests from authenticated, anon;

-- ---- the notice ----------------------------------------------------------------------------------------------------
alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in (
  'reservation_attention', 'refund_needs_bank_details', 'refund_needs_attention', 'email_failed', 'repair_urgent', 'repair_overdue',
  'guest_cancelled', 'website_booking', 'no_show', 'room_dirty_arrival', 'payment_unverified', 'guest_change_request'));

create function notify_guest_change_request() returns trigger language plpgsql security definer set search_path = public as $$
declare v_ref text;
begin
  select booking_reference into v_ref from reservations where id = new.reservation_id;
  perform enqueue_notification(new.property_id, 'guest_change_request', 'booking', 'attention',
    'Guest change request: ' || coalesce(v_ref, 'a booking'),
    case new.kind when 'dates' then 'The guest asks for new dates: ' || new.requested_arrival || ' to ' || new.requested_departure || '.'
                  when 'room' then 'The guest asks for a different room.' else 'The guest sent a request.' end
      || coalesce(' "' || left(new.message, 200) || '"', ''),
    '/app/requests', 'reservation.modify', 'guest_change_request', new.id, 'gcr:' || new.id);
  return null;
exception when others then
  raise warning 'change request notice failed: %', sqlerrm;
  return null;
end $$;
revoke all on function notify_guest_change_request() from public, anon, authenticated;
create trigger guest_change_requests_notify after insert on guest_change_requests
  for each row execute function notify_guest_change_request();

-- ---- what the guest may do now -------------------------------------------------------------------------------------
-- why_not: 'status' (not a confirmed booking), 'started' (already checked in), 'disabled' (the hotel has it off).
-- dates_open is false inside the notice window; contact edits and plain requests stay open until arrival.
create function guest_change_options(p_reservation_id uuid) returns jsonb
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
    when coalesce(v_pol ->> 'guest_changes', 'off') <> 'on' then 'disabled'
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
revoke all on function guest_change_options(uuid) from public, anon, authenticated;
grant execute on function guest_change_options(uuid) to service_role;

create function guest_update_contact(p_reservation_id uuid, p_phone text, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r reservations%rowtype; v_idem record; v_phone text := nullif(btrim(coalesce(p_phone, '')), ''); v_opt jsonb; v_old text;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if v_phone is null or length(v_phone) > 30 or v_phone !~ '^[0-9+()\-. ]{6,30}$' then raise exception 'POLICY_VIOLATION: phone' using errcode = 'P0001'; end if;
  select * into v_idem from idem_begin(r.tenant_id, 'guest_update_contact', p_idempotency_key, md5(concat_ws('|', p_reservation_id, v_phone)));
  if not v_idem.out_is_new then return v_idem.out_response; end if;
  v_opt := guest_change_options(r.id);
  if v_opt ->> 'why_not' is not null then raise exception 'INVALID_STATE: change %', v_opt ->> 'why_not' using errcode = 'P0001'; end if;
  select phone into v_old from guests where id = r.primary_guest_id;
  if v_old is distinct from v_phone then
    update guests set phone = v_phone, updated_at = now() where id = r.primary_guest_id;
    perform write_audit(r.tenant_id, r.property_id, null, 'guest.contact_updated', 'reservation', r.id, p_idempotency_key, jsonb_build_object('by', 'guest', 'field', 'phone'));
  end if;
  perform idem_finish(r.tenant_id, 'guest_update_contact', p_idempotency_key, jsonb_build_object('updated', true));
  return jsonb_build_object('updated', true);
end $$;
revoke all on function guest_update_contact(uuid, text, text) from public, anon, authenticated;
grant execute on function guest_update_contact(uuid, text, text) to service_role;

create function guest_request_change(p_reservation_id uuid, p_kind text, p_arrival date, p_departure date, p_message text, p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r reservations%rowtype; v_idem record; v_opt jsonb; v_msg text := nullif(btrim(coalesce(p_message, '')), ''); v_id uuid; v_today date;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_kind not in ('dates', 'room', 'other') or (v_msg is not null and length(v_msg) > 500) or (p_kind <> 'dates' and v_msg is null) then
    raise exception 'POLICY_VIOLATION: request' using errcode = 'P0001';
  end if;
  v_today := property_today(r.property_id);
  if p_kind = 'dates' and (p_arrival is null or p_departure is null or p_departure <= p_arrival or p_departure - p_arrival > 30 or p_arrival < v_today
                           or (p_arrival = r.arrival_date and p_departure = r.departure_date)) then
    raise exception 'POLICY_VIOLATION: dates' using errcode = 'P0001';
  end if;
  select * into v_idem from idem_begin(r.tenant_id, 'guest_request_change', p_idempotency_key,
    md5(concat_ws('|', p_reservation_id, p_kind, p_arrival, p_departure, coalesce(v_msg, ''))));
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  select * into r from reservations where id = p_reservation_id for update;   -- serialises two requests on one booking
  v_opt := guest_change_options(r.id);
  if v_opt ->> 'why_not' is not null then raise exception 'INVALID_STATE: change %', v_opt ->> 'why_not' using errcode = 'P0001'; end if;
  if p_kind in ('dates', 'room') and not (v_opt ->> 'dates_open')::boolean then raise exception 'INVALID_STATE: change window' using errcode = 'P0001'; end if;
  if v_opt -> 'open_request' is not null and v_opt -> 'open_request' <> 'null'::jsonb then raise exception 'INVALID_STATE: change open request' using errcode = 'P0001'; end if;

  insert into guest_change_requests (tenant_id, property_id, reservation_id, kind, requested_arrival, requested_departure, message)
  values (r.tenant_id, r.property_id, r.id, p_kind, case when p_kind = 'dates' then p_arrival end, case when p_kind = 'dates' then p_departure end, v_msg)
  returning id into v_id;
  perform write_audit(r.tenant_id, r.property_id, null, 'reservation.change_requested', 'reservation', r.id, p_idempotency_key,
                      jsonb_build_object('by', 'guest', 'kind', p_kind, 'request_id', v_id));
  perform idem_finish(r.tenant_id, 'guest_request_change', p_idempotency_key, jsonb_build_object('request_id', v_id));
  return jsonb_build_object('request_id', v_id);
end $$;
revoke all on function guest_request_change(uuid, text, date, date, text, text) from public, anon, authenticated;
grant execute on function guest_request_change(uuid, text, date, date, text, text) to service_role;

create function guest_withdraw_change_request(p_reservation_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q guest_change_requests%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  update guest_change_requests set status = 'withdrawn', resolved_at = now()
   where reservation_id = p_reservation_id and status = 'open' returning * into q;
  if q.id is null then return jsonb_build_object('withdrawn', false); end if;
  perform write_audit(q.tenant_id, q.property_id, null, 'reservation.change_withdrawn', 'reservation', q.reservation_id, null, jsonb_build_object('by', 'guest', 'request_id', q.id));
  return jsonb_build_object('withdrawn', true);
end $$;
revoke all on function guest_withdraw_change_request(uuid) from public, anon, authenticated;
grant execute on function guest_withdraw_change_request(uuid) to service_role;

-- ---- staff -----------------------------------------------------------------------------------------------------------
create function resolve_change_request(p_request_id uuid, p_outcome text, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q guest_change_requests%rowtype; v_actor uuid; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into q from guest_change_requests where id = p_request_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(q.property_id, 'reservation.modify', 'NOT_FOUND');
  if p_outcome not in ('done', 'declined') or (v_note is not null and length(v_note) > 500) or (p_outcome = 'declined' and v_note is null) then
    raise exception 'POLICY_VIOLATION: outcome' using errcode = 'P0001';
  end if;
  select * into q from guest_change_requests where id = p_request_id for update;
  if q.status <> 'open' then raise exception 'INVALID_STATE: %', q.status using errcode = 'P0001'; end if;
  update guest_change_requests set status = p_outcome, resolution_note = v_note, resolved_at = now(), resolved_by = v_actor where id = q.id;
  perform write_audit(q.tenant_id, q.property_id, v_actor, 'reservation.change_resolved', 'reservation', q.reservation_id, null,
                      jsonb_build_object('request_id', q.id, 'outcome', p_outcome, 'kind', q.kind));
  return jsonb_build_object('request_id', q.id, 'status', p_outcome);
end $$;
revoke all on function resolve_change_request(uuid, text, text) from public, anon;
grant execute on function resolve_change_request(uuid, text, text) to authenticated;
