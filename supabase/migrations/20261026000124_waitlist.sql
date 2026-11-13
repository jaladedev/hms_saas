-- 124 Waitlist, staff-called: a guest who finds a room type sold out for their dates leaves a name, email and phone; staff see the
-- list, a badge when a room has since freed up, and contact the guest themselves. No email is sent and no money is involved.
--
--   waitlist_requests          one row per request. Staff with reservation.view may read; all writes go through the functions.
--   guest_join_waitlist(host, room_type, arrival, departure, adults, children, name, email, phone)
--                              service_role (the app rate limits). Host picks the hotel (resolve_host). Same date and party rules as
--                              search_availability. NOT_FOUND: unknown or non public room type; POLICY_VIOLATION: waitlist dates | party | name |
--                              email | phone | rooms free (a room is free now, so book instead) | too many requests (3 waiting per email
--                              and hotel). The same email asking again for the same type and dates is a no-op that returns the
--                              existing id (`created` false).
--   waitlist_list(property)    reservation.view. Open requests (waiting or contacted) whose arrival is today or later, soonest first,
--                              with the room type name and `rooms_free_now` (same rule as search_availability).
--   waitlist_set_status(id, status)
--                              reservation.modify. 'waiting' | 'contacted' | 'closed'. NOT_FOUND for no permission, another hotel
--                              or unknown. Audited as waitlist.status.
--   purge_old_operational_data() also deletes requests whose departure was more than 30 days ago (personal data is not kept).

create table waitlist_requests (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  property_id    uuid not null,
  room_type_id   uuid not null references room_types(id),
  arrival_date   date not null,
  departure_date date not null check (departure_date > arrival_date),
  adults         smallint not null check (adults between 1 and 20),
  children       smallint not null default 0 check (children between 0 and 20),
  guest_name     text not null check (length(guest_name) between 2 and 80),
  email          text not null check (length(email) between 5 and 254),
  phone          text check (phone is null or length(phone) <= 32),
  status         text not null default 'waiting' check (status in ('waiting', 'contacted', 'closed')),
  created_at     timestamptz not null default now(),
  handled_by     uuid,
  handled_at     timestamptz,
  foreign key (tenant_id, property_id) references properties (tenant_id, id)
);
create index waitlist_requests_property_idx on waitlist_requests (property_id, status, arrival_date);
create unique index waitlist_requests_once on waitlist_requests (property_id, room_type_id, arrival_date, departure_date, lower(email))
  where status <> 'closed';

alter table waitlist_requests enable row level security;
create policy waitlist_requests_select on waitlist_requests for select to authenticated using (has_permission(property_id, 'reservation.view'));
revoke insert, update, delete on waitlist_requests from authenticated, anon;

-- Rooms of a type free for the dates: the rule search_availability uses.
create function waitlist_free_rooms(p_property uuid, p_room_type uuid, p_arrival date, p_departure date) returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::integer from rooms r
   where r.property_id = p_property and r.room_type_id = p_room_type and r.operational_status = 'active'
     and not exists (
       select 1 from room_inventory_claims c
        where c.room_id = r.id and c.status = 'active'
          and (c.claim_type <> 'hold' or c.hold_expires_at > now())
          and daterange(c.start_date, c.end_date, '[)') && daterange(p_arrival, p_departure, '[)'));
$$;
revoke all on function waitlist_free_rooms(uuid, uuid, date, date) from public, anon, authenticated;

