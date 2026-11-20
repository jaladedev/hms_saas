-- 151 Spa, gym and laundry services, first cut (TODO 8.12).
--
-- A catalog of services the hotel sells (a massage, a gym session, a laundry bag) and bookings for them, made by staff for an in-house
-- or booked guest, or for a walk-in who has no reservation. A booking can be put on the guest's folio (post_folio_charge, so extras tax
-- rules apply), the same as a restaurant bill posted to a room (148).
--   hotel_services     name, kind (spa, gym, laundry, other), price, optional duration in minutes, capacity (how many can be booked in
--                      the same time at once), switched on or off. Up to 30 a hotel. Rows are never deleted.
--   service_bookings   one row per booking: the service's name, kind and price as they were (a later price change never alters it), a
--                      quantity, the guest (a reservation of this hotel, or a short label for a walk-in), and for a timed service the
--                      start and end. Status booked, done, cancelled, no_show or charged (charged = posted to the folio).
-- A timed service (it has a duration) cannot be booked into a slot that would take more than its capacity: overlapping bookings that are
-- still booked, done or charged count. A service with no duration (laundry) has no slots; the time is optional (for pickup).
-- Steps: done, cancel (booked only), no_show (booked only), charge (booked or done; needs a reservation that is checked in or checked out;
-- a laundry service posts as the folio's "laundry" category, everything else as "other"). A charged booking is final. A walk-in cannot be
-- charged to a room; it is marked done and paid outside the system.
-- Permissions (new): services.view (read), services.book (book, change a booking, charge), services.manage (catalog; also everything
-- services.book can do). Posting to a folio also needs folio.charge (post_folio_charge checks it). Report: services.view and report.view.
-- Flag: guest_services (enforced, Pro plan; no row = on). Off: everything can still be read, nothing can be written.
-- Not built: a guest site page for booking, recurring memberships (needs recurring billing), staff or room assignment for a slot, opening hours.

-- ---- permissions and flag --------------------------------------------------------------------
insert into permissions (key) values ('services.view'), ('services.book'), ('services.manage');
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
 where p.key = 'services.view' and r.is_system and r.key in ('owner', 'general_manager', 'front_desk', 'accountant');
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
 where p.key = 'services.book' and r.is_system and r.key in ('owner', 'general_manager', 'front_desk');
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
 where p.key = 'services.manage' and r.is_system and r.key in ('owner', 'general_manager');

create or replace function plan_enforced_flags() returns text[]
language sql immutable set search_path = public as $$
  select array['reports.export', 'online_payments', 'discounts', 'online_booking', 'guest_cancel', 'guest_changes', 'early_checkin',
               'housekeeping', 'maintenance', 'audit_log', 'branding', 'dynamic_pricing', 'sms_notifications', 'restaurant_pos', 'group_bookings', 'inventory',
               'guest_services']
$$;
revoke all on function plan_enforced_flags() from public, anon;
update plans set features = (select array_agg(distinct k order by k) from unnest(features || array['guest_services']) k) where code = 'pro';

-- ---- tables ------------------------------------------------------------------------------------
create table hotel_services (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  property_id      uuid not null,
  name             text not null check (char_length(btrim(name)) between 1 and 60),
  kind             text not null default 'spa' check (kind in ('spa', 'gym', 'laundry', 'other')),
  price_minor      bigint not null check (price_minor between 1 and 1000000000),
  duration_minutes integer check (duration_minutes is null or duration_minutes between 5 and 480),
  capacity         integer not null default 1 check (capacity between 1 and 50),
  is_active        boolean not null default true,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  unique (tenant_id, property_id, id)
);
create unique index hotel_services_name_idx on hotel_services (property_id, lower(btrim(name)));

create table service_bookings (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  property_id       uuid not null,
  service_id        uuid not null,
  reservation_id    uuid,
  guest_label       text check (guest_label is null or char_length(guest_label) between 1 and 60),
  starts_at         timestamptz,
  ends_at           timestamptz,
  quantity          integer not null check (quantity between 1 and 20),
  note              text check (note is null or char_length(note) <= 200),
  name_at_booking   text not null,
  kind_at_booking   text not null,
  unit_price_minor  bigint not null check (unit_price_minor > 0),
  status            text not null default 'booked' check (status in ('booked', 'done', 'cancelled', 'no_show', 'charged')),
  folio_charge_id   uuid,
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (tenant_id, property_id, service_id) references hotel_services (tenant_id, property_id, id),
  foreign key (tenant_id, property_id, reservation_id) references reservations (tenant_id, property_id, id),
  check (reservation_id is not null or guest_label is not null),
  check ((starts_at is null) = (ends_at is null)),
  check ((status = 'charged') = (folio_charge_id is not null))
);
create index service_bookings_service_idx on service_bookings (service_id, starts_at);
create index service_bookings_property_idx on service_bookings (property_id, created_at desc);
create index service_bookings_reservation_idx on service_bookings (reservation_id);

create function svc_can_read(p_property uuid) returns boolean language sql stable security definer set search_path = public as $$
  select has_permission(p_property, 'services.view') or has_permission(p_property, 'services.book') or has_permission(p_property, 'services.manage')
$$;
revoke all on function svc_can_read(uuid) from public, anon;
grant execute on function svc_can_read(uuid) to authenticated;

alter table hotel_services enable row level security;
alter table service_bookings enable row level security;
create policy hotel_services_select on hotel_services for select to authenticated using (svc_can_read(property_id));
create policy service_bookings_select on service_bookings for select to authenticated using (svc_can_read(property_id));
revoke all on hotel_services, service_bookings from anon, authenticated;
grant select on hotel_services, service_bookings to authenticated;

-- A booking is final once charged, and never deleted. Only the status steps and updated_at move; everything else is fixed.
create function svc_guard_bookings() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'service bookings are never deleted' using errcode = 'P0001'; end if;
  if old.status = 'charged' then raise exception 'a charged service booking is final' using errcode = 'P0001'; end if;
  if (new.tenant_id, new.property_id, new.service_id, new.reservation_id, new.guest_label, new.starts_at, new.ends_at, new.quantity, new.note,
      new.name_at_booking, new.kind_at_booking, new.unit_price_minor)
     is distinct from
     (old.tenant_id, old.property_id, old.service_id, old.reservation_id, old.guest_label, old.starts_at, old.ends_at, old.quantity, old.note,
      old.name_at_booking, old.kind_at_booking, old.unit_price_minor) then
    raise exception 'a service booking cannot be edited' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger service_bookings_guard before update or delete on service_bookings for each row execute function svc_guard_bookings();
create function svc_guard_services() returns trigger language plpgsql as $$
begin raise exception 'services are never deleted' using errcode = 'P0001'; end $$;
create trigger hotel_services_guard before delete on hotel_services for each row execute function svc_guard_services();

-- ---- internal helper -----------------------------------------------------------------------------
-- p_level 'book' accepts services.book or services.manage; 'manage' needs services.manage. A service caller or no permission is NOT_FOUND.
create function svc_require(p_property uuid, p_level text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_prop properties%rowtype; v_actor uuid;
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_level = 'book' and has_permission(p_property, 'services.book') then
    v_actor := require_permission(p_property, 'services.book', 'NOT_FOUND');
  else
    v_actor := require_permission(p_property, 'services.manage', 'NOT_FOUND');
  end if;
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not tenant_feature_on(v_prop.tenant_id, 'guest_services') then raise exception 'POLICY_VIOLATION: services off' using errcode = 'P0001'; end if;
  return v_actor;
end $$;
revoke all on function svc_require(uuid, text) from public, anon, authenticated;

-- ---- catalog (services.manage) ---------------------------------------------------------------------
create function service_save(p_property uuid, p_service uuid, p_name text, p_kind text, p_price bigint, p_duration integer, p_capacity integer,
                             p_active boolean, p_sort integer default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_actor uuid; v_prop properties%rowtype; v_id uuid; v_name text := btrim(coalesce(p_name, ''));
begin
  v_actor := svc_require(p_property, 'manage');
  select * into v_prop from properties where id = p_property;
  if char_length(v_name) not between 1 and 60 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if p_kind is null or p_kind not in ('spa', 'gym', 'laundry', 'other') then raise exception 'POLICY_VIOLATION: kind' using errcode = 'P0001'; end if;
  if p_price is null or p_price not between 1 and 1000000000 then raise exception 'POLICY_VIOLATION: price' using errcode = 'P0001'; end if;
  if p_duration is not null and p_duration not between 5 and 480 then raise exception 'POLICY_VIOLATION: duration' using errcode = 'P0001'; end if;
  if p_capacity is null or p_capacity not between 1 and 50 then raise exception 'POLICY_VIOLATION: capacity' using errcode = 'P0001'; end if;
  if exists (select 1 from hotel_services where property_id = p_property and lower(btrim(name)) = lower(v_name) and id is distinct from p_service) then
    raise exception 'POLICY_VIOLATION: name taken' using errcode = 'P0001';
  end if;
  if p_service is null then
    if (select count(*) from hotel_services where property_id = p_property) >= 30 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
    insert into hotel_services (tenant_id, property_id, name, kind, price_minor, duration_minutes, capacity, is_active, sort_order)
    values (v_prop.tenant_id, p_property, v_name, p_kind, p_price, p_duration, p_capacity, coalesce(p_active, true), coalesce(p_sort, 0)) returning id into v_id;
  else
    update hotel_services set name = v_name, kind = p_kind, price_minor = p_price, duration_minutes = p_duration, capacity = p_capacity,
           is_active = coalesce(p_active, true), sort_order = coalesce(p_sort, sort_order), updated_at = now()
     where id = p_service and property_id = p_property returning id into v_id;
    if v_id is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  end if;
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'hotel_service.saved', 'hotel_service', v_id, null,
                      jsonb_build_object('name', v_name, 'kind', p_kind, 'price_minor', p_price, 'duration', p_duration, 'capacity', p_capacity,
                                         'active', coalesce(p_active, true), 'created', p_service is null));
  return jsonb_build_object('service_id', v_id);
end $$;

-- ---- bookings (services.book) -----------------------------------------------------------------------
create function service_book(p_property uuid, p_service uuid, p_reservation uuid, p_guest_label text, p_starts timestamp, p_quantity integer,
                             p_note text, p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid; v_prop properties%rowtype; s hotel_services%rowtype; r reservations%rowtype; v_idem record; v_hash text; v_id uuid; v_end timestamptz;
  v_start timestamptz; v_label text := nullif(btrim(coalesce(p_guest_label, '')), ''); v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_taken integer; v_result jsonb;
begin
  v_actor := svc_require(p_property, 'book');
  select * into v_prop from properties where id = p_property;
  v_start := p_starts at time zone v_prop.timezone;   -- the form sends the hotel's own wall-clock time
  select * into s from hotel_services where id = p_service and property_id = p_property and is_active for update;
  if not found then raise exception 'POLICY_VIOLATION: service' using errcode = 'P0001'; end if;
  if p_quantity is null or p_quantity not between 1 and 20 then raise exception 'POLICY_VIOLATION: quantity' using errcode = 'P0001'; end if;
  if char_length(coalesce(v_label, '')) > 60 or char_length(coalesce(v_note, '')) > 200 then raise exception 'POLICY_VIOLATION: text' using errcode = 'P0001'; end if;
  if p_reservation is null and v_label is null then raise exception 'POLICY_VIOLATION: guest' using errcode = 'P0001'; end if;
  if p_reservation is not null then
    select * into r from reservations where id = p_reservation and property_id = p_property;
    if not found then raise exception 'POLICY_VIOLATION: guest' using errcode = 'P0001'; end if;
    if r.reservation_status not in ('pending', 'confirmed', 'checked_in') then raise exception 'INVALID_STATE: reservation' using errcode = 'P0001'; end if;
  end if;
  if s.duration_minutes is not null then
    if p_starts is null or v_start < now() - interval '1 hour' or v_start > now() + interval '180 days' then raise exception 'POLICY_VIOLATION: time' using errcode = 'P0001'; end if;
    v_end := v_start + make_interval(mins => s.duration_minutes);
  elsif p_starts is not null then
    if v_start < now() - interval '1 hour' or v_start > now() + interval '180 days' then raise exception 'POLICY_VIOLATION: time' using errcode = 'P0001'; end if;
    v_end := v_start;
    -- a service with no duration keeps its time only as a note for pickup; the check wants both set, so it is stored as an instant
  end if;

  v_hash := md5(concat_ws('|', p_property, p_service, p_reservation, v_label, p_starts, p_quantity, v_note));
  select * into v_idem from idem_begin(v_prop.tenant_id, 'service_book', p_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  if s.duration_minutes is not null then
    select coalesce(sum(b.quantity), 0) into v_taken from service_bookings b
     where b.service_id = s.id and b.status in ('booked', 'done', 'charged') and b.starts_at < v_end and b.ends_at > v_start;
    if v_taken + p_quantity > s.capacity then raise exception 'POLICY_VIOLATION: slot full' using errcode = 'P0001'; end if;
  end if;

  insert into service_bookings (tenant_id, property_id, service_id, reservation_id, guest_label, starts_at, ends_at, quantity, note,
                                name_at_booking, kind_at_booking, unit_price_minor, created_by)
  values (v_prop.tenant_id, p_property, s.id, p_reservation, v_label, v_start, v_end, p_quantity, v_note, s.name, s.kind, s.price_minor, v_actor)
  returning id into v_id;
  v_result := jsonb_build_object('booking_id', v_id, 'total_minor', s.price_minor * p_quantity);
  perform idem_finish(v_prop.tenant_id, 'service_book', p_key, v_result);
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'service_booking.created', 'service_booking', v_id, p_key,
                      jsonb_build_object('service', s.name, 'reservation_id', p_reservation, 'quantity', p_quantity, 'starts_at', v_start));
  return v_result;
end $$;

create function service_booking_set(p_booking uuid, p_action text, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b service_bookings%rowtype; r reservations%rowtype; v_actor uuid; v_res jsonb; v_charge uuid; v_to text;
begin
  select * into b from service_bookings where id = p_booking;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := svc_require(b.property_id, 'book');
  if p_action is null or p_action not in ('done', 'cancel', 'no_show', 'charge') then raise exception 'POLICY_VIOLATION: action' using errcode = 'P0001'; end if;
  select * into b from service_bookings where id = p_booking for update;
  v_to := case p_action when 'done' then 'done' when 'cancel' then 'cancelled' when 'no_show' then 'no_show' else 'charged' end;
  if b.status = v_to then return jsonb_build_object('status', b.status, 'charge_id', b.folio_charge_id); end if;   -- a repeat changes nothing

  if p_action = 'charge' then
    if b.status not in ('booked', 'done') then raise exception 'INVALID_STATE: %', b.status using errcode = 'P0001'; end if;
    if b.reservation_id is null then raise exception 'INVALID_STATE: no room bill' using errcode = 'P0001'; end if;
    select * into r from reservations where id = b.reservation_id for update;
    if r.reservation_status not in ('checked_in', 'checked_out') then raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001'; end if;
    v_res := post_folio_charge(b.reservation_id, case when b.kind_at_booking = 'laundry' then 'laundry' else 'other' end,
                               left(initcap(b.kind_at_booking) || ': ' || b.name_at_booking, 200), b.quantity, b.unit_price_minor, 'svc:' || b.id::text);
    v_charge := (v_res ->> 'charge_id')::uuid;
    update service_bookings set status = 'charged', folio_charge_id = v_charge, updated_at = now() where id = b.id;
  else
    if b.status <> 'booked' then raise exception 'INVALID_STATE: %', b.status using errcode = 'P0001'; end if;
    update service_bookings set status = v_to, updated_at = now() where id = b.id;
  end if;

  perform write_audit(b.tenant_id, b.property_id, v_actor, 'service_booking.' || v_to, 'service_booking', b.id, null,
                      jsonb_build_object('service', b.name_at_booking, 'reservation_id', b.reservation_id));
  return jsonb_build_object('status', v_to, 'charge_id', v_charge);
end $$;

-- ---- report (services.view and report.view) ------------------------------------------------------------
create function service_report(p_property uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_actor uuid; v_money boolean;
begin
  if not has_permission(p_property, 'services.view') and not has_permission(p_property, 'services.book') and not has_permission(p_property, 'services.manage') then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  v_actor := require_permission(p_property, 'report.view', 'NOT_FOUND');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'POLICY_VIOLATION: dates' using errcode = 'P0001'; end if;
  v_money := can_view_money(p_property);
  return jsonb_build_object('from', p_from, 'to', p_to, 'services', coalesce((
    select jsonb_agg(jsonb_build_object(
             'service_id', s.id, 'name', s.name, 'kind', s.kind,
             'booked', coalesce(a.booked, 0), 'done', coalesce(a.done, 0), 'charged', coalesce(a.charged, 0), 'cancelled', coalesce(a.cancelled, 0), 'no_show', coalesce(a.no_show, 0),
             'revenue_minor', case when v_money then coalesce(a.revenue, 0) end) order by s.name)
      from hotel_services s
      left join lateral (
        select count(*) filter (where b.status = 'booked') as booked, count(*) filter (where b.status = 'done') as done,
               count(*) filter (where b.status = 'charged') as charged, count(*) filter (where b.status = 'cancelled') as cancelled,
               count(*) filter (where b.status = 'no_show') as no_show,
               coalesce(sum(b.quantity * b.unit_price_minor) filter (where b.status in ('done', 'charged')), 0)::bigint as revenue
          from service_bookings b
         where b.service_id = s.id and (coalesce(b.starts_at, b.created_at) at time zone (select timezone from properties where id = p_property))::date between p_from and p_to) a on true
     where s.property_id = p_property), '[]'::jsonb),
    'revenue_minor', case when v_money then (
       select coalesce(sum(b.quantity * b.unit_price_minor), 0)::bigint from service_bookings b
        where b.property_id = p_property and b.status in ('done', 'charged')
          and (coalesce(b.starts_at, b.created_at) at time zone (select timezone from properties where id = p_property))::date between p_from and p_to) end);
end $$;

revoke all on function service_save(uuid, uuid, text, text, bigint, integer, integer, boolean, integer), service_book(uuid, uuid, uuid, text, timestamp, integer, text, text),
  service_booking_set(uuid, text, text), service_report(uuid, date, date) from public, anon;
grant execute on function service_save(uuid, uuid, text, text, bigint, integer, integer, boolean, integer), service_book(uuid, uuid, uuid, text, timestamp, integer, text, text),
  service_booking_set(uuid, text, text), service_report(uuid, date, date) to authenticated;
