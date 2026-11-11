-- 102 Hotel offers for the guest homepage.
--
-- An offer is a short promotion the hotel writes itself ("Weekend escape", "Stay 3 nights"): a title, a line of text, an optional
-- badge ("10% off") and an optional window of dates. It is a message on the homepage and nothing else: it does not change a price,
-- a rate or a booking (discounts, applied by staff, are separate). A hotel that wants a real price change changes its rates.
--
--   hotel_offers            one row per offer. Staff with property.configure at the hotel may read it; every write goes through
--                           save_hotel_offer and delete_hotel_offer (no direct insert, update or delete).
--   save_hotel_offer        creates (p_offer null) or edits an offer. Title 1 to 80 characters, text up to 300, badge up to 24.
--                           A date window must not end before it starts. At most 12 offers a hotel (POLICY_VIOLATION: limit).
--                           Audited as hotel_offer.saved.
--   delete_hotel_offer      removes an offer. Audited as hotel_offer.deleted.
--   guest_offers(host)      what the homepage shows: service_role only, the host picks the hotel (resolve_host), active offers whose
--                           window includes the hotel's today, at most 6, in the hotel's order. No ids, tenant or property.
-- Errors: NOT_FOUND (also for no permission or another hotel), POLICY_VIOLATION: title | text | badge | dates | limit.

create table hotel_offers (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  property_id uuid not null,
  title       text not null check (length(btrim(title)) between 1 and 80),
  body        text not null default '' check (length(body) <= 300),
  badge       text check (badge is null or length(btrim(badge)) between 1 and 24),
  valid_from  date,
  valid_to    date,
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);
create index hotel_offers_property_idx on hotel_offers (property_id, sort_order, created_at);

alter table hotel_offers enable row level security;
create policy hotel_offers_select on hotel_offers for select to authenticated using (has_permission(property_id, 'property.configure'));
revoke insert, update, delete on hotel_offers from authenticated, anon;

create function save_hotel_offer(p_property uuid, p_offer uuid, p_title text, p_body text, p_badge text,
                                 p_valid_from date, p_valid_to date, p_active boolean, p_sort integer default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prop properties%rowtype; v_actor uuid; v_id uuid; v_title text := btrim(coalesce(p_title, ''));
  v_body text := btrim(coalesce(p_body, '')); v_badge text := nullif(btrim(coalesce(p_badge, '')), '');
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;   -- a person, never the system

  if length(v_title) not between 1 and 80 then raise exception 'POLICY_VIOLATION: title' using errcode = 'P0001'; end if;
  if length(v_body) > 300 then raise exception 'POLICY_VIOLATION: text' using errcode = 'P0001'; end if;
  if v_badge is not null and length(v_badge) > 24 then raise exception 'POLICY_VIOLATION: badge' using errcode = 'P0001'; end if;
  if p_valid_from is not null and p_valid_to is not null and p_valid_to < p_valid_from then
    raise exception 'POLICY_VIOLATION: dates' using errcode = 'P0001';
  end if;

  if p_offer is null then
    if (select count(*) from hotel_offers where property_id = p_property) >= 12 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
    insert into hotel_offers (tenant_id, property_id, title, body, badge, valid_from, valid_to, is_active, sort_order)
    values (v_prop.tenant_id, p_property, v_title, v_body, v_badge, p_valid_from, p_valid_to, coalesce(p_active, true), coalesce(p_sort, 0))
    returning id into v_id;
  else
    update hotel_offers set title = v_title, body = v_body, badge = v_badge, valid_from = p_valid_from, valid_to = p_valid_to,
                            is_active = coalesce(p_active, true), sort_order = coalesce(p_sort, sort_order), updated_at = now()
     where id = p_offer and property_id = p_property
     returning id into v_id;
    if v_id is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  end if;

  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'hotel_offer.saved', 'hotel_offer', v_id, null,
                      jsonb_build_object('title', v_title, 'active', coalesce(p_active, true), 'created', p_offer is null));
  return jsonb_build_object('offer_id', v_id);
end $$;
revoke all on function save_hotel_offer(uuid, uuid, text, text, text, date, date, boolean, integer) from public, anon;
grant execute on function save_hotel_offer(uuid, uuid, text, text, text, date, date, boolean, integer) to authenticated;

create function delete_hotel_offer(p_offer uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o hotel_offers%rowtype; v_actor uuid;
begin
  select * into o from hotel_offers where id = p_offer;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(o.property_id, 'property.configure', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  delete from hotel_offers where id = p_offer;
  perform write_audit(o.tenant_id, o.property_id, v_actor, 'hotel_offer.deleted', 'hotel_offer', o.id, null, jsonb_build_object('title', o.title));
end $$;
revoke all on function delete_hotel_offer(uuid) from public, anon;
grant execute on function delete_hotel_offer(uuid) to authenticated;

create function guest_offers(p_host text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_property uuid; v_today date;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  v_today := property_today(v_property);
  return jsonb_build_object('offers', coalesce((
    select jsonb_agg(jsonb_build_object('title', o.title, 'body', o.body, 'badge', o.badge, 'valid_to', o.valid_to)
                     order by o.sort_order, o.created_at)
      from (select * from hotel_offers x
             where x.property_id = v_property and x.is_active
               and (x.valid_from is null or x.valid_from <= v_today) and (x.valid_to is null or x.valid_to >= v_today)
             order by x.sort_order, x.created_at limit 6) o), '[]'::jsonb));
end $$;
revoke all on function guest_offers(text) from public, anon, authenticated;
grant execute on function guest_offers(text) to service_role;