create function guest_join_waitlist(p_host text, p_room_type uuid, p_arrival date, p_departure date, p_adults integer, p_children integer,
                                    p_name text, p_email text, p_phone text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid; v_property uuid; v_today date; t room_types%rowtype; v_name text := btrim(coalesce(p_name, ''));
  v_email text := lower(btrim(coalesce(p_email, ''))); v_phone text := nullif(btrim(coalesce(p_phone, '')), ''); v_id uuid;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.tenant_id, h.property_id into v_tenant, v_property from resolve_host(p_host) h;
  v_today := property_today(v_property);

  if p_arrival is null or p_departure is null or p_departure <= p_arrival or p_arrival < v_today
     or p_departure - p_arrival > 30 or p_arrival > v_today + 365 then
    raise exception 'POLICY_VIOLATION: waitlist dates' using errcode = 'P0001';
  end if;
  if p_adults is null or p_adults < 1 or p_adults > 20 or p_children is null or p_children < 0 or p_children > 20 then
    raise exception 'POLICY_VIOLATION: waitlist party' using errcode = 'P0001';
  end if;
  if length(v_name) < 2 or length(v_name) > 80 then raise exception 'POLICY_VIOLATION: waitlist name' using errcode = 'P0001'; end if;
  if length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'POLICY_VIOLATION: waitlist email' using errcode = 'P0001'; end if;
  if v_phone is not null and length(v_phone) > 32 then raise exception 'POLICY_VIOLATION: waitlist phone' using errcode = 'P0001'; end if;

  select * into t from room_types rt where rt.id = p_room_type and rt.property_id = v_property and rt.is_public and rt.status = 'active';
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_adults > t.max_adults or p_children > t.max_children or p_adults + p_children > t.max_occupancy then
    raise exception 'POLICY_VIOLATION: waitlist party' using errcode = 'P0001';
  end if;

  select id into v_id from waitlist_requests
   where property_id = v_property and room_type_id = t.id and arrival_date = p_arrival and departure_date = p_departure
     and lower(email) = v_email and status <> 'closed';
  if found then return jsonb_build_object('waitlist_id', v_id, 'created', false); end if;

  if waitlist_free_rooms(v_property, t.id, p_arrival, p_departure) > 0 then
    raise exception 'POLICY_VIOLATION: waitlist rooms free' using errcode = 'P0001';
  end if;
  if (select count(*) from waitlist_requests where property_id = v_property and lower(email) = v_email and status = 'waiting') >= 3 then
    raise exception 'POLICY_VIOLATION: waitlist too many requests' using errcode = 'P0001';
  end if;

  insert into waitlist_requests (tenant_id, property_id, room_type_id, arrival_date, departure_date, adults, children, guest_name, email, phone)
  values (v_tenant, v_property, t.id, p_arrival, p_departure, p_adults, p_children, v_name, v_email, v_phone)
  returning id into v_id;
  return jsonb_build_object('waitlist_id', v_id, 'created', true);
end $$;
revoke all on function guest_join_waitlist(text, uuid, date, date, integer, integer, text, text, text) from public, anon, authenticated;
grant execute on function guest_join_waitlist(text, uuid, date, date, integer, integer, text, text, text) to service_role;

create function waitlist_list(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission(p_property, 'reservation.view', 'NOT_FOUND');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', w.id, 'room_type', rt.name, 'arrival_date', w.arrival_date, 'departure_date', w.departure_date,
      'adults', w.adults, 'children', w.children, 'guest_name', w.guest_name, 'email', w.email, 'phone', w.phone,
      'status', w.status, 'created_at', w.created_at,
      'rooms_free_now', waitlist_free_rooms(w.property_id, w.room_type_id, w.arrival_date, w.departure_date))
      order by w.arrival_date, w.created_at)
    from waitlist_requests w join room_types rt on rt.id = w.room_type_id
   where w.property_id = p_property and w.status in ('waiting', 'contacted') and w.arrival_date >= property_today(p_property)
  ), '[]'::jsonb);
end $$;
revoke all on function waitlist_list(uuid) from public, anon;
grant execute on function waitlist_list(uuid) to authenticated;

create function waitlist_set_status(p_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare w waitlist_requests%rowtype; v_actor uuid;
begin
  select * into w from waitlist_requests where id = p_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(w.property_id, 'reservation.modify', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_status is null or p_status not in ('waiting', 'contacted', 'closed') then raise exception 'POLICY_VIOLATION: status' using errcode = 'P0001'; end if;
  if w.status <> p_status then
    update waitlist_requests set status = p_status, handled_by = v_actor, handled_at = now() where id = w.id;
    perform write_audit(w.tenant_id, w.property_id, v_actor, 'waitlist.status', 'waitlist_request', w.id, null,
                        jsonb_build_object('from', w.status, 'to', p_status));
  end if;
  return jsonb_build_object('waitlist_id', w.id, 'status', p_status, 'changed', w.status <> p_status);
end $$;
revoke all on function waitlist_set_status(uuid, text) from public, anon;
grant execute on function waitlist_set_status(uuid, text) to authenticated;

create or replace function purge_old_operational_data() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_rl integer; v_em integer; v_idem integer; v_wl integer;
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
  return jsonb_build_object('rate_limit_rows', v_rl, 'emails', v_em, 'idempotency_keys', v_idem, 'waitlist', v_wl);
end $$;
