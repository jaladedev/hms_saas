-- 015 Guest emails (durable outbox), rate limits, and link re-issue. service_role only.
--
-- Outbox: rows are written by triggers in the same transaction as the change they report, so an email
-- can never be lost between "the hold exists" and "we tried to send": if the transaction rolls back,
-- so does the email. A worker (the app's maintenance route) claims rows with FOR UPDATE SKIP LOCKED,
-- sends, and reports the result. Failures retry with backoff up to 5 attempts, then stay 'failed' for
-- staff. A row stuck in 'sending' for 10 minutes (worker died) is claimed again; the sender passes the
-- row id as the provider's idempotency key, so a re-claim after a successful send cannot double-send.
--
-- Only website bookings email the guest: booked_held when the hold is created, booking_confirmed when
-- payment confirms it, refund_processed when a refund succeeds, booking_link when the guest asks for
-- their link again. Staff-entered bookings send nothing.
--
-- The email never carries the booking token: the app mints it at send time (the secret lives only in
-- the app), using the hotel's verified domain that claim_emails returns as site_host.
--
-- Rate limits are fixed-window counters keyed by an opaque string the app builds (a keyed hash of the
-- client IP or email, never the raw value). Attempts over the limit are still counted.

create table email_outbox (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id),
  reservation_id  uuid not null references reservations(id),
  kind            text not null check (kind in ('booking_held', 'booking_confirmed', 'booking_link', 'refund_processed')),
  to_email        text not null,
  payload         jsonb not null default '{}'::jsonb,
  dedupe_key      text,
  status          text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create unique index email_outbox_dedupe on email_outbox (kind, dedupe_key) where dedupe_key is not null;
create index email_outbox_due on email_outbox (next_attempt_at) where status in ('pending', 'sending');
alter table email_outbox enable row level security;   -- no policy: server only
revoke all on email_outbox from authenticated, anon;

create table rate_limit_hits (
  key          text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (key, window_start)
);
alter table rate_limit_hits enable row level security;   -- no policy: server only
revoke all on rate_limit_hits from authenticated, anon;

-- ---- enqueue (internal) -------------------------------------------------------------------
create function enqueue_booking_email(p_reservation uuid, p_kind text, p_dedupe text, p_payload jsonb default '{}'::jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare r reservations%rowtype; v_email text; v_n integer;
begin
  select * into r from reservations where id = p_reservation;
  if not found then return false; end if;
  select lower(trim(email)) into v_email from guests where id = r.primary_guest_id;
  if v_email is null or v_email = '' then return false; end if;
  insert into email_outbox (tenant_id, reservation_id, kind, to_email, payload, dedupe_key)
  values (r.tenant_id, r.id, p_kind, v_email, coalesce(p_payload, '{}'::jsonb), p_dedupe)
  on conflict (kind, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end $$;
revoke all on function enqueue_booking_email(uuid, text, text, jsonb) from public, anon, authenticated;

create function reservations_email_trigger() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.source <> 'website' then return null; end if;
  if tg_op = 'INSERT' and new.reservation_status = 'pending' then
    perform enqueue_booking_email(new.id, 'booking_held', 'held:' || new.id);
  elsif tg_op = 'UPDATE' and new.reservation_status = 'confirmed' and old.reservation_status in ('pending', 'expired') then
    perform enqueue_booking_email(new.id, 'booking_confirmed', 'confirmed:' || new.id);
  end if;
  return null;
end $$;
create trigger reservations_email_ins after insert on reservations
  for each row execute function reservations_email_trigger();
create trigger reservations_email_upd after update of reservation_status on reservations
  for each row when (old.reservation_status is distinct from new.reservation_status)
  execute function reservations_email_trigger();

create function refunds_email_trigger() returns trigger language plpgsql security definer set search_path = public as $$
declare v_source text;
begin
  select source into v_source from reservations where id = new.reservation_id;
  if v_source = 'website' then
    perform enqueue_booking_email(new.reservation_id, 'refund_processed', 'refund:' || new.id,
                                  jsonb_build_object('amount_minor', new.amount_minor, 'currency', new.currency));
  end if;
  return null;
end $$;
create trigger refunds_email_upd after update of refund_status on refunds
  for each row when (new.refund_status = 'succeeded' and old.refund_status is distinct from 'succeeded')
  execute function refunds_email_trigger();

-- ---- worker functions ---------------------------------------------------------------------
create function claim_emails(p_limit integer default 10) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001';
  end if;
  with picked as (
    select id from email_outbox
     where attempts < 5
       and ((status = 'pending' and next_attempt_at <= now())
         or (status = 'sending' and updated_at < now() - interval '10 minutes'))
     order by next_attempt_at, created_at
     limit p_limit
     for update skip locked),
  claimed as (
    update email_outbox e set status = 'sending', attempts = e.attempts + 1, updated_at = now()
      from picked where e.id = picked.id
    returning e.id, e.kind, e.to_email, e.payload, e.attempts, e.reservation_id, e.tenant_id)
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'kind', c.kind, 'to_email', c.to_email, 'payload', c.payload, 'attempt', c.attempts,
           'site_host', (select d.host from tenant_domains d
                          where d.tenant_id = c.tenant_id and d.verified_at is not null
                            and (d.property_id is null or d.property_id = (select property_id from reservations where id = c.reservation_id))
                          order by (d.property_id is not null) desc, d.host limit 1),
           'booking', guest_booking_status(c.reservation_id)) order by c.attempts, c.id), '[]'::jsonb)
    into v_out from claimed c;
  return v_out;
