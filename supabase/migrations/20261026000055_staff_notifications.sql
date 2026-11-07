-- 048 Staff notifications: the inbox behind /app/notifications.
--
-- A notification is one row about one thing that needs a person: money that cannot be settled by itself, a failed
-- guest email, an urgent repair, a guest who cancelled, a dirty room with a guest arriving. Rows are written by triggers in the
-- same transaction as the change, so a rolled-back change leaves no notification, and a notification that fails to
-- write never fails the change (the trigger catches it and raises a warning).
--
-- WHO SEES WHAT. Each row names the permission needed to see it (payment.verify, refund.approve, reservation.view,
-- maintenance.manage, housekeeping.view ...) and it is checked with has_permission at the property when the inbox is
-- read, so a person who loses a role stops seeing its notifications and another hotel's people never see them.
-- The tables have no policies and no grants: the only doors are the four functions below.
--   notification_inbox(limit, before, only_unread, category)  newest first, with this person's read flag and unread counts
--   notification_unread_count()                               for the sidebar
--   mark_notification_read(id)                                 one notification, for this person only
--   mark_notifications_read(category)                          everything visible and unread, optionally one category
-- Read state is per person (notification_reads); marking a row read never changes what anyone else sees.
--
-- SOURCES (kind, category, who sees it):
--   reservation_attention   money      payment.verify    a reservation's attention_reason is set (paid but the room is gone, paid after cancel, an unpaid cancellation charge ...)
--   refund_needs_bank_details, refund_needs_attention   money   refund.approve   from the refund audit rows
--   email_failed            money      reservation.modify  a guest email used up its five attempts
--   repair_urgent           maintenance  maintenance.manage  a repair raised, or raised to, high or urgent priority
--   repair_overdue          maintenance  maintenance.manage  a live repair past its due time (raised by notifications_sweep, from the cron route)
--   guest_cancelled, website_booking, no_show   booking   reservation.view  from the cancellation audit row, a website booking confirmed, the no-show audit row
--   room_dirty_arrival      housekeeping housekeeping.view  a room turns dirty while a guest is due to arrive in it today
-- notifications_sweep() (service_role) raises the overdue repairs and deletes notifications older than 90 days.

create table notifications (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  property_id uuid not null,
  kind        text not null check (kind in ('reservation_attention', 'refund_needs_bank_details', 'refund_needs_attention', 'email_failed',
                                            'repair_urgent', 'repair_overdue', 'guest_cancelled', 'website_booking', 'no_show', 'room_dirty_arrival')),
  category    text not null check (category in ('money', 'maintenance', 'booking', 'housekeeping')),
  severity    text not null default 'info' check (severity in ('info', 'attention', 'urgent')),
  title       text not null check (length(title) between 1 and 160),
  body        text check (body is null or length(body) <= 500),
  link        text check (link is null or link ~ '^/app(/[A-Za-z0-9_-]+)*$'),
  permission  text not null,
  entity_type text,
  entity_id   uuid,
  dedupe_key  text,
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id)
);
create unique index notifications_dedupe on notifications (tenant_id, dedupe_key) where dedupe_key is not null;
create index notifications_property_time on notifications (property_id, created_at desc);

