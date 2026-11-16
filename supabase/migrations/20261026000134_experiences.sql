-- 134 Experiences on the guest site: richer "Near the hotel" places, and experiences a guest can ask to book.
--
-- Part 1, places (119) get a category and a link.
--   hotel_places.category  one of dining, sights, nightlife, wellness, shopping, other (default other). The homepage groups places by
--                          category, so a hotel can have "Dining" and "Things to see" as separate sections.
--   hotel_places.link_url  null, or an https address of at most 200 characters with no spaces or quotes. The guest site draws it as a
--                          link that opens in a new tab with rel noopener noreferrer.
--   save_hotel_place       replaced: two new optional last arguments (p_category, p_link). POLICY_VIOLATION: category | link.
--   guest_places           now also returns category and link.
--
-- Part 2, experiences a guest can ask for (a tour, a dinner, an airport transfer). The hotel lists them with a price; the guest sends a
-- REQUEST from the booking page; staff confirm or decline it, and when the guest is in the house staff post it to the folio (027).
-- Nothing is paid online and nothing touches the booking's own money, so the invoice and payment rules are unchanged.
--
--   hotel_experiences          one row per experience: name (1 to 60), body (up to 200), price_minor (more than 0), unit 'person' or
--                              'booking', is_active, sort_order. Up to 12 a hotel. Staff with property.configure may read; every write
--                              goes through the functions.
--   save_hotel_experience      creates (p_experience null) or edits. POLICY_VIOLATION: name | text | price | unit | limit.
--                              Audited as hotel_experience.saved. NOT_FOUND also for no permission or another hotel.
--   delete_hotel_experience    removes an experience nobody has asked for; one with requests can only be switched off
--                              (INVALID_STATE: used). Audited as hotel_experience.deleted.
--   guest_experiences(host)    service role only. The switched-on experiences of the hotel the host belongs to: id, name, body,
--                              price_minor, unit, currency. No tenant or property.
--   experience_requests        one row per request: reservation, experience, quantity (1 to 20), an optional date within the stay,
--                              an optional note (up to 200), the price and unit as they were when asked (a later price change never
--                              alters a request), status requested | confirmed | declined | charged, and the folio charge once posted.
--   guest_request_experience   service role only (the booking page). The booking must be pending or confirmed, or checked in; at most
--                              5 requests that are still requested or confirmed (POLICY_VIOLATION: experience limit); the date, when given,
--                              inside the stay (experience date); quantity 1 to 20 (experience quantity); note up to 200 (experience note). A bad
--                              experience id (not this hotel's, or switched off) is NOT_FOUND: experience. Audited as experience.requested.
--   guest_experience_requests  service role only: the booking's own requests for its page (name, quantity, date, status, total).
--   experience_requests_open   folio.charge at that hotel: requests still requested or confirmed, oldest first, with the guest's
--                              booking code, arrival and departure and, for a person who may see guests, nothing more than the
--                              contact name already on the booking.
--   experience_request_set     folio.charge: action 'confirm' (requested to confirmed), 'decline' (requested or confirmed to declined)
--                              or 'charge' (confirmed to charged, posts a folio charge through post_folio_charge, which needs the
--                              guest to be checked in or out; INVALID_STATE otherwise). A repeat of the same step is a no-op.
--                              Audited as experience.confirmed / declined / charged.

-- ---- places -----------------------------------------------------------------------------
alter table hotel_places
  add column category text not null default 'other' check (category in ('dining', 'sights', 'nightlife', 'wellness', 'shopping', 'other')),
  add column link_url text check (link_url is null or (link_url ~ '^https://[^ "<>]+$' and length(link_url) <= 200));

drop function save_hotel_place(uuid, uuid, text, text, boolean, integer);
create function save_hotel_place(p_property uuid, p_place uuid, p_name text, p_body text, p_active boolean, p_sort integer default 0,
                                 p_category text default 'other', p_link text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prop properties%rowtype; v_actor uuid; v_id uuid; v_name text := btrim(coalesce(p_name, '')); v_body text := btrim(coalesce(p_body, ''));
  v_cat text := coalesce(nullif(btrim(coalesce(p_category, '')), ''), 'other'); v_link text := nullif(btrim(coalesce(p_link, '')), '');
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;   -- a person, never the system

  if length(v_name) not between 1 and 60 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if length(v_body) > 140 then raise exception 'POLICY_VIOLATION: text' using errcode = 'P0001'; end if;
  if v_cat not in ('dining', 'sights', 'nightlife', 'wellness', 'shopping', 'other') then raise exception 'POLICY_VIOLATION: category' using errcode = 'P0001'; end if;
  if v_link is not null and not (v_link ~ '^https://[^ "<>]+$' and length(v_link) <= 200) then raise exception 'POLICY_VIOLATION: link' using errcode = 'P0001'; end if;

  if p_place is null then
    if (select count(*) from hotel_places where property_id = p_property) >= 8 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
    insert into hotel_places (tenant_id, property_id, name, body, is_active, sort_order, category, link_url)
    values (v_prop.tenant_id, p_property, v_name, v_body, coalesce(p_active, true), coalesce(p_sort, 0), v_cat, v_link)
    returning id into v_id;
  else
    update hotel_places set name = v_name, body = v_body, is_active = coalesce(p_active, true), sort_order = coalesce(p_sort, sort_order),
           category = v_cat, link_url = v_link, updated_at = now()
     where id = p_place and property_id = p_property
     returning id into v_id;
    if v_id is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  end if;

  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'hotel_place.saved', 'hotel_place', v_id, null,
                      jsonb_build_object('name', v_name, 'active', coalesce(p_active, true), 'created', p_place is null, 'category', v_cat));
  return jsonb_build_object('place_id', v_id);
end $$;
revoke all on function save_hotel_place(uuid, uuid, text, text, boolean, integer, text, text) from public, anon;
grant execute on function save_hotel_place(uuid, uuid, text, text, boolean, integer, text, text) to authenticated;

create or replace function guest_places(p_host text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_property uuid;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  return jsonb_build_object('places', coalesce((
    select jsonb_agg(jsonb_build_object('name', x.name, 'body', x.body, 'category', x.category, 'link', x.link_url) order by x.sort_order, x.created_at)
      from hotel_places x where x.property_id = v_property and x.is_active), '[]'::jsonb));
end $$;

-- ---- experiences ------------------------------------------------------------------------
create table hotel_experiences (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  property_id uuid not null,
  name        text not null check (length(btrim(name)) between 1 and 60),
  body        text not null default '' check (length(body) <= 200),
  price_minor bigint not null check (price_minor > 0 and price_minor <= 1000000000),
  unit        text not null default 'person' check (unit in ('person', 'booking')),
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  unique (tenant_id, property_id, id)
);
create index hotel_experiences_property_idx on hotel_experiences (property_id, sort_order, created_at);
alter table hotel_experiences enable row level security;
create policy hotel_experiences_select on hotel_experiences for select to authenticated using (has_permission(property_id, 'property.configure'));
revoke insert, update, delete on hotel_experiences from authenticated, anon;

create table experience_requests (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  property_id       uuid not null,
  reservation_id    uuid not null,
  experience_id     uuid not null,
  quantity          integer not null check (quantity between 1 and 20),
  preferred_date    date,
  note              text check (note is null or length(note) <= 200),
  name_at_request   text not null,
  unit_price_minor  bigint not null check (unit_price_minor > 0),
  unit              text not null check (unit in ('person', 'booking')),
  status            text not null default 'requested' check (status in ('requested', 'confirmed', 'declined', 'charged')),
  folio_charge_id   uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (tenant_id, property_id, reservation_id) references reservations (tenant_id, property_id, id),
  foreign key (tenant_id, property_id, experience_id) references hotel_experiences (tenant_id, property_id, id),
  check ((status = 'charged') = (folio_charge_id is not null))
);
create index experience_requests_reservation_idx on experience_requests (reservation_id);
create index experience_requests_open_idx on experience_requests (property_id, created_at) where status in ('requested', 'confirmed');
alter table experience_requests enable row level security;
create policy experience_requests_select on experience_requests for select to authenticated using (has_permission(property_id, 'folio.charge'));
revoke insert, update, delete on experience_requests from authenticated, anon;

create function save_hotel_experience(p_property uuid, p_experience uuid, p_name text, p_body text, p_price bigint, p_unit text,
                                      p_active boolean, p_sort integer default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prop properties%rowtype; v_actor uuid; v_id uuid; v_name text := btrim(coalesce(p_name, '')); v_body text := btrim(coalesce(p_body, ''));
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;

  if length(v_name) not between 1 and 60 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if length(v_body) > 200 then raise exception 'POLICY_VIOLATION: text' using errcode = 'P0001'; end if;
  if p_price is null or p_price not between 1 and 1000000000 then raise exception 'POLICY_VIOLATION: price' using errcode = 'P0001'; end if;
  if p_unit is null or p_unit not in ('person', 'booking') then raise exception 'POLICY_VIOLATION: unit' using errcode = 'P0001'; end if;

  if p_experience is null then
    if (select count(*) from hotel_experiences where property_id = p_property) >= 12 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
    insert into hotel_experiences (tenant_id, property_id, name, body, price_minor, unit, is_active, sort_order)
    values (v_prop.tenant_id, p_property, v_name, v_body, p_price, p_unit, coalesce(p_active, true), coalesce(p_sort, 0))
    returning id into v_id;
  else
    update hotel_experiences set name = v_name, body = v_body, price_minor = p_price, unit = p_unit, is_active = coalesce(p_active, true),
           sort_order = coalesce(p_sort, sort_order), updated_at = now()
     where id = p_experience and property_id = p_property
     returning id into v_id;
    if v_id is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  end if;

  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'hotel_experience.saved', 'hotel_experience', v_id, null,
                      jsonb_build_object('name', v_name, 'price_minor', p_price, 'unit', p_unit, 'active', coalesce(p_active, true), 'created', p_experience is null));
  return jsonb_build_object('experience_id', v_id);
end $$;
revoke all on function save_hotel_experience(uuid, uuid, text, text, bigint, text, boolean, integer) from public, anon;
grant execute on function save_hotel_experience(uuid, uuid, text, text, bigint, text, boolean, integer) to authenticated;

create function delete_hotel_experience(p_experience uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o hotel_experiences%rowtype; v_actor uuid;
begin
  select * into o from hotel_experiences where id = p_experience;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(o.property_id, 'property.configure', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if exists (select 1 from experience_requests where experience_id = o.id) then raise exception 'INVALID_STATE: used' using errcode = 'P0001'; end if;
  delete from hotel_experiences where id = p_experience;
  perform write_audit(o.tenant_id, o.property_id, v_actor, 'hotel_experience.deleted', 'hotel_experience', o.id, null, jsonb_build_object('name', o.name));
end $$;
revoke all on function delete_hotel_experience(uuid) from public, anon;
grant execute on function delete_hotel_experience(uuid) to authenticated;

create function guest_experiences(p_host text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_property uuid; v_currency char(3);
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  select currency into v_currency from properties where id = v_property;
  return jsonb_build_object('currency', v_currency, 'experiences', coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'body', x.body, 'price_minor', x.price_minor, 'unit', x.unit)
                     order by x.sort_order, x.created_at)
      from hotel_experiences x where x.property_id = v_property and x.is_active), '[]'::jsonb));
end $$;
revoke all on function guest_experiences(text) from public, anon, authenticated;
grant execute on function guest_experiences(text) to service_role;

create function guest_request_experience(p_reservation_id uuid, p_experience uuid, p_quantity integer, p_date date, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; e hotel_experiences%rowtype; v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_id uuid;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into r from reservations where id = p_reservation_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if r.reservation_status not in ('pending', 'confirmed', 'checked_in') then raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001'; end if;
  select * into e from hotel_experiences where id = p_experience and property_id = r.property_id and is_active;
  if not found then raise exception 'NOT_FOUND: experience' using errcode = 'P0001'; end if;
  if p_quantity is null or p_quantity not between 1 and 20 then raise exception 'POLICY_VIOLATION: experience quantity' using errcode = 'P0001'; end if;
  if p_date is not null and (p_date < r.arrival_date or p_date >= r.departure_date) then raise exception 'POLICY_VIOLATION: experience date' using errcode = 'P0001'; end if;
  if v_note is not null and length(v_note) > 200 then raise exception 'POLICY_VIOLATION: experience note' using errcode = 'P0001'; end if;
  if (select count(*) from experience_requests where reservation_id = r.id and status in ('requested', 'confirmed')) >= 5 then
    raise exception 'POLICY_VIOLATION: experience limit' using errcode = 'P0001';
  end if;

  insert into experience_requests (tenant_id, property_id, reservation_id, experience_id, quantity, preferred_date, note, name_at_request, unit_price_minor, unit)
  values (r.tenant_id, r.property_id, r.id, e.id, p_quantity, p_date, v_note, e.name, e.price_minor, e.unit)
  returning id into v_id;
  perform write_audit(r.tenant_id, r.property_id, null, 'experience.requested', 'experience_request', v_id, null,
                      jsonb_build_object('reservation_id', r.id, 'experience', e.name, 'quantity', p_quantity));
  return jsonb_build_object('request_id', v_id);
end $$;
revoke all on function guest_request_experience(uuid, uuid, integer, date, text) from public, anon, authenticated;
grant execute on function guest_request_experience(uuid, uuid, integer, date, text) to service_role;

create function guest_experience_requests(p_reservation_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  return jsonb_build_object('requests', coalesce((
    select jsonb_agg(jsonb_build_object('name', q.name_at_request, 'quantity', q.quantity, 'date', q.preferred_date, 'status', q.status,
                                        'total_minor', case when q.unit = 'person' then q.quantity * q.unit_price_minor else q.unit_price_minor end)
                     order by q.created_at)
      from experience_requests q where q.reservation_id = p_reservation_id), '[]'::jsonb));
end $$;
revoke all on function guest_experience_requests(uuid) from public, anon, authenticated;
grant execute on function guest_experience_requests(uuid) to service_role;

create function experience_requests_open(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_actor uuid;
begin
  v_actor := require_permission(p_property, 'folio.charge', 'NOT_FOUND');
  return jsonb_build_object('requests', coalesce((
    select jsonb_agg(jsonb_build_object('id', q.id, 'reservation_id', q.reservation_id, 'booking_code', r.booking_reference, 'name', q.name_at_request,
                                        'quantity', q.quantity, 'date', q.preferred_date, 'note', q.note, 'status', q.status,
                                        'total_minor', case when q.unit = 'person' then q.quantity * q.unit_price_minor else q.unit_price_minor end,
                                        'reservation_status', r.reservation_status, 'arrival_date', r.arrival_date, 'departure_date', r.departure_date)
                     order by q.created_at)
      from experience_requests q join reservations r on r.id = q.reservation_id
     where q.property_id = p_property and q.status in ('requested', 'confirmed')), '[]'::jsonb));
end $$;
revoke all on function experience_requests_open(uuid) from public, anon;
grant execute on function experience_requests_open(uuid) to authenticated;

create function experience_request_set(p_request uuid, p_action text, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  q experience_requests%rowtype; r reservations%rowtype; v_actor uuid; v_qty integer; v_res jsonb; v_charge uuid;
begin
  select * into q from experience_requests where id = p_request;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(q.property_id, 'folio.charge', 'NOT_FOUND');
  if p_action is null or p_action not in ('confirm', 'decline', 'charge') then raise exception 'POLICY_VIOLATION: action' using errcode = 'P0001'; end if;
  select * into r from reservations where id = q.reservation_id for update;
  select * into q from experience_requests where id = p_request for update;

  if p_action = 'confirm' then
    if q.status = 'confirmed' then return jsonb_build_object('status', 'confirmed'); end if;
    if q.status <> 'requested' then raise exception 'INVALID_STATE: %', q.status using errcode = 'P0001'; end if;
    update experience_requests set status = 'confirmed', updated_at = now() where id = q.id;
  elsif p_action = 'decline' then
    if q.status = 'declined' then return jsonb_build_object('status', 'declined'); end if;
    if q.status not in ('requested', 'confirmed') then raise exception 'INVALID_STATE: %', q.status using errcode = 'P0001'; end if;
    update experience_requests set status = 'declined', updated_at = now() where id = q.id;
  else
    if q.status = 'charged' then return jsonb_build_object('status', 'charged', 'charge_id', q.folio_charge_id); end if;
    if q.status <> 'confirmed' then raise exception 'INVALID_STATE: %', q.status using errcode = 'P0001'; end if;
    if r.reservation_status not in ('checked_in', 'checked_out') then raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001'; end if;
    v_qty := case when q.unit = 'person' then q.quantity else 1 end;
    v_res := post_folio_charge(q.reservation_id, 'other', left('Experience: ' || q.name_at_request, 200), v_qty, q.unit_price_minor,
                               'exp-' || q.id::text || '-' || coalesce(p_key, 'x'), null, null);
    v_charge := (v_res ->> 'charge_id')::uuid;
    update experience_requests set status = 'charged', folio_charge_id = v_charge, updated_at = now() where id = q.id;
  end if;

  perform write_audit(q.tenant_id, q.property_id, v_actor, 'experience.' || case p_action when 'confirm' then 'confirmed' when 'decline' then 'declined' else 'charged' end,
                      'experience_request', q.id, null, jsonb_build_object('reservation_id', q.reservation_id, 'experience', q.name_at_request));
  return jsonb_build_object('status', case p_action when 'confirm' then 'confirmed' when 'decline' then 'declined' else 'charged' end);
end $$;
revoke all on function experience_request_set(uuid, text, text) from public, anon;
grant execute on function experience_request_set(uuid, text, text) to authenticated;
