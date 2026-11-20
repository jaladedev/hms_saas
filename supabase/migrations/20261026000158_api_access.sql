-- 158 Public API and webhooks, first cut (TODO 8.9). Read-only API plus signed outgoing webhooks.
--
-- A hotel's owner or general manager (permission api.manage, new) makes API keys and webhook endpoints. The Next.js server (service role)
-- authenticates each /api/v1 call and sends each webhook; nothing here trusts a browser.
--   api_keys           name, prefix (the first characters, shown in lists), key_hash (sha256 of the whole key; the key itself is shown once, at
--                      creation, and never stored), scopes (availability.read, bookings.read, guests.read), per-minute rate limit (default 60),
--                      revoked_at. Up to 10 live keys a hotel. The hash column cannot be selected by anyone logged in.
--   api_calls          one row per call made with a key (method, path without the query string, status), append-only; rows older than 90 days
--                      are removed in passing. The per-minute rate limit counts these rows.
--   api_key_authenticate(hash)  service role only: the key's hotel and scopes, or why not (invalid, off, rate_limited with retry_after).
--   api_log_call(key, method, path, status)  service role only.
--   api_availability(property, arrival, departure, adults, children)  service role only: the same answer the booking website gets
--                      (search_availability), through the hotel's own verified booking domain. INVALID_STATE: no booking site when it has none.
--   api_bookings(property, from, to, status, limit, include_guest) / api_booking(property, reference, include_guest)  service role only:
--                      bookings by arrival date or one by reference; guest name and email only when the key has guests.read.
--   webhook_endpoints  an https address, the events it wants (booking.created, .confirmed, .cancelled, .checked_in, .checked_out, .no_show), a
--                      signing secret (shown once; the column cannot be selected by anyone logged in). Up to 5 a hotel.
--   webhook_deliveries a queue: one row per event per endpoint, with attempts and next attempt; sent, or failed after 6 tries. Payloads carry the
--                      booking reference, status and dates only, never guest details.
--   A trigger on reservations queues the events (never fails the booking: an error there is a warning).
--   claim_webhook_deliveries / mark_webhook_delivery  service role only (a claim leases a row for 5 minutes; a failure backs off 2^attempts minutes).
-- Plan flag api_access (enforced, Pro plan). With it off nothing is authenticated, nothing is queued, and keys and endpoints can still be read.
-- Not built: creating bookings through the API (bookings.write), per-key IP allow lists, webhook replay from the screen, an OpenAPI file.

-- ---- permission and flag ---------------------------------------------------------------------
insert into permissions (key) values ('api.manage');
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p where p.key = 'api.manage' and r.is_system and r.key in ('owner', 'general_manager');

create or replace function plan_enforced_flags() returns text[]
language sql immutable set search_path = public as $$
  select array['reports.export', 'online_payments', 'discounts', 'online_booking', 'guest_cancel', 'guest_changes', 'early_checkin',
               'housekeeping', 'maintenance', 'audit_log', 'branding', 'dynamic_pricing', 'sms_notifications', 'restaurant_pos', 'group_bookings', 'inventory',
               'guest_services', 'api_access']
$$;
revoke all on function plan_enforced_flags() from public, anon;
update plans set features = (select array_agg(distinct k order by k) from unnest(features || array['api_access']) k) where code = 'pro';

-- ---- tables ------------------------------------------------------------------------------------
create table api_keys (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null,
  property_id           uuid not null,
  name                  text not null check (char_length(btrim(name)) between 1 and 60),
  prefix                text not null check (char_length(prefix) = 8),
  key_hash              text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  scopes                text[] not null check (scopes <> '{}' and scopes <@ array['availability.read', 'bookings.read', 'guests.read']),
  rate_limit_per_minute integer not null default 60 check (rate_limit_per_minute between 1 and 600),
  created_by            uuid references auth.users (id) on delete set null,
  created_at            timestamptz not null default now(),
  last_used_at          timestamptz,
  revoked_at            timestamptz,
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  unique (tenant_id, property_id, id)
);

create table api_calls (
  id          bigint generated always as identity primary key,
  key_id      uuid not null references api_keys (id),
  property_id uuid not null,
  at          timestamptz not null default clock_timestamp(),
  method      text not null check (char_length(method) <= 10),
  path        text not null check (char_length(path) <= 200),
  status      integer not null check (status between 100 and 599)
);
create index api_calls_key_idx on api_calls (key_id, at desc);

