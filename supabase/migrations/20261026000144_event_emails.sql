-- 144 Events, part 5: emails to guests who book or buy on the website. A separate small queue (like the waiting list emails, 130), because the
-- booking email queue (015) is tied to room reservations.
--
-- What is sent (only for website bookings and orders, the ones that have a guest page; the guest's email is on the row):
--   venue_received   an enquiry was sent (nothing is held; the hotel will reply with a quote)
--   venue_held       the slot is held: online booking at once, or staff held an enquiry (the email shows the quote and the deposit to pay)
--   venue_confirmed  the booking became confirmed (deposit paid, or staff confirmed)
--   tickets_paid     a ticket order became paid (the tickets and their codes)
-- Each is sent at most once per booking or order (dedupe on kind and id). Like the experience answer email (136), these answer the guest's own
-- action, so they are not behind a switch. The link is a signed event link made by the app when it sends (the secret stays in the app), on the
-- hotel's verified domain; a hotel with no verified domain cannot send (the row fails after 5 tries and a person can see it in the table).
-- claim_event_emails and mark_event_email_result work like claim_waitlist_notices (130). Sent rows are purged after 90 days.

create table event_email_outbox (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  property_id     uuid not null references properties(id),
  kind            text not null check (kind in ('venue_received', 'venue_held', 'venue_confirmed', 'tickets_paid')),
  booking_id      uuid references venue_bookings(id) on delete cascade,
  order_id        uuid references ticket_orders(id) on delete cascade,
  to_email        text not null,
  status          text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sent_at         timestamptz,
  check ((booking_id is null) <> (order_id is null)),
  check ((kind = 'tickets_paid') = (order_id is not null))
);
create unique index event_email_once on event_email_outbox (kind, coalesce(booking_id, order_id));
create index event_email_due on event_email_outbox (next_attempt_at) where status in ('pending', 'sending');
alter table event_email_outbox enable row level security;   -- no policy: server only
revoke all on event_email_outbox from authenticated, anon;

create function enqueue_event_email(p_kind text, p_booking uuid, p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b venue_bookings%rowtype; o ticket_orders%rowtype; v_email text;
begin
  if p_booking is not null then
    select * into b from venue_bookings where id = p_booking;
    if not found or b.source <> 'website' then return; end if;
    v_email := nullif(btrim(coalesce(b.contact_email, '')), '');
    if v_email is null then return; end if;
    insert into event_email_outbox (tenant_id, property_id, kind, booking_id, to_email) values (b.tenant_id, b.property_id, p_kind, b.id, v_email) on conflict do nothing;
  else
    select * into o from ticket_orders where id = p_order;
    if not found or o.source <> 'website' then return; end if;
    v_email := nullif(btrim(coalesce(o.buyer_email, '')), '');
    if v_email is null then return; end if;
    insert into event_email_outbox (tenant_id, property_id, kind, order_id, to_email) values (o.tenant_id, o.property_id, p_kind, o.id, v_email) on conflict do nothing;
  end if;
end $$;
revoke all on function enqueue_event_email(text, uuid, uuid) from public, anon, authenticated;

create function venue_booking_email_trigger() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'tentative' and old.status = 'enquiry' then perform enqueue_event_email('venue_held', new.id, null);
  elsif new.status = 'confirmed' and old.status <> 'confirmed' then perform enqueue_event_email('venue_confirmed', new.id, null);
  end if;
  return new;
end $$;
create trigger venue_bookings_email after update of status on venue_bookings for each row execute function venue_booking_email_trigger();

create function ticket_order_email_trigger() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'paid' and (tg_op = 'INSERT' or old.status <> 'paid') then perform enqueue_event_email('tickets_paid', null, new.id); end if;
  return new;
end $$;
create trigger ticket_orders_email after insert or update of status on ticket_orders for each row execute function ticket_order_email_trigger();

-- The enquiry email is queued by the function that makes the enquiry (142's body with one added line).
create or replace function guest_request_venue(
  p_host text, p_venue uuid, p_starts timestamp, p_ends timestamp, p_event_type text, p_title text, p_name text, p_email text, p_phone text,
  p_attendees integer, p_note text, p_mode text, p_key text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_property uuid; v_prop properties%rowtype; v_venue hotel_venues%rowtype; v_idem record; v_hash text; v_id uuid; v_ref text; v_t jsonb; v_amt jsonb; v_result jsonb;
  v_name text := btrim(coalesce(p_name, '')); v_email text := nullif(btrim(coalesce(p_email, '')), ''); v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_title text := btrim(coalesce(p_title, '')); v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_type text := coalesce(nullif(btrim(coalesce(p_event_type, '')), ''), 'other');
  v_now timestamp; v_lead interval;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  select * into v_prop from properties where id = v_property;
  select * into v_venue from hotel_venues where id = p_venue and property_id = v_property and is_active;
  if not found then raise exception 'NOT_FOUND: venue' using errcode = 'P0001'; end if;
  if p_mode is null or p_mode not in ('enquiry', 'book') then raise exception 'POLICY_VIOLATION: mode' using errcode = 'P0001'; end if;
  if p_mode = 'book' and not v_venue.bookable_online then raise exception 'POLICY_VIOLATION: not bookable online' using errcode = 'P0001'; end if;
  if v_type not in ('wedding', 'conference', 'meeting', 'birthday', 'party', 'other') then raise exception 'POLICY_VIOLATION: event type' using errcode = 'P0001'; end if;
  if length(v_name) not between 1 and 80 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if length(v_title) > 80 then raise exception 'POLICY_VIOLATION: title' using errcode = 'P0001'; end if;
  if v_email is null or not (length(v_email) <= 120 and v_email ~ '^[^@ ]+@[^@ ]+\.[^@ ]+$') then raise exception 'POLICY_VIOLATION: email' using errcode = 'P0001'; end if;
  if v_phone is not null and length(v_phone) not between 5 and 40 then raise exception 'POLICY_VIOLATION: phone' using errcode = 'P0001'; end if;
  if v_note is not null and length(v_note) > 500 then raise exception 'POLICY_VIOLATION: note' using errcode = 'P0001'; end if;
  if p_starts is null or p_ends is null or p_starts >= p_ends or p_ends > p_starts + interval '14 days' then raise exception 'POLICY_VIOLATION: times' using errcode = 'P0001'; end if;
  v_now := property_local_now(v_property);
  v_lead := case when p_mode = 'book' then interval '48 hours' else interval '0' end;
  if p_starts <= v_now + v_lead then raise exception 'POLICY_VIOLATION: too soon' using errcode = 'P0001'; end if;
  if p_starts > v_now + interval '540 days' then raise exception 'POLICY_VIOLATION: too far' using errcode = 'P0001'; end if;
  if p_attendees is null or p_attendees < 1 or p_attendees > v_venue.capacity then raise exception 'POLICY_VIOLATION: attendees' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', v_property, p_venue, p_starts, p_ends, v_type, v_name, v_email, coalesce(v_phone, ''), p_attendees, p_mode));
  select * into v_idem from idem_begin(v_prop.tenant_id, 'guest_request_venue', p_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  if (select count(*) from venue_bookings where property_id = v_property and source = 'website' and lower(contact_email) = lower(v_email)
         and (status = 'enquiry' or (status = 'tentative' and hold_expires_at > now()))) >= 3 then
    raise exception 'POLICY_VIOLATION: too many open' using errcode = 'P0001';
  end if;

  v_t := event_terms(v_property);
  v_ref := venue_booking_new_reference(v_property);
  insert into venue_bookings (tenant_id, property_id, venue_id, reference, status, source, event_type, title, contact_name, contact_email, contact_phone,
                              attendees, starts_at, ends_at, note, currency, tax_percent, service_percent, deposit_percent)
  values (v_prop.tenant_id, v_property, p_venue, v_ref, 'enquiry', 'website', v_type, v_title, v_name, v_email, v_phone, p_attendees, p_starts, p_ends, v_note,
          v_prop.currency, (v_t ->> 'tax_percent')::numeric, (v_t ->> 'service_percent')::numeric, (v_t ->> 'deposit_percent')::integer)
  returning id into v_id;

  if p_mode = 'book' then
    v_amt := venue_hire_amount(p_venue, p_starts, p_ends);
    insert into venue_booking_lines (tenant_id, property_id, booking_id, kind, description, quantity, unit_amount_minor)
    values (v_prop.tenant_id, v_property, v_id, 'venue', left('Hire of ' || v_venue.name || ', ' || (v_amt ->> 'hours') || ' hours', 120), 1, (v_amt ->> 'amount_minor')::bigint);
    perform venue_booking_recalc(v_id);
    perform venue_booking_hold_internal(v_id, (v_t ->> 'hold_hours')::integer);
  end if;

  v_result := jsonb_build_object('booking_id', v_id, 'reference', v_ref, 'status', (select status from venue_bookings where id = v_id));
  if p_mode = 'enquiry' then perform enqueue_event_email('venue_received', v_id, null); end if;
  perform idem_finish(v_prop.tenant_id, 'guest_request_venue', p_key, v_result);
  perform write_audit(v_prop.tenant_id, v_property, null, 'venue_booking.requested', 'venue_booking', v_id, p_key,
                      jsonb_build_object('reference', v_ref, 'venue', v_venue.name, 'mode', p_mode, 'status', v_result ->> 'status'));
  return v_result;
end $$;
revoke all on function guest_request_venue(text, uuid, timestamp, timestamp, text, text, text, text, text, integer, text, text, text) from public, anon, authenticated;
grant execute on function guest_request_venue(text, uuid, timestamp, timestamp, text, text, text, text, text, integer, text, text, text) to service_role;

create function claim_event_emails(p_limit integer default 10) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
  with picked as (
    select id from event_email_outbox
     where attempts < 5
       and ((status = 'pending' and next_attempt_at <= now()) or (status = 'sending' and updated_at < now() - interval '10 minutes'))
     order by next_attempt_at, created_at
     limit p_limit
     for update skip locked),
  claimed as (
    update event_email_outbox d set status = 'sending', attempts = d.attempts + 1, updated_at = now()
      from picked where d.id = picked.id
    returning d.id, d.kind, d.to_email, d.attempts, d.booking_id, d.order_id, d.tenant_id, d.property_id)
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'kind', c.kind, 'to_email', c.to_email, 'attempt', c.attempts,
           'target_id', coalesce(c.booking_id, c.order_id),
           'site_host', (select d.host from tenant_domains d
                          where d.tenant_id = c.tenant_id and d.verified_at is not null and (d.property_id is null or d.property_id = c.property_id)
                          order by (d.property_id is not null) desc, d.host limit 1),
           'view', case when c.booking_id is not null then guest_venue_booking(c.booking_id) else guest_ticket_order(c.order_id) end)
           order by c.attempts, c.id), '[]'::jsonb)
    into v_out from claimed c;
  return v_out;
end $$;
revoke all on function claim_event_emails(integer) from public, anon, authenticated;
grant execute on function claim_event_emails(integer) to service_role;

create function mark_event_email_result(p_id uuid, p_ok boolean, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
declare d event_email_outbox%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into d from event_email_outbox where id = p_id for update;
  if not found or d.status <> 'sending' then return; end if;
  if p_ok then
    update event_email_outbox set status = 'sent', sent_at = now(), last_error = null, updated_at = now() where id = p_id;
  elsif d.attempts >= 5 then
    update event_email_outbox set status = 'failed', last_error = left(coalesce(p_error, 'failed'), 500), updated_at = now() where id = p_id;
  else
    update event_email_outbox set status = 'pending', last_error = left(coalesce(p_error, 'failed'), 500),
           next_attempt_at = now() + (d.attempts * interval '5 minutes'), updated_at = now() where id = p_id;
  end if;
end $$;
revoke all on function mark_event_email_result(uuid, boolean, text) from public, anon, authenticated;
grant execute on function mark_event_email_result(uuid, boolean, text) to service_role;

create or replace function purge_old_operational_data() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_rl integer; v_em integer; v_idem integer; v_wl integer; v_dg integer; v_cm integer; v_ee integer;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  delete from rate_limit_hits where window_start < now() - interval '2 days';
  get diagnostics v_rl = row_count;
  delete from email_outbox where status = 'sent' and sent_at < now() - interval '90 days';
  get diagnostics v_em = row_count;
  delete from idempotency_keys where created_at < now() - interval '30 days';
  get diagnostics v_idem = row_count;
  delete from waitlist_requests where departure_date < current_date - 30;
  get diagnostics v_wl = row_count;
  delete from digest_outbox where status = 'sent' and sent_at < now() - interval '30 days';
  get diagnostics v_dg = row_count;
  delete from contact_messages where created_at < now() - interval '90 days';
  get diagnostics v_cm = row_count;
  delete from event_email_outbox where status = 'sent' and sent_at < now() - interval '90 days';
  get diagnostics v_ee = row_count;
  return jsonb_build_object('rate_limit_rows', v_rl, 'emails', v_em, 'idempotency_keys', v_idem, 'waitlist', v_wl, 'digests', v_dg,
                            'contact_messages', v_cm, 'event_emails', v_ee);
end $$;
