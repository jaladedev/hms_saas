-- 096 Room types for the guest homepage.
--
-- The guest homepage (prototype "Bento Rooms") shows what the hotel sells before a visitor has chosen dates: each room type with
-- its pictures, amenities, capacity and a "from" price. search_availability needs dates and returns only what is free, so it cannot
-- feed that section.
--
-- guest_room_types(host) follows guest_hotel and guest_policy: service_role only, the host picks the hotel through resolve_host
-- (NOT_FOUND for an unknown, unverified or switched-off host), and it returns no ids except the room type id the reserve link
-- already carries, no tenant and no counts of rooms.
--   * Only room types a guest could book: public, active, with at least one active room, and a rate that can be worked out. Like
--     search_availability, a type with no rate (RATE_MISSING) is left out, and so is everything when there is no default rate plan.
--   * `from_rate_minor` is tonight's nightly rate on the default rate plan (resolve_rate, so a seasonal rate shows), before tax.
--   * Cheapest first, then by name. Pictures in the hotel's own order (as in search_availability, 080).

create function guest_room_types(p_host text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_property uuid; v_today date; v_plan uuid; v_currency text; v_rate bigint; t record; v_types jsonb := '[]'::jsonb;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  v_today := property_today(v_property);
  select currency into v_currency from properties where id = v_property;
  select id into v_plan from rate_plans where property_id = v_property and is_default and status = 'active';

  for t in
    select * from room_types rt
     where rt.property_id = v_property and rt.is_public and rt.status = 'active'
       and exists (select 1 from rooms r where r.room_type_id = rt.id and r.operational_status = 'active')
     order by rt.base_rate_minor, rt.name
  loop
    continue when v_plan is null;
    begin
      select amount_minor into v_rate from resolve_rate(v_property, t.id, v_plan, v_today);
    exception when sqlstate 'P0001' then
      continue;   -- RATE_MISSING: not bookable, not advertised
    end;
    v_types := v_types || jsonb_build_object(
      'room_type_id', t.id, 'name', t.name, 'description', t.description, 'bed_config', t.bed_config,
      'amenities', to_jsonb(t.amenities),
      'photos', coalesce((select jsonb_agg(jsonb_build_object('path', p.storage_path, 'caption', p.caption) order by p.sort_order, p.created_at)
                            from room_type_photos p where p.room_type_id = t.id), '[]'::jsonb),
      'max_adults', t.max_adults, 'max_children', t.max_children, 'max_occupancy', t.max_occupancy,
      'from_rate_minor', v_rate);
  end loop;

  return jsonb_build_object('currency', v_currency, 'room_types', v_types);
end $$;

revoke all on function guest_room_types(text) from public, anon, authenticated;
grant execute on function guest_room_types(text) to service_role;