create table webhook_endpoints (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  property_id uuid not null,
  url         text not null check (url ~ '^https://[^ "<>/?#]+(/[^ "<>]*)?$' and char_length(url) <= 200),
  events      text[] not null check (events <> '{}' and events <@ array['booking.created', 'booking.confirmed', 'booking.cancelled', 'booking.checked_in', 'booking.checked_out', 'booking.no_show']),
  secret      text not null,
  is_active   boolean not null default true,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  unique (tenant_id, property_id, id)
);

create table webhook_deliveries (
  id              uuid primary key default gen_random_uuid(),
  endpoint_id     uuid not null references webhook_endpoints (id),
  tenant_id       uuid not null,
  property_id     uuid not null,
  event           text not null,
  payload         jsonb not null,
  status          text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text check (last_error is null or char_length(last_error) <= 200),
  response_code   integer,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create index webhook_deliveries_due_idx on webhook_deliveries (next_attempt_at) where status = 'pending';
create index webhook_deliveries_endpoint_idx on webhook_deliveries (endpoint_id, created_at desc);

-- calls are a log: never edited; only rows older than 90 days may go
create function api_calls_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then raise exception 'api calls are never edited' using errcode = 'P0001'; end if;
  if old.at > now() - interval '90 days' then raise exception 'api calls are kept for 90 days' using errcode = 'P0001'; end if;
  return old;
end $$;
create trigger api_calls_guard before update or delete on api_calls for each row execute function api_calls_guard();

alter table api_keys enable row level security;
alter table api_calls enable row level security;
alter table webhook_endpoints enable row level security;
alter table webhook_deliveries enable row level security;
create policy api_keys_select on api_keys for select to authenticated using (has_permission(property_id, 'api.manage'));
create policy api_calls_select on api_calls for select to authenticated using (has_permission(property_id, 'api.manage'));
create policy webhook_endpoints_select on webhook_endpoints for select to authenticated using (has_permission(property_id, 'api.manage'));
create policy webhook_deliveries_select on webhook_deliveries for select to authenticated using (has_permission(property_id, 'api.manage'));
revoke all on api_keys, api_calls, webhook_endpoints, webhook_deliveries from anon, authenticated;
-- the secrets and the hash are not selectable: column grants leave them out
grant select (id, tenant_id, property_id, name, prefix, scopes, rate_limit_per_minute, created_by, created_at, last_used_at, revoked_at) on api_keys to authenticated;
grant select on api_calls to authenticated;
grant select (id, tenant_id, property_id, url, events, is_active, created_by, created_at, updated_at) on webhook_endpoints to authenticated;
grant select (id, endpoint_id, tenant_id, property_id, event, status, attempts, next_attempt_at, last_error, response_code, created_at, sent_at) on webhook_deliveries to authenticated;

-- ---- helper ----------------------------------------------------------------------------------------
create function api_require(p_property uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_prop properties%rowtype; v_actor uuid;
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'api.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(v_prop.tenant_id, 'api_access') then raise exception 'POLICY_VIOLATION: api off' using errcode = 'P0001'; end if;
  return v_actor;
end $$;
revoke all on function api_require(uuid) from public, anon, authenticated;

-- ---- keys (api.manage) ---------------------------------------------------------------------------------
create function api_key_create(p_property uuid, p_name text, p_scopes text[], p_limit integer default 60) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid; v_prop properties%rowtype; v_name text := btrim(coalesce(p_name, '')); v_prefix text; v_key text; v_id uuid;
  v_scopes text[];
begin
  v_actor := api_require(p_property);
  select * into v_prop from properties where id = p_property;
  if char_length(v_name) not between 1 and 60 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  select coalesce(array_agg(distinct s order by s), '{}') into v_scopes from unnest(coalesce(p_scopes, '{}')) s;
  if v_scopes = '{}' or not (v_scopes <@ array['availability.read', 'bookings.read', 'guests.read']) then raise exception 'POLICY_VIOLATION: scopes' using errcode = 'P0001'; end if;
  if 'guests.read' = any (v_scopes) and not ('bookings.read' = any (v_scopes)) then raise exception 'POLICY_VIOLATION: scopes' using errcode = 'P0001'; end if;
  if p_limit is null or p_limit not between 1 and 600 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
  if (select count(*) from api_keys where property_id = p_property and revoked_at is null) >= 10 then raise exception 'POLICY_VIOLATION: too many' using errcode = 'P0001'; end if;
  v_prefix := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_key := 'hms_' || v_prefix || '_' || substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 48);
  insert into api_keys (tenant_id, property_id, name, prefix, key_hash, scopes, rate_limit_per_minute, created_by)
  values (v_prop.tenant_id, p_property, v_name, v_prefix, encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), v_scopes, p_limit, v_actor) returning id into v_id;
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'api_key.created', 'api_key', v_id, null,
                      jsonb_build_object('name', v_name, 'prefix', v_prefix, 'scopes', v_scopes, 'limit', p_limit));
  return jsonb_build_object('key_id', v_id, 'key', v_key, 'prefix', v_prefix);   -- the only time the key is shown
