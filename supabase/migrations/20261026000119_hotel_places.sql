-- 119 "Near the hotel": places a guest might visit, shown on the guest homepage.
--
-- The prototype's homepage has an "Experience" section (for example Mapo Hall, Agodi Gardens). Each hotel writes its own list: a name
-- and a line of text. Plain text only: no photos, links, prices or opening hours, so nothing here can go out of date in a way that
-- misleads a booking.
--
--   hotel_places        one row per place. Staff with property.configure may read it; every write goes through save_hotel_place and
--                       delete_hotel_place (no direct insert, update or delete).
--   save_hotel_place    creates (p_place null) or edits a place. Name 1 to 60 characters, text up to 140. At most 8 per hotel
--                       (POLICY_VIOLATION: limit). Audited as hotel_place.saved.
--   delete_hotel_place  removes a place. Audited as hotel_place.deleted.
--   guest_places(host)  what the homepage shows: service_role only, the host picks the hotel (resolve_host), switched-on places in the
--                       hotel's order (sort, then creation). No ids, tenant or property.
-- Errors: NOT_FOUND (also for no permission or another hotel), POLICY_VIOLATION: name | text | limit.

create table hotel_places (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  property_id uuid not null,
  name        text not null check (length(btrim(name)) between 1 and 60),
  body        text not null default '' check (length(body) <= 140),
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id)
);
create index hotel_places_property_idx on hotel_places (property_id, sort_order, created_at);

alter table hotel_places enable row level security;
create policy hotel_places_select on hotel_places for select to authenticated using (has_permission(property_id, 'property.configure'));
revoke insert, update, delete on hotel_places from authenticated, anon;

create function save_hotel_place(p_property uuid, p_place uuid, p_name text, p_body text, p_active boolean, p_sort integer default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prop properties%rowtype; v_actor uuid; v_id uuid; v_name text := btrim(coalesce(p_name, '')); v_body text := btrim(coalesce(p_body, ''));
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;   -- a person, never the system

  if length(v_name) not between 1 and 60 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if length(v_body) > 140 then raise exception 'POLICY_VIOLATION: text' using errcode = 'P0001'; end if;

  if p_place is null then
    if (select count(*) from hotel_places where property_id = p_property) >= 8 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
    insert into hotel_places (tenant_id, property_id, name, body, is_active, sort_order)
    values (v_prop.tenant_id, p_property, v_name, v_body, coalesce(p_active, true), coalesce(p_sort, 0))
    returning id into v_id;
  else
    update hotel_places set name = v_name, body = v_body, is_active = coalesce(p_active, true), sort_order = coalesce(p_sort, sort_order), updated_at = now()
     where id = p_place and property_id = p_property
     returning id into v_id;
    if v_id is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  end if;

  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'hotel_place.saved', 'hotel_place', v_id, null,
                      jsonb_build_object('name', v_name, 'active', coalesce(p_active, true), 'created', p_place is null));
  return jsonb_build_object('place_id', v_id);
end $$;
revoke all on function save_hotel_place(uuid, uuid, text, text, boolean, integer) from public, anon;
grant execute on function save_hotel_place(uuid, uuid, text, text, boolean, integer) to authenticated;

create function delete_hotel_place(p_place uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o hotel_places%rowtype; v_actor uuid;
begin
  select * into o from hotel_places where id = p_place;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(o.property_id, 'property.configure', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  delete from hotel_places where id = p_place;
  perform write_audit(o.tenant_id, o.property_id, v_actor, 'hotel_place.deleted', 'hotel_place', o.id, null, jsonb_build_object('name', o.name));
end $$;
revoke all on function delete_hotel_place(uuid) from public, anon;
grant execute on function delete_hotel_place(uuid) to authenticated;

create function guest_places(p_host text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_property uuid;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  return jsonb_build_object('places', coalesce((
    select jsonb_agg(jsonb_build_object('name', x.name, 'body', x.body) order by x.sort_order, x.created_at)
      from hotel_places x where x.property_id = v_property and x.is_active), '[]'::jsonb));
end $$;
revoke all on function guest_places(text) from public, anon, authenticated;
grant execute on function guest_places(text) to service_role;
