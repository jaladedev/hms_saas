-- 130 Optional email to a waiting guest when a room has freed up (builds on 124).
--
-- properties.waitlist_email_enabled: false by default (staff call guests themselves, as in 124). set_waitlist_email(property, enabled):
-- property.configure at that hotel (anyone else NOT_FOUND); null counts as off. The audit trigger lists the column.
--
-- queue_waitlist_notices(limit): system callers only (the maintenance job). For each hotel with it on, a request that is still 'waiting',
-- not yet emailed, with arrival today or later, and with a room free for its dates now (waitlist_free_rooms, the search rule) gets one row in
-- waitlist_notice_outbox and notified_at is set, in the same transaction, so a request is emailed at most once. A hotel with no verified
-- domain is skipped (the email needs a link to the site). The status stays 'waiting': staff still decide. The email says a room may be free
-- and that nothing is held; it links to the site's search for those dates. Returns how many were queued.
--
-- claim_waitlist_notices(limit) and mark_waitlist_notice_result(id, ok, error) work like claim_digests (129).
-- Rows go with their request (on delete cascade), so the 30 day purge of requests (124) also removes them.
-- waitlist_list now also returns notified_at.

alter table properties add column waitlist_email_enabled boolean not null default false;
alter table waitlist_requests add column notified_at timestamptz;

drop trigger properties_audit on properties;
create trigger properties_audit after insert or update or delete on properties
  for each row execute function audit_config_row('property', 'name,code,address,city,state,country_code,timezone,currency,check_in_time,check_out_time,status,phone,contact_email,intro,logo_path,theme,theme_primary,theme_font_display,theme_font_body,theme_radius,facilities,social_instagram,social_facebook,arrival_reminder_days,review_request_enabled,digest_email,waitlist_email_enabled');

create function set_waitlist_email(p_property uuid, p_enabled boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  update properties set waitlist_email_enabled = coalesce(p_enabled, false) where id = p_property;
end $$;
revoke all on function set_waitlist_email(uuid, boolean) from public, anon;
grant execute on function set_waitlist_email(uuid, boolean) to authenticated;

create table waitlist_notice_outbox (
  id              uuid primary key default gen_random_uuid(),
  waitlist_id     uuid not null unique references waitlist_requests(id) on delete cascade,
  tenant_id       uuid not null references tenants(id),
  property_id     uuid not null references properties(id),
  to_email        text not null,
  payload         jsonb not null,
  status          text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create index waitlist_notice_due on waitlist_notice_outbox (next_attempt_at) where status in ('pending', 'sending');
alter table waitlist_notice_outbox enable row level security;   -- no policy: server only
revoke all on waitlist_notice_outbox from authenticated, anon;

create function queue_waitlist_notices(p_limit integer default 100) returns integer
language plpgsql security definer set search_path = public as $$
declare w record; v_host text; v_queued integer := 0;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  for w in
    select q.id, q.tenant_id, q.property_id, q.room_type_id, q.arrival_date, q.departure_date, q.adults, q.children, q.email, q.guest_name,
           p.name as hotel, rt.name as room_type
      from waitlist_requests q
      join properties p on p.id = q.property_id and p.waitlist_email_enabled
      join room_types rt on rt.id = q.room_type_id
     where q.status = 'waiting' and q.notified_at is null and q.arrival_date >= property_today(q.property_id)
       and waitlist_free_rooms(q.property_id, q.room_type_id, q.arrival_date, q.departure_date) > 0
     order by q.created_at, q.id
     limit greatest(least(coalesce(p_limit, 100), 500), 1)
     for update of q skip locked
  loop
    select d.host into v_host from tenant_domains d
     where d.tenant_id = w.tenant_id and d.verified_at is not null and (d.property_id is null or d.property_id = w.property_id)
     order by (d.property_id is not null) desc, d.host limit 1;
    continue when v_host is null;
    insert into waitlist_notice_outbox (waitlist_id, tenant_id, property_id, to_email, payload)
    values (w.id, w.tenant_id, w.property_id, w.email,
            jsonb_build_object('hotel', w.hotel, 'room_type', w.room_type, 'guest_name', w.guest_name, 'arrival', w.arrival_date,
                               'departure', w.departure_date, 'adults', w.adults, 'children', w.children, 'site_host', v_host));
    update waitlist_requests set notified_at = now() where id = w.id;
    v_queued := v_queued + 1;
  end loop;
  return v_queued;
end $$;
revoke all on function queue_waitlist_notices(integer) from public, anon, authenticated;
grant execute on function queue_waitlist_notices(integer) to service_role;

create function claim_waitlist_notices(p_limit integer default 10) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
  with picked as (
    select id from waitlist_notice_outbox
     where attempts < 5
       and ((status = 'pending' and next_attempt_at <= now()) or (status = 'sending' and updated_at < now() - interval '10 minutes'))
     order by next_attempt_at, created_at
     limit p_limit
     for update skip locked),
  claimed as (
    update waitlist_notice_outbox d set status = 'sending', attempts = d.attempts + 1, updated_at = now()
      from picked where d.id = picked.id
    returning d.id, d.to_email, d.payload, d.attempts)
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'to_email', c.to_email, 'payload', c.payload, 'attempt', c.attempts) order by c.attempts, c.id), '[]'::jsonb)
    into v_out from claimed c;
  return v_out;
end $$;
revoke all on function claim_waitlist_notices(integer) from public, anon, authenticated;
grant execute on function claim_waitlist_notices(integer) to service_role;

create function mark_waitlist_notice_result(p_id uuid, p_ok boolean, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
declare d waitlist_notice_outbox%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into d from waitlist_notice_outbox where id = p_id for update;
  if not found or d.status <> 'sending' then return; end if;
  if p_ok then
    update waitlist_notice_outbox set status = 'sent', sent_at = now(), last_error = null, updated_at = now() where id = p_id;
  elsif d.attempts >= 5 then
    update waitlist_notice_outbox set status = 'failed', last_error = left(coalesce(p_error, 'failed'), 500), updated_at = now() where id = p_id;
  else
    update waitlist_notice_outbox set status = 'pending', last_error = left(coalesce(p_error, 'failed'), 500),
           next_attempt_at = now() + (d.attempts * interval '5 minutes'), updated_at = now() where id = p_id;
  end if;
end $$;
revoke all on function mark_waitlist_notice_result(uuid, boolean, text) from public, anon, authenticated;
grant execute on function mark_waitlist_notice_result(uuid, boolean, text) to service_role;

create or replace function waitlist_list(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission(p_property, 'reservation.view', 'NOT_FOUND');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', w.id, 'room_type', rt.name, 'arrival_date', w.arrival_date, 'departure_date', w.departure_date,
      'adults', w.adults, 'children', w.children, 'guest_name', w.guest_name, 'email', w.email, 'phone', w.phone,
      'status', w.status, 'created_at', w.created_at, 'notified_at', w.notified_at,
      'rooms_free_now', waitlist_free_rooms(w.property_id, w.room_type_id, w.arrival_date, w.departure_date))
      order by w.arrival_date, w.created_at)
    from waitlist_requests w join room_types rt on rt.id = w.room_type_id
   where w.property_id = p_property and w.status in ('waiting', 'contacted') and w.arrival_date >= property_today(p_property)
  ), '[]'::jsonb);
end $$;
