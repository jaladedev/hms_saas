-- 171 Channel manager, inbound half (TODO 8.6, first cut). Vendor-neutral: a channel manager (or an OTA's own connection) sends bookings to
-- POST /api/channels/inbound with a per-connection key; nothing here talks to an OTA, and no availability or rate is pushed out.
--
--   channel_connections   one per source and hotel (booking_com, expedia, airbnb, other), a label, whether the channel or the hotel collects the
--                         guest's payment (a note only; no payment is recorded), a status (active, paused, revoked). The key is `chn_<8 hex>_<48 hex>`;
--                         only its sha256 is stored and it is shown once. 5 live connections a hotel.
--   channel_room_map      the channel's room or rate code -> one of the hotel's room types. A booking for a code that is not mapped is not imported.
--   channel_bookings      one row per (connection, channel booking id), never two: a repeat is a no-op. Statuses: received, imported, failed,
--                         cancelled, attention, resolved. It keeps what was needed to import (dates, room codes, party, the channel's total) and the
--                         guest's name, not their email or phone (those go on the guest record).
-- A booking is imported through create_reservation (source 'partner'), the same code as every other booking, so it claims rooms through the same
-- exclusion constraint and cannot double book; if the room is gone the import fails with a code and waits on the reconciliation screen to be retried.
-- The hotel's own rate is used. The channel's total is kept next to it and a difference is shown, not hidden.
-- A cancellation from the channel cancels the booking the same way a staff cancellation would, with the cancellation charge waived (the channel's
-- terms apply); one that cannot be applied (the guest already checked in) goes to attention. A modification is never applied by itself: it goes
-- to attention so a person changes the booking.
-- Permission channels.manage (owner, general manager). Plan flag channel_manager (enforced, Pro plan). With it off nothing is imported or written;
-- everything can still be read.
-- Not built: pushing availability and rates out (the read API of 8.9 can feed a channel manager that polls), any vendor's own message format,
-- recording the channel's payment, applying modifications, payouts and commission reconciliation, a retry timer.

insert into permissions (key) values ('channels.manage');
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p where p.key = 'channels.manage' and r.is_system and r.key in ('owner', 'general_manager');

create or replace function plan_enforced_flags() returns text[]
language sql immutable set search_path = public as $$
  select array['reports.export', 'online_payments', 'discounts', 'online_booking', 'guest_cancel', 'guest_changes', 'early_checkin',
               'housekeeping', 'maintenance', 'audit_log', 'branding', 'dynamic_pricing', 'sms_notifications', 'restaurant_pos', 'group_bookings', 'inventory',
               'guest_services', 'api_access', 'loyalty', 'staff_hr', 'multi_currency', 'channel_manager']
$$;
revoke all on function plan_enforced_flags() from public, anon;
update plans set features = (select array_agg(distinct k order by k) from unnest(features || array['channel_manager']) k) where code = 'pro';

create table channel_connections (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  property_id uuid not null,
  channel     text not null check (channel in ('booking_com', 'expedia', 'airbnb', 'other')),
  label       text not null check (char_length(label) between 1 and 60),
  collects    text not null default 'channel' check (collects in ('channel', 'hotel')),
  status      text not null default 'active' check (status in ('active', 'paused', 'revoked')),
  prefix      text not null,
  key_hash    text not null unique,
  last_inbound_at timestamptz,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  unique (tenant_id, property_id, id)
);
create index channel_connections_idx on channel_connections (property_id);

create table channel_room_map (
  connection_id    uuid not null references channel_connections (id) on delete cascade,
  external_room_id text not null check (char_length(external_room_id) between 1 and 80),
  room_type_id     uuid not null references room_types (id),
  created_at       timestamptz not null default now(),
  primary key (connection_id, external_room_id)
);

create table channel_bookings (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  property_id    uuid not null,
  connection_id  uuid not null references channel_connections (id),
  external_id    text not null check (char_length(external_id) between 1 and 80),
  status         text not null default 'received' check (status in ('received', 'imported', 'failed', 'cancelled', 'attention', 'resolved')),
  guest_label    text,
  arrival_date   date,
  departure_date date,
  summary        jsonb not null default '{}'::jsonb,
  channel_total_minor bigint check (channel_total_minor is null or channel_total_minor >= 0),
  reservation_id uuid references reservations (id),
  error          text,
  note           text check (note is null or char_length(note) <= 200),
  attempts       integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (connection_id, external_id)
);
create index channel_bookings_idx on channel_bookings (property_id, status, created_at desc);

alter table channel_connections enable row level security;
alter table channel_room_map enable row level security;
alter table channel_bookings enable row level security;
create policy channel_connections_select on channel_connections for select to authenticated using (has_permission(property_id, 'channels.manage'));
create policy channel_room_map_select on channel_room_map for select to authenticated
  using (exists (select 1 from channel_connections c where c.id = connection_id and has_permission(c.property_id, 'channels.manage')));
create policy channel_bookings_select on channel_bookings for select to authenticated using (has_permission(property_id, 'channels.manage'));
revoke all on channel_connections, channel_room_map, channel_bookings from anon, authenticated;
grant select (id, tenant_id, property_id, channel, label, collects, status, prefix, last_inbound_at, created_by, created_at) on channel_connections to authenticated;
grant select on channel_room_map, channel_bookings to authenticated;

create function channel_require(p_property uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_prop properties%rowtype; v_actor uuid;
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'channels.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(v_prop.tenant_id, 'channel_manager') then raise exception 'POLICY_VIOLATION: channels off' using errcode = 'P0001'; end if;
  return v_actor;
end $$;
revoke all on function channel_require(uuid) from public, anon, authenticated;

-- ---- setup (channels.manage) -------------------------------------------------------------------------------------------
create function channel_connection_create(p_property uuid, p_channel text, p_label text, p_collects text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_prop properties%rowtype; v_label text := btrim(coalesce(p_label, '')); v_prefix text; v_key text; v_id uuid;
begin
  v_actor := channel_require(p_property);
  select * into v_prop from properties where id = p_property;
  if p_channel is null or p_channel not in ('booking_com', 'expedia', 'airbnb', 'other') then raise exception 'POLICY_VIOLATION: channel' using errcode = 'P0001'; end if;
  if char_length(v_label) not between 1 and 60 then raise exception 'POLICY_VIOLATION: label' using errcode = 'P0001'; end if;
  if p_collects is null or p_collects not in ('channel', 'hotel') then raise exception 'POLICY_VIOLATION: collects' using errcode = 'P0001'; end if;
  if (select count(*) from channel_connections where property_id = p_property and status <> 'revoked') >= 5 then raise exception 'POLICY_VIOLATION: too many' using errcode = 'P0001'; end if;
  v_prefix := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_key := 'chn_' || v_prefix || '_' || substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 48);
  insert into channel_connections (tenant_id, property_id, channel, label, collects, prefix, key_hash, created_by)
  values (v_prop.tenant_id, p_property, p_channel, v_label, p_collects, v_prefix, encode(sha256(convert_to(v_key, 'UTF8')), 'hex'), v_actor) returning id into v_id;
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'channel_connection.created', 'channel_connection', v_id, null,
                      jsonb_build_object('channel', p_channel, 'label', v_label, 'collects', p_collects, 'prefix', v_prefix));
  return jsonb_build_object('connection_id', v_id, 'key', v_key, 'prefix', v_prefix);   -- the only time the key is shown
end $$;

create function channel_connection_set(p_connection uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare c channel_connections%rowtype; v_actor uuid;
begin
  select * into c from channel_connections where id = p_connection;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := channel_require(c.property_id);
  if p_status is null or p_status not in ('active', 'paused', 'revoked') then raise exception 'POLICY_VIOLATION: status' using errcode = 'P0001'; end if;
  select * into c from channel_connections where id = p_connection for update;
  if c.status = 'revoked' and p_status <> 'revoked' then raise exception 'INVALID_STATE: revoked' using errcode = 'P0001'; end if;   -- a revoked key never comes back
  if c.status = p_status then return; end if;
  update channel_connections set status = p_status where id = c.id;
  perform write_audit(c.tenant_id, c.property_id, v_actor, 'channel_connection.' || p_status, 'channel_connection', c.id, null, jsonb_build_object('was', c.status));
end $$;

create function channel_map_set(p_connection uuid, p_external text, p_room_type uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c channel_connections%rowtype; v_actor uuid; v_ext text := btrim(coalesce(p_external, ''));
begin
  select * into c from channel_connections where id = p_connection;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := channel_require(c.property_id);
  if char_length(v_ext) not between 1 and 80 then raise exception 'POLICY_VIOLATION: code' using errcode = 'P0001'; end if;
  if not exists (select 1 from room_types where id = p_room_type and property_id = c.property_id and status = 'active') then raise exception 'POLICY_VIOLATION: room type' using errcode = 'P0001'; end if;
  insert into channel_room_map (connection_id, external_room_id, room_type_id) values (c.id, v_ext, p_room_type)
  on conflict (connection_id, external_room_id) do update set room_type_id = excluded.room_type_id;
  perform write_audit(c.tenant_id, c.property_id, v_actor, 'channel_map.set', 'channel_connection', c.id, null, jsonb_build_object('code', v_ext, 'room_type_id', p_room_type));
end $$;

create function channel_map_remove(p_connection uuid, p_external text) returns void
language plpgsql security definer set search_path = public as $$
declare c channel_connections%rowtype; v_actor uuid;
begin
  select * into c from channel_connections where id = p_connection;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := channel_require(c.property_id);
  delete from channel_room_map where connection_id = c.id and external_room_id = p_external;
  perform write_audit(c.tenant_id, c.property_id, v_actor, 'channel_map.removed', 'channel_connection', c.id, null, jsonb_build_object('code', p_external));
end $$;

-- ---- importing one booking (internal) ---------------------------------------------------------------------------------
-- Tries to turn a stored channel booking into a reservation. Never raises for a booking problem: the outcome (imported or failed with a short
-- code) is written on the row. The whole attempt is one sub-transaction, so a failure leaves no half-made booking behind.
create function channel_import(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  b channel_bookings%rowtype; c channel_connections%rowtype; v_guest uuid; v_rooms jsonb := '[]'::jsonb; e jsonb; v_type uuid; v_res jsonb;
  v_name text; v_email text; v_code text;
begin
  select * into b from channel_bookings where id = p_id for update;
  select * into c from channel_connections where id = b.connection_id;
  update channel_bookings set attempts = attempts + 1, updated_at = now() where id = b.id;
  begin
    if b.arrival_date is null or b.departure_date is null then raise exception 'POLICY_VIOLATION: dates' using errcode = 'P0001'; end if;
    for e in select * from jsonb_array_elements(coalesce(b.summary -> 'rooms', '[]'::jsonb)) loop
      select room_type_id into v_type from channel_room_map where connection_id = c.id and external_room_id = e ->> 'external_room_id';
      if v_type is null then raise exception 'POLICY_VIOLATION: unmapped room' using errcode = 'P0001'; end if;
      v_rooms := v_rooms || jsonb_build_object('room_type_id', v_type, 'adults', greatest(coalesce((e ->> 'adults')::int, 1), 1), 'children', greatest(coalesce((e ->> 'children')::int, 0), 0));
    end loop;
    if jsonb_array_length(v_rooms) = 0 then raise exception 'POLICY_VIOLATION: no rooms' using errcode = 'P0001'; end if;
    v_name := coalesce(nullif(btrim(b.guest_label), ''), 'Channel guest');
    v_email := nullif(lower(btrim(coalesce(b.summary ->> '_email', ''))), '');
    if v_email is not null then select id into v_guest from guests where tenant_id = b.tenant_id and lower(email) = v_email order by created_at limit 1; end if;
    if v_guest is null then
      insert into guests (tenant_id, full_name, email, phone) values (b.tenant_id, v_name, v_email, nullif(btrim(coalesce(b.summary ->> '_phone', '')), '')) returning id into v_guest;
    end if;
    v_res := create_reservation(b.property_id, v_guest, 'partner', b.arrival_date, b.departure_date, v_rooms, 'chan:' || c.id::text || ':' || b.external_id);
    update channel_bookings set status = 'imported', reservation_id = (v_res ->> 'reservation_id')::uuid, error = null,
           summary = summary - '_email' - '_phone', updated_at = now() where id = b.id;
    perform write_audit(b.tenant_id, b.property_id, null, 'channel_booking.imported', 'channel_booking', b.id, null,
                        jsonb_build_object('channel', c.channel, 'external_id', b.external_id, 'reservation_id', v_res ->> 'reservation_id'));
    return 'imported';
  exception when others then
    -- a booking problem (P0001 text such as ROOM_UNAVAILABLE) or a database refusal (for example a room claimed a moment earlier): keep a short code
    v_code := case when sqlstate = 'P0001' then left(regexp_replace(split_part(sqlerrm, E'\n', 1), '[^A-Za-z0-9_: ]', '', 'g'), 60) else 'database ' || sqlstate end;
  end;
  update channel_bookings set status = 'failed', error = v_code, updated_at = now() where id = b.id;
  perform write_audit(b.tenant_id, b.property_id, null, 'channel_booking.failed', 'channel_booking', b.id, null, jsonb_build_object('channel', c.channel, 'external_id', b.external_id, 'error', v_code));
  return 'failed';
end $$;
revoke all on function channel_import(uuid) from public, anon, authenticated;

-- ---- the inbound endpoint's functions (service role only) --------------------------------------------------------------
create function channel_authenticate(p_hash text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c channel_connections%rowtype;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into c from channel_connections where key_hash = p_hash and status = 'active';
  if not found then return jsonb_build_object('ok', false); end if;
  if not tenant_feature_on(c.tenant_id, 'channel_manager') then return jsonb_build_object('ok', false); end if;
  update channel_connections set last_inbound_at = now() where id = c.id;
  return jsonb_build_object('ok', true, 'connection_id', c.id, 'property_id', c.property_id);
end $$;

-- event: 'booking' (new or repeated), 'modify', 'cancel'. p_payload for a booking:
--   {"arrival":"2026-12-01","departure":"2026-12-03","guest_name":"..","email":"..","phone":"..","total_minor":123,
--    "rooms":[{"external_room_id":"DBL-1","adults":2,"children":0}]}
create function channel_receive(p_connection uuid, p_event text, p_external text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c channel_connections%rowtype; b channel_bookings%rowtype; v_ext text := btrim(coalesce(p_external, '')); v_p jsonb := coalesce(p_payload, '{}'::jsonb);
  v_arr date; v_dep date; v_total bigint; v_out text; v_rooms jsonb; v_hash text; v_res reservations%rowtype; v_idem record; v_name text;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into c from channel_connections where id = p_connection and status = 'active';
  if not found or not tenant_feature_on(c.tenant_id, 'channel_manager') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_event is null or p_event not in ('booking', 'modify', 'cancel') then raise exception 'POLICY_VIOLATION: event' using errcode = 'P0001'; end if;
  if char_length(v_ext) not between 1 and 80 then raise exception 'POLICY_VIOLATION: id' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtext('channel:' || c.id::text || ':' || v_ext));
  select * into b from channel_bookings where connection_id = c.id and external_id = v_ext;

  if p_event = 'booking' then
    if found then
      if b.status = 'failed' and b.attempts < 5 then
        v_out := channel_import(b.id);
        return jsonb_build_object('status', v_out, 'duplicate', true);
      end if;
      return jsonb_build_object('status', b.status, 'duplicate', true);
    end if;
    begin
      v_arr := (v_p ->> 'arrival')::date; v_dep := (v_p ->> 'departure')::date; v_total := nullif(v_p ->> 'total_minor', '')::bigint;
    exception when others then raise exception 'POLICY_VIOLATION: payload' using errcode = 'P0001'; end;
    if v_arr is null or v_dep is null or v_dep <= v_arr or v_dep - v_arr > 30 or (v_total is not null and v_total < 0) then raise exception 'POLICY_VIOLATION: payload' using errcode = 'P0001'; end if;
    if jsonb_typeof(v_p -> 'rooms') <> 'array' or jsonb_array_length(v_p -> 'rooms') not between 1 and 10 then raise exception 'POLICY_VIOLATION: payload' using errcode = 'P0001'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('external_room_id', left(x ->> 'external_room_id', 80), 'adults', coalesce((x ->> 'adults')::int, 1), 'children', coalesce((x ->> 'children')::int, 0))), '[]'::jsonb)
      into v_rooms from jsonb_array_elements(v_p -> 'rooms') x;
    v_name := left(btrim(coalesce(v_p ->> 'guest_name', '')), 120);
    insert into channel_bookings (tenant_id, property_id, connection_id, external_id, guest_label, arrival_date, departure_date, channel_total_minor, summary)
    values (c.tenant_id, c.property_id, c.id, v_ext, nullif(v_name, ''), v_arr, v_dep, v_total,
            jsonb_build_object('rooms', v_rooms, '_email', left(coalesce(v_p ->> 'email', ''), 254), '_phone', left(coalesce(v_p ->> 'phone', ''), 40)))
    returning * into b;
    v_out := channel_import(b.id);
    return jsonb_build_object('status', v_out, 'duplicate', false);
  end if;

  if p_event = 'modify' then
    if not found then
      insert into channel_bookings (tenant_id, property_id, connection_id, external_id, status, note) values (c.tenant_id, c.property_id, c.id, v_ext, 'attention', 'Changed at the channel before it was received')
      returning * into b;
    elsif b.status in ('imported', 'received', 'failed') then
      update channel_bookings set status = 'attention', note = 'Changed at the channel: change the booking by hand', updated_at = now() where id = b.id returning * into b;
    end if;
    perform write_audit(c.tenant_id, c.property_id, null, 'channel_booking.modified', 'channel_booking', b.id, null, jsonb_build_object('external_id', v_ext));
    return jsonb_build_object('status', b.status);
  end if;

  -- cancel
  if not found then
    insert into channel_bookings (tenant_id, property_id, connection_id, external_id, status, note) values (c.tenant_id, c.property_id, c.id, v_ext, 'cancelled', 'Cancelled at the channel before it was received')
    returning * into b;
    return jsonb_build_object('status', 'cancelled');
  end if;
  if b.status = 'cancelled' then return jsonb_build_object('status', 'cancelled', 'duplicate', true); end if;
  if b.reservation_id is null then
    update channel_bookings set status = 'cancelled', updated_at = now() where id = b.id;
    return jsonb_build_object('status', 'cancelled');
  end if;
  select * into v_res from reservations where id = b.reservation_id for update;
  if v_res.reservation_status = 'cancelled' then
    update channel_bookings set status = 'cancelled', updated_at = now() where id = b.id;
    return jsonb_build_object('status', 'cancelled');
  end if;
  begin
    v_hash := md5('channel cancel ' || b.id::text);
    select * into v_idem from idem_begin(v_res.tenant_id, 'cancel_reservation', 'chan-cancel:' || b.id::text, v_hash);
    if v_idem.out_is_new then perform cancel_reservation_apply(v_res.id, 'Cancelled at the channel', null, 'staff', 'chan-cancel:' || b.id::text, null, true); end if;
    update channel_bookings set status = 'cancelled', updated_at = now() where id = b.id;
    perform write_audit(c.tenant_id, c.property_id, null, 'channel_booking.cancelled', 'channel_booking', b.id, null, jsonb_build_object('external_id', v_ext, 'reservation_id', v_res.id));
    return jsonb_build_object('status', 'cancelled');
  exception when sqlstate 'P0001' then
    update channel_bookings set status = 'attention', note = 'Cancelled at the channel, but the booking is already in house or finished', updated_at = now() where id = b.id;
    return jsonb_build_object('status', 'attention');
  end;
end $$;

revoke all on function channel_authenticate(text), channel_receive(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function channel_authenticate(text), channel_receive(uuid, text, text, jsonb) to service_role;

-- ---- reconciliation (channels.manage) ------------------------------------------------------------------------------------
create function channel_retry(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b channel_bookings%rowtype; v_actor uuid; v_out text;
begin
  select * into b from channel_bookings where id = p_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := channel_require(b.property_id);
  if (select status from channel_connections where id = b.connection_id) = 'revoked' then raise exception 'INVALID_STATE: revoked' using errcode = 'P0001'; end if;
  select * into b from channel_bookings where id = p_id for update;
  if b.status <> 'failed' then raise exception 'INVALID_STATE: %', b.status using errcode = 'P0001'; end if;
  v_out := channel_import(b.id);
  perform write_audit(b.tenant_id, b.property_id, v_actor, 'channel_booking.retried', 'channel_booking', b.id, null, jsonb_build_object('result', v_out));
  return jsonb_build_object('status', v_out);
end $$;

-- A person has dealt with a failed or attention item by hand.
create function channel_resolve(p_id uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare b channel_bookings%rowtype; v_actor uuid; v_note text := btrim(coalesce(p_note, ''));
begin
  select * into b from channel_bookings where id = p_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := channel_require(b.property_id);
  if char_length(v_note) not between 3 and 200 then raise exception 'POLICY_VIOLATION: note' using errcode = 'P0001'; end if;
  select * into b from channel_bookings where id = p_id for update;
  if b.status not in ('failed', 'attention') then raise exception 'INVALID_STATE: %', b.status using errcode = 'P0001'; end if;
  update channel_bookings set status = 'resolved', note = v_note, updated_at = now() where id = b.id;
  perform write_audit(b.tenant_id, b.property_id, v_actor, 'channel_booking.resolved', 'channel_booking', b.id, null, jsonb_build_object('was', b.status));
end $$;

-- Counts by status and the differences worth a look: where the channel's total is not ours, and bookings cancelled here but live at the channel.
create function channel_sync_report(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_actor uuid;
begin
  v_actor := require_permission(p_property, 'channels.manage', 'NOT_FOUND');   -- readable with the flag off
  return jsonb_build_object(
    'counts', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from channel_bookings where property_id = p_property group by status) s), '{}'::jsonb),
    'price_differences', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'external_id', b.external_id, 'reference', r.booking_reference, 'channel_total_minor', b.channel_total_minor,
                                                                    'our_total_minor', r.total_minor, 'currency', r.currency) order by b.created_at desc)
                                     from channel_bookings b join reservations r on r.id = b.reservation_id
                                    where b.property_id = p_property and b.status = 'imported' and b.channel_total_minor is not null and b.channel_total_minor <> r.total_minor), '[]'::jsonb),
    'cancelled_here', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'external_id', b.external_id, 'reference', r.booking_reference) order by b.created_at desc)
                                  from channel_bookings b join reservations r on r.id = b.reservation_id
                                 where b.property_id = p_property and b.status = 'imported' and r.reservation_status in ('cancelled', 'expired', 'no_show')), '[]'::jsonb));
end $$;

revoke all on function channel_connection_create(uuid, text, text, text), channel_connection_set(uuid, text), channel_map_set(uuid, text, uuid), channel_map_remove(uuid, text),
  channel_retry(uuid), channel_resolve(uuid, text), channel_sync_report(uuid) from public, anon;
grant execute on function channel_connection_create(uuid, text, text, text), channel_connection_set(uuid, text), channel_map_set(uuid, text, uuid), channel_map_remove(uuid, text),
  channel_retry(uuid), channel_resolve(uuid, text), channel_sync_report(uuid) to authenticated;
