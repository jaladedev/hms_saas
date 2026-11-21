-- 172 Creating a booking through the public API (TODO 8.9, the part the first cut left out).
--
-- A new key scope, bookings.write, lets a key POST /api/v1/bookings. The call holds the rooms exactly as the hotel's own booking website
-- does (it goes through create_hold, so the same availability claim, price, tax, promo code and plan rules apply, and the booking is a
-- website booking that waits for payment) and answers with the booking reference, the hold's expiry, the total and the guest's own booking
-- page, where the guest pays. Nothing is paid or confirmed by the call, and it carries no card or money data.
--
-- api_create_booking(property, key, idempotency key, arrival, departure, adults, children, room type, quantity, guest, promo) is for the
-- server only. It resolves the hotel's own verified booking website the same way api_availability does (INVALID_STATE: no booking site
-- without one), refuses a room type of another property, and calls create_hold with the key "api:<key id>:<idempotency key>", so repeating a
-- call with the same idempotency key returns the same booking instead of holding rooms twice (the same key with a different request is
-- refused as IDEMPOTENCY_MISMATCH).
--
-- Rooms held and not yet paid are the only thing a key can take from the hotel, so each key may have at most 20 unpaid holds at once
-- (POLICY_VIOLATION: too many unpaid holds); a hold that is paid, cancelled or lapses stops counting. api_booking_requests records which key
-- made which booking, for that limit and for the hotel's own records. Every booking made this way is audited as api_booking.created with the
-- key's prefix, never the key.
--
-- Scopes: availability.read, bookings.read, guests.read, bookings.write. bookings.write stands alone (it does not need bookings.read, and
-- it does not show guest details; the guest's details are only what the caller sent).

alter table api_keys drop constraint api_keys_scopes_check;
alter table api_keys add constraint api_keys_scopes_check
  check (scopes <> '{}' and scopes <@ array['availability.read', 'bookings.read', 'guests.read', 'bookings.write']);

create or replace function api_key_create(p_property uuid, p_name text, p_scopes text[], p_limit integer default 60) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid; v_prop properties%rowtype; v_name text := btrim(coalesce(p_name, '')); v_prefix text; v_key text; v_id uuid;
  v_scopes text[];
begin
  v_actor := api_require(p_property);
  select * into v_prop from properties where id = p_property;
  if char_length(v_name) not between 1 and 60 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  select coalesce(array_agg(distinct s order by s), '{}') into v_scopes from unnest(coalesce(p_scopes, '{}')) s;
  if v_scopes = '{}' or not (v_scopes <@ array['availability.read', 'bookings.read', 'guests.read', 'bookings.write']) then raise exception 'POLICY_VIOLATION: scopes' using errcode = 'P0001'; end if;
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

create table api_booking_requests (
  reservation_id  uuid primary key references reservations(id),
  api_key_id      uuid not null references api_keys(id),
  created_at      timestamptz not null default now()
);
create index api_booking_requests_key on api_booking_requests (api_key_id);
alter table api_booking_requests enable row level security;   -- no policy: only the definer function reads or writes it
revoke all on api_booking_requests from authenticated, anon;

create function api_create_booking(
  p_property uuid, p_key uuid, p_idempotency text, p_arrival date, p_departure date, p_adults integer, p_children integer,
  p_room_type uuid, p_quantity integer, p_guest jsonb, p_promo text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid; v_host text; v_rooms jsonb; v_hold jsonb; v_res uuid; k api_keys%rowtype; v_unpaid integer; v_seen boolean;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into k from api_keys where id = p_key and property_id = p_property and revoked_at is null;
  if not found or not ('bookings.write' = any (k.scopes)) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_idempotency is null or p_idempotency !~ '^[A-Za-z0-9_.:-]{8,100}$' then raise exception 'POLICY_VIOLATION: idempotency key' using errcode = 'P0001'; end if;
  if p_quantity is null or p_quantity not between 1 and 5 or p_adults is null or p_adults < 1 or p_children is null or p_children < 0 then
    raise exception 'POLICY_VIOLATION: rooms' using errcode = 'P0001';
  end if;
  if not exists (select 1 from room_types t where t.id = p_room_type and t.property_id = p_property) then
    raise exception 'POLICY_VIOLATION: room type' using errcode = 'P0001';
  end if;
  select tenant_id into v_tenant from properties where id = p_property;
  select d.host into v_host from tenant_domains d
   where d.tenant_id = v_tenant and d.verified_at is not null and (d.property_id = p_property or d.property_id is null)
   order by (d.property_id is not null) desc, d.host limit 1;
  if v_host is null then raise exception 'INVALID_STATE: no booking site' using errcode = 'P0001'; end if;

  -- a repeated call (same idempotency key) is answered by create_hold from the booking it made, and does not count against the limit again
  select exists (select 1 from idempotency_keys i
                  where i.tenant_id = v_tenant and i.operation = 'create_hold' and i.idempotency_key = 'api:' || p_key || ':' || p_idempotency
                    and i.response is not null) into v_seen;
  if not v_seen then
    select count(*) into v_unpaid from api_booking_requests r join reservations x on x.id = r.reservation_id
     where r.api_key_id = p_key and x.reservation_status = 'pending';
    if v_unpaid >= 20 then raise exception 'POLICY_VIOLATION: too many unpaid holds' using errcode = 'P0001'; end if;
  end if;

  v_rooms := (select jsonb_agg(jsonb_build_object('room_type_id', p_room_type, 'adults', p_adults, 'children', p_children)) from generate_series(1, p_quantity));
  v_hold := create_hold(v_host, p_arrival, p_departure, v_rooms,
                        jsonb_strip_nulls(jsonb_build_object('full_name', p_guest ->> 'full_name', 'email', p_guest ->> 'email', 'phone', nullif(p_guest ->> 'phone', ''),
                                                             'address', nullif(p_guest ->> 'address', ''), 'special_requests', nullif(p_guest ->> 'special_requests', ''))),
                        'api:' || p_key || ':' || p_idempotency, nullif(btrim(coalesce(p_promo, '')), ''));
  v_res := (v_hold ->> 'reservation_id')::uuid;
  if not exists (select 1 from api_booking_requests where reservation_id = v_res) then
    insert into api_booking_requests (reservation_id, api_key_id) values (v_res, p_key);
    perform write_audit(v_tenant, p_property, null, 'api_booking.created', 'reservation', v_res, null,
                        jsonb_build_object('key_prefix', k.prefix, 'rooms', p_quantity, 'arrival', p_arrival, 'departure', p_departure));
  end if;
  return jsonb_build_object('reservation_id', v_res, 'host', v_host, 'booking', guest_booking_status(v_res));
end $$;
revoke all on function api_create_booking(uuid, uuid, text, date, date, integer, integer, uuid, integer, jsonb, text) from public, anon, authenticated;
grant execute on function api_create_booking(uuid, uuid, text, date, date, integer, integer, uuid, integer, jsonb, text) to service_role;