create table notification_reads (
  notification_id uuid not null references notifications (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (notification_id, user_id)
);
create index notification_reads_user on notification_reads (user_id);

alter table notifications enable row level security;
alter table notification_reads enable row level security;
revoke all on notifications, notification_reads from public, anon, authenticated;

-- ---- Writing -------------------------------------------------------------------------------------------------------

create function enqueue_notification(p_property uuid, p_kind text, p_category text, p_severity text, p_title text, p_body text,
                                     p_link text, p_permission text, p_entity_type text, p_entity_id uuid, p_dedupe text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_n integer;
begin
  select tenant_id into v_tenant from properties where id = p_property;
  if v_tenant is null then return false; end if;
  insert into notifications (tenant_id, property_id, kind, category, severity, title, body, link, permission, entity_type, entity_id, dedupe_key)
  values (v_tenant, p_property, p_kind, p_category, p_severity, left(p_title, 160), left(p_body, 500), p_link, p_permission, p_entity_type, p_entity_id, p_dedupe)
  on conflict (tenant_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
exception when others then
  -- A notification must never undo the change that caused it.
  raise warning 'enqueue_notification failed: % (%)', sqlerrm, sqlstate;
  return false;
end $$;
revoke all on function enqueue_notification(uuid, text, text, text, text, text, text, text, text, uuid, text) from public, anon, authenticated;

-- ---- Sources -------------------------------------------------------------------------------------------------------

-- Money: a reservation that needs a person
create function notify_reservation_attention() returns trigger
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
revoke all on function notify_reservation_attention() from public, anon, authenticated;
create trigger reservations_notify_attention after update of attention_reason on reservations
  for each row when (new.attention_reason is not null and old.attention_reason is distinct from new.attention_reason)
  execute function notify_reservation_attention();

-- Money: a guest email that gave up
create function notify_email_failed() returns trigger
language plpgsql security definer set search_path = public as $$
declare r reservations%rowtype;
begin
  select * into r from reservations where id = new.reservation_id;
  if found then
    perform enqueue_notification(r.property_id, 'email_failed', 'money', 'attention', 'A guest email could not be sent: ' || r.booking_reference,
      'The ' || replace(new.kind, '_', ' ') || ' email failed after ' || new.attempts || ' tries. Check the address and send it again from the guest emails page.',
      '/app/emails', 'reservation.modify', 'reservation', r.id, 'email:' || new.id);
  end if;
  return null;
end $$;
revoke all on function notify_email_failed() from public, anon, authenticated;
create trigger email_outbox_notify_failed after update of status on email_outbox
  for each row when (new.status = 'failed' and old.status is distinct from 'failed')
  execute function notify_email_failed();

-- Maintenance: a repair raised, or raised to, high or urgent
create function notify_repair_urgent() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_where text;
begin
  select coalesce('room ' || (select room_number from rooms where id = new.room_id), new.location, 'the hotel') into v_where;
  perform enqueue_notification(new.property_id, 'repair_urgent', 'maintenance', case when new.priority = 'urgent' then 'urgent' else 'attention' end,
    case when new.priority = 'urgent' then 'Urgent repair: ' else 'High priority repair: ' end || new.title,
    'At ' || v_where || '.', '/app/maintenance/' || new.id, 'maintenance.manage', 'maintenance_request', new.id,
    'repair:' || new.id || ':' || new.priority);
  return null;
end $$;
revoke all on function notify_repair_urgent() from public, anon, authenticated;
create trigger maintenance_notify_urgent_ins after insert on maintenance_requests
  for each row when (new.priority in ('high', 'urgent') and new.status in ('open', 'in_progress'))
  execute function notify_repair_urgent();
create trigger maintenance_notify_urgent_upd after update of priority on maintenance_requests
  for each row when (new.priority in ('high', 'urgent') and old.priority is distinct from new.priority and new.status in ('open', 'in_progress'))
  execute function notify_repair_urgent();

-- Booking and money events that are recorded as audit rows
create function notify_from_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare r reservations%rowtype; f refunds%rowtype;
begin
  if new.property_id is null or new.entity_id is null then return null; end if;
  if new.action in ('refund.needs_bank_details', 'refund.needs_attention') then
    select * into f from refunds where id = new.entity_id;
    if found then
      select * into r from reservations where id = f.reservation_id;
      perform enqueue_notification(f.property_id,
        case new.action when 'refund.needs_bank_details' then 'refund_needs_bank_details' else 'refund_needs_attention' end, 'money',
        case new.action when 'refund.needs_bank_details' then 'attention' else 'urgent' end,
        case new.action when 'refund.needs_bank_details' then 'A refund needs the guest''s bank details' else 'A refund needs attention' end
          || coalesce(': ' || r.booking_reference, ''),
        case new.action when 'refund.needs_bank_details' then 'Paystack cannot pay this refund without a bank account. Add the details on the refund.'
                        else 'The refund did not complete by itself. Open it to see why.' end,
        '/app/refunds', 'refund.approve', 'refund', f.id, 'audit:' || new.id);
    end if;
  elsif new.action = 'reservation.cancelled' and new.metadata ->> 'by' = 'guest' then
    select * into r from reservations where id = new.entity_id;
    if found then
      perform enqueue_notification(r.property_id, 'guest_cancelled', 'booking', 'info', 'The guest cancelled: ' || r.booking_reference,
        'Arrival was ' || r.arrival_date || ', departure ' || r.departure_date || '.',
        '/app/reservations/' || r.id, 'reservation.view', 'reservation', r.id, 'audit:' || new.id);
    end if;
  elsif new.action = 'reservation.no_show' then
    select * into r from reservations where id = new.entity_id;
    if found then
      perform enqueue_notification(r.property_id, 'no_show', 'booking', 'info', 'Marked as a no-show: ' || r.booking_reference,
        'The guest did not arrive on ' || r.arrival_date || '.', '/app/reservations/' || r.id, 'reservation.view', 'reservation', r.id, 'audit:' || new.id);
    end if;
  end if;
  return null;
end $$;
revoke all on function notify_from_audit() from public, anon, authenticated;
create trigger audit_logs_notify after insert on audit_logs
  for each row when (new.action in ('refund.needs_bank_details', 'refund.needs_attention', 'reservation.cancelled', 'reservation.no_show'))
  execute function notify_from_audit();

-- Booking: a website booking is confirmed (paid)
create function notify_website_booking() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_nights integer := new.departure_date - new.arrival_date;
begin
  perform enqueue_notification(new.property_id, 'website_booking', 'booking', 'info', 'New website booking: ' || new.booking_reference,
    v_nights || case when v_nights = 1 then ' night, ' else ' nights, ' end || new.arrival_date || ' to ' || new.departure_date || '.',
    '/app/reservations/' || new.id, 'reservation.view', 'reservation', new.id, 'confirmed:' || new.id);
  return null;
end $$;
revoke all on function notify_website_booking() from public, anon, authenticated;
create trigger reservations_notify_website after update of reservation_status on reservations
  for each row when (new.source = 'website' and new.reservation_status = 'confirmed' and old.reservation_status is distinct from 'confirmed')
  execute function notify_website_booking();

-- Housekeeping: a room turns dirty while a guest is due to arrive in it today
create function notify_room_dirty_arrival() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_today date := property_today(new.property_id); v_ref text; v_res uuid;
begin
  select r.id, r.booking_reference into v_res, v_ref
    from room_inventory_claims c
    join reservation_rooms rr on rr.id = c.reservation_room_id and rr.room_status = 'booked'
    join reservations r on r.id = rr.reservation_id
   where c.room_id = new.id and c.claim_type = 'stay' and c.status = 'active' and c.start_date = v_today
   limit 1;
  if v_res is not null then
    perform enqueue_notification(new.property_id, 'room_dirty_arrival', 'housekeeping', 'attention',
      'Room ' || new.room_number || ' is dirty and a guest arrives today', 'Booking ' || v_ref || ' is due in this room today. Clean and inspect it.',
      '/app/housekeeping', 'housekeeping.view', 'room', new.id, 'dirty:' || new.id || ':' || v_today);
  end if;
  return null;
end $$;
revoke all on function notify_room_dirty_arrival() from public, anon, authenticated;
create trigger rooms_notify_dirty after update of housekeeping_status on rooms
  for each row when (new.housekeeping_status = 'dirty' and old.housekeeping_status is distinct from 'dirty')
  execute function notify_room_dirty_arrival();

-- ---- Reading -------------------------------------------------------------------------------------------------------

create function notification_inbox(p_limit integer default 50, p_before timestamptz default null, p_only_unread boolean default false,
                                   p_category text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_rows jsonb; v_counts jsonb;
begin
  if v_uid is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 200
     or (p_category is not null and p_category not in ('money', 'maintenance', 'booking', 'housekeeping')) then
    raise exception 'POLICY_VIOLATION: arguments' using errcode = 'P0001';
  end if;

  with mine as (
    select n.*, p.name as property_name, (rd.user_id is not null) as is_read
      from notifications n
      join properties p on p.id = n.property_id
      left join notification_reads rd on rd.notification_id = n.id and rd.user_id = v_uid
     where has_permission(n.property_id, n.permission)
  )
  select coalesce((select jsonb_agg(jsonb_build_object(
           'id', id, 'property_id', property_id, 'property_name', property_name, 'kind', kind, 'category', category, 'severity', severity,
           'title', title, 'body', body, 'link', link, 'created_at', created_at, 'read', is_read) order by created_at desc, id)
         from (select * from mine
                where (p_before is null or created_at < p_before) and (p_category is null or category = p_category) and (not p_only_unread or not is_read)
                order by created_at desc, id limit p_limit) page), '[]'::jsonb),
         jsonb_build_object('total', count(*) filter (where not is_read),
                            'money', count(*) filter (where not is_read and category = 'money'),
                            'maintenance', count(*) filter (where not is_read and category = 'maintenance'),
                            'booking', count(*) filter (where not is_read and category = 'booking'),
                            'housekeeping', count(*) filter (where not is_read and category = 'housekeeping'))
    into v_rows, v_counts
    from mine;
  return jsonb_build_object('items', v_rows, 'unread', v_counts);
end $$;

create function notification_unread_count() returns integer
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return 0; end if;
  return (select count(*)::integer from notifications n
           where has_permission(n.property_id, n.permission)
             and not exists (select 1 from notification_reads rd where rd.notification_id = n.id and rd.user_id = v_uid));
end $$;

create function mark_notification_read(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); n notifications%rowtype;
begin
  if v_uid is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into n from notifications where id = p_id;
  if not found or not has_permission(n.property_id, n.permission) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  insert into notification_reads (notification_id, user_id) values (n.id, v_uid) on conflict do nothing;
end $$;

create function mark_notifications_read(p_category text default null) returns integer
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_n integer;
begin
  if v_uid is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_category is not null and p_category not in ('money', 'maintenance', 'booking', 'housekeeping') then
    raise exception 'POLICY_VIOLATION: arguments' using errcode = 'P0001';
  end if;
  insert into notification_reads (notification_id, user_id)
    select n.id, v_uid from notifications n
     where has_permission(n.property_id, n.permission) and (p_category is null or n.category = p_category)
    on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function notification_inbox(integer, timestamptz, boolean, text), notification_unread_count(),
  mark_notification_read(uuid), mark_notifications_read(text) from public, anon;
grant execute on function notification_inbox(integer, timestamptz, boolean, text), notification_unread_count(),
  mark_notification_read(uuid), mark_notifications_read(text) to authenticated;

-- ---- Sweep (cron) ----------------------------------------------------------------------------------------------------

create function notifications_sweep() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_overdue integer := 0; v_purged integer; m record;
begin
  for m in
    select q.*, coalesce('room ' || r.room_number, q.location, 'the hotel') as place
      from maintenance_requests q left join rooms r on r.id = q.room_id
     where q.status in ('open', 'in_progress') and q.due_at is not null and q.due_at < now()
  loop
    if enqueue_notification(m.property_id, 'repair_overdue', 'maintenance', 'attention', 'Repair overdue: ' || m.title, 'At ' || m.place || '.',
         '/app/maintenance/' || m.id, 'maintenance.manage', 'maintenance_request', m.id, 'overdue:' || m.id) then
      v_overdue := v_overdue + 1;
    end if;
  end loop;
  delete from notifications where created_at < now() - interval '90 days';
  get diagnostics v_purged = row_count;
  return jsonb_build_object('overdue_raised', v_overdue, 'purged', v_purged);
end $$;
revoke all on function notifications_sweep() from public, anon, authenticated;
grant execute on function notifications_sweep() to service_role;