end $$;

create function api_key_revoke(p_key uuid) returns void
language plpgsql security definer set search_path = public as $$
declare k api_keys%rowtype; v_actor uuid;
begin
  select * into k from api_keys where id = p_key;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(k.property_id, 'api.manage', 'NOT_FOUND');   -- revoking stays possible with the flag off
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if k.revoked_at is not null then return; end if;
  update api_keys set revoked_at = now() where id = p_key;
  perform write_audit(k.tenant_id, k.property_id, v_actor, 'api_key.revoked', 'api_key', k.id, null, jsonb_build_object('name', k.name, 'prefix', k.prefix));
end $$;

-- ---- authenticate and log (service role) -----------------------------------------------------------------
create function api_key_authenticate(p_hash text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare k api_keys%rowtype; v_recent integer; v_oldest timestamptz;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into k from api_keys where key_hash = p_hash and revoked_at is null;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if not tenant_feature_on(k.tenant_id, 'api_access') then return jsonb_build_object('ok', false, 'reason', 'off'); end if;
  select count(*), min(at) into v_recent, v_oldest from api_calls where key_id = k.id and at > clock_timestamp() - interval '60 seconds';
  if v_recent >= k.rate_limit_per_minute then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited', 'retry_after', greatest(1, ceil(extract(epoch from (v_oldest + interval '60 seconds' - clock_timestamp())))::int));
  end if;
  return jsonb_build_object('ok', true, 'key_id', k.id, 'property_id', k.property_id, 'tenant_id', k.tenant_id, 'scopes', to_jsonb(k.scopes));
end $$;

create function api_log_call(p_key uuid, p_method text, p_path text, p_status integer) returns void
language plpgsql security definer set search_path = public as $$
declare k api_keys%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into k from api_keys where id = p_key;
  if not found then return; end if;
  insert into api_calls (key_id, property_id, method, path, status) values (k.id, k.property_id, left(coalesce(p_method, ''), 10), left(coalesce(p_path, ''), 200), p_status);
  update api_keys set last_used_at = now() where id = k.id;
  if random() < 0.02 then delete from api_calls where key_id = k.id and at < now() - interval '90 days'; end if;   -- tidy as we go
end $$;

-- ---- read endpoints (service role) -------------------------------------------------------------------------
create function api_availability(p_property uuid, p_arrival date, p_departure date, p_adults integer, p_children integer default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_host text; v_tenant uuid;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select tenant_id into v_tenant from properties where id = p_property;
  select d.host into v_host from tenant_domains d
   where d.tenant_id = v_tenant and d.verified_at is not null and (d.property_id = p_property or d.property_id is null)
   order by (d.property_id is not null) desc, d.host limit 1;
  if v_host is null then raise exception 'INVALID_STATE: no booking site' using errcode = 'P0001'; end if;
  return search_availability(v_host, p_arrival, p_departure, p_adults, p_children);
end $$;

create function api_booking_json(r reservations, p_guest boolean) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'reference', r.booking_reference, 'status', r.reservation_status, 'payment_status', r.payment_status, 'source', r.source,
    'arrival_date', r.arrival_date, 'departure_date', r.departure_date, 'nights', r.departure_date - r.arrival_date,
    'currency', r.currency, 'subtotal_minor', r.subtotal_minor, 'tax_minor', r.tax_minor, 'discount_minor', r.discount_minor, 'total_minor', r.total_minor,
    'created_at', r.created_at,
    'rooms', coalesce((select jsonb_agg(jsonb_build_object('room_type', t.name, 'adults', rr.adults, 'children', rr.children, 'status', rr.room_status) order by rr.created_at)
                        from reservation_rooms rr join room_types t on t.id = rr.room_type_id where rr.reservation_id = r.id), '[]'::jsonb))
  || case when p_guest then (select jsonb_build_object('guest', jsonb_build_object('name', g.full_name, 'email', g.email)) from guests g where g.id = r.primary_guest_id) else '{}'::jsonb end
$$;
revoke all on function api_booking_json(reservations, boolean) from public, anon, authenticated;

create function api_bookings(p_property uuid, p_from date, p_to date, p_status text, p_limit integer, p_guest boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'POLICY_VIOLATION: dates' using errcode = 'P0001'; end if;
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
  if p_status is not null and p_status not in ('pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show', 'expired') then raise exception 'POLICY_VIOLATION: status' using errcode = 'P0001'; end if;
  return jsonb_build_object('bookings', coalesce((
    select jsonb_agg(api_booking_json(x, coalesce(p_guest, false)) order by x.arrival_date, x.booking_reference)
      from (select * from reservations r where r.property_id = p_property and r.arrival_date between p_from and p_to
               and (p_status is null or r.reservation_status = p_status) order by r.arrival_date, r.booking_reference limit p_limit) x), '[]'::jsonb));
end $$;

create function api_booking(p_property uuid, p_reference text, p_guest boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r reservations%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into r from reservations where property_id = p_property and upper(booking_reference) = upper(btrim(coalesce(p_reference, '')));
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return api_booking_json(r, coalesce(p_guest, false));
end $$;

-- ---- webhook endpoints (api.manage) --------------------------------------------------------------------------
create function webhook_save(p_property uuid, p_endpoint uuid, p_url text, p_events text[], p_active boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_prop properties%rowtype; v_id uuid; v_url text := btrim(coalesce(p_url, '')); v_events text[]; v_secret text;
begin
  v_actor := api_require(p_property);
  select * into v_prop from properties where id = p_property;
  if not (v_url ~ '^https://[^ "<>/?#]+(/[^ "<>]*)?$' and char_length(v_url) <= 200) then raise exception 'POLICY_VIOLATION: url' using errcode = 'P0001'; end if;
  select coalesce(array_agg(distinct s order by s), '{}') into v_events from unnest(coalesce(p_events, '{}')) s;
  if v_events = '{}' or not (v_events <@ array['booking.created', 'booking.confirmed', 'booking.cancelled', 'booking.checked_in', 'booking.checked_out', 'booking.no_show']) then
    raise exception 'POLICY_VIOLATION: events' using errcode = 'P0001';
  end if;
  if p_endpoint is null then
    if (select count(*) from webhook_endpoints where property_id = p_property) >= 5 then raise exception 'POLICY_VIOLATION: too many' using errcode = 'P0001'; end if;
    v_secret := 'whsec_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    insert into webhook_endpoints (tenant_id, property_id, url, events, secret, is_active, created_by)
    values (v_prop.tenant_id, p_property, v_url, v_events, v_secret, coalesce(p_active, true), v_actor) returning id into v_id;
  else
    update webhook_endpoints set url = v_url, events = v_events, is_active = coalesce(p_active, true), updated_at = now()
     where id = p_endpoint and property_id = p_property returning id into v_id;
    if v_id is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  end if;
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'webhook_endpoint.saved', 'webhook_endpoint', v_id, null,
                      jsonb_build_object('url', v_url, 'events', v_events, 'active', coalesce(p_active, true), 'created', p_endpoint is null));
  return jsonb_build_object('endpoint_id', v_id, 'secret', v_secret);   -- the secret is shown once, on creation only
end $$;

-- ---- queueing events ------------------------------------------------------------------------------------------
create function webhook_enqueue_booking() returns trigger language plpgsql security definer set search_path = public as $$
declare v_event text; e record; v_id uuid;
begin
  if tg_op = 'INSERT' then v_event := 'booking.created';
  elsif new.reservation_status is distinct from old.reservation_status then
    v_event := case new.reservation_status when 'confirmed' then 'booking.confirmed' when 'cancelled' then 'booking.cancelled'
                 when 'checked_in' then 'booking.checked_in' when 'checked_out' then 'booking.checked_out' when 'no_show' then 'booking.no_show' end;
  end if;
  if v_event is null then return new; end if;
  if not tenant_feature_on(new.tenant_id, 'api_access') then return new; end if;
  for e in select id from webhook_endpoints where property_id = new.property_id and is_active and v_event = any (events) loop
    v_id := gen_random_uuid();
    insert into webhook_deliveries (id, endpoint_id, tenant_id, property_id, event, payload)
    values (v_id, e.id, new.tenant_id, new.property_id, v_event,
            jsonb_build_object('id', v_id, 'event', v_event, 'created_at', now(),
                               'data', jsonb_build_object('reference', new.booking_reference, 'status', new.reservation_status, 'payment_status', new.payment_status,
                                                          'arrival_date', new.arrival_date, 'departure_date', new.departure_date)));
  end loop;
  return new;
exception when others then
  raise warning 'webhook enqueue failed: %', sqlerrm;   -- never stop a booking because of a webhook
  return new;
end $$;
create trigger reservations_webhook after insert or update of reservation_status on reservations for each row execute function webhook_enqueue_booking();

create function claim_webhook_deliveries(p_limit integer default 20) returns table (id uuid, url text, secret text, event text, payload jsonb, attempts integer)
language plpgsql security definer set search_path = public as $$
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  delete from webhook_deliveries d where d.created_at < now() - interval '30 days' and d.status <> 'pending';
  return query
  with due as (
    select d.id from webhook_deliveries d join webhook_endpoints w on w.id = d.endpoint_id
     where d.status = 'pending' and d.next_attempt_at <= now() and w.is_active
     order by d.next_attempt_at limit greatest(1, least(coalesce(p_limit, 20), 100)) for update of d skip locked)
  update webhook_deliveries d set attempts = d.attempts + 1, next_attempt_at = now() + interval '5 minutes'
    from due, webhook_endpoints w where d.id = due.id and w.id = d.endpoint_id
  returning d.id, w.url, w.secret, d.event, d.payload, d.attempts;
end $$;

create function mark_webhook_delivery(p_id uuid, p_ok boolean, p_code integer, p_error text) returns void
language plpgsql security definer set search_path = public as $$
declare d webhook_deliveries%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into d from webhook_deliveries where id = p_id for update;
  if not found or d.status <> 'pending' then return; end if;
  if p_ok then
    update webhook_deliveries set status = 'sent', sent_at = now(), response_code = p_code, last_error = null where id = p_id;
  elsif d.attempts >= 6 then
    update webhook_deliveries set status = 'failed', response_code = p_code, last_error = left(p_error, 200) where id = p_id;
  else
    update webhook_deliveries set next_attempt_at = now() + make_interval(mins => power(2, d.attempts)::int), response_code = p_code, last_error = left(p_error, 200) where id = p_id;
  end if;
end $$;

revoke all on function api_key_create(uuid, text, text[], integer), api_key_revoke(uuid), webhook_save(uuid, uuid, text, text[], boolean) from public, anon;
grant execute on function api_key_create(uuid, text, text[], integer), api_key_revoke(uuid), webhook_save(uuid, uuid, text, text[], boolean) to authenticated;
revoke all on function api_key_authenticate(text), api_log_call(uuid, text, text, integer), api_availability(uuid, date, date, integer, integer),
  api_bookings(uuid, date, date, text, integer, boolean), api_booking(uuid, text, boolean), claim_webhook_deliveries(integer), mark_webhook_delivery(uuid, boolean, integer, text)
  from public, anon, authenticated;
grant execute on function api_key_authenticate(text), api_log_call(uuid, text, text, integer), api_availability(uuid, date, date, integer, integer),
  api_bookings(uuid, date, date, text, integer, boolean), api_booking(uuid, text, boolean), claim_webhook_deliveries(integer), mark_webhook_delivery(uuid, boolean, integer, text)
  to service_role;