end $$;

create function mark_email_result(p_id uuid, p_ok boolean, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
declare e email_outbox%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into e from email_outbox where id = p_id for update;
  if not found or e.status <> 'sending' then return; end if;
  if p_ok then
    update email_outbox set status = 'sent', sent_at = now(), last_error = null, updated_at = now() where id = p_id;
  elsif e.attempts >= 5 then
    update email_outbox set status = 'failed', last_error = left(coalesce(p_error, 'failed'), 500), updated_at = now() where id = p_id;
  else
    update email_outbox set status = 'pending', last_error = left(coalesce(p_error, 'failed'), 500),
           next_attempt_at = now() + (e.attempts * interval '5 minutes'), updated_at = now() where id = p_id;
  end if;
end $$;

-- A guest who lost their link asks for a new one with booking reference plus email. The answer never
-- says whether a booking matched (the app shows the same message either way); the boolean is for logs.
create function request_booking_link(p_host text, p_reference text, p_email text) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_property uuid; v_res uuid;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.tenant_id, h.property_id into v_tenant, v_property from resolve_host(p_host) h;
  if p_reference is null or p_email is null or length(p_reference) > 40 or length(p_email) > 254 then return false; end if;
  select r.id into v_res
    from reservations r join guests g on g.id = r.primary_guest_id
   where r.tenant_id = v_tenant and r.property_id = v_property
     and upper(r.booking_reference) = upper(trim(p_reference)) and lower(trim(g.email)) = lower(trim(p_email));
  if v_res is null then return false; end if;
  return enqueue_booking_email(v_res, 'booking_link', null);
end $$;

-- ---- rate limits --------------------------------------------------------------------------
create function consume_rate_limit(p_key text, p_limit integer, p_window_seconds integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_start timestamptz; v_hits integer;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if p_key is null or length(p_key) = 0 or length(p_key) > 200 or p_limit is null or p_limit < 1 or p_limit > 100000
     or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'POLICY_VIOLATION: rate limit arguments' using errcode = 'P0001';
  end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into rate_limit_hits (key, window_start, hits) values (p_key, v_start, 1)
  on conflict (key, window_start) do update set hits = rate_limit_hits.hits + 1
  returning hits into v_hits;
  return jsonb_build_object('allowed', v_hits <= p_limit, 'hits', v_hits, 'limit', p_limit,
                            'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_start + p_window_seconds * interval '1 second' - now())))::integer));
end $$;

-- Housekeeping for the maintenance route: old rate-limit windows and old finished emails.
create function purge_old_operational_data() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_rl integer; v_em integer;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  delete from rate_limit_hits where window_start < now() - interval '2 days';
  get diagnostics v_rl = row_count;
  delete from email_outbox where status = 'sent' and sent_at < now() - interval '90 days';
  get diagnostics v_em = row_count;
  return jsonb_build_object('rate_limit_rows', v_rl, 'emails', v_em);
end $$;

revoke all on function claim_emails(integer), mark_email_result(uuid, boolean, text),
  request_booking_link(text, text, text), consume_rate_limit(text, integer, integer),
  purge_old_operational_data() from public, anon, authenticated;
grant execute on function claim_emails(integer), mark_email_result(uuid, boolean, text),
  request_booking_link(text, text, text), consume_rate_limit(text, integer, integer),
  purge_old_operational_data() to service_role;
