-- 106 One room type for the guest Room Details page (prototype "Room Details"): all its pictures, amenities, capacity and the
-- nightly rate for the next nights, so a visitor sees what a night costs before choosing dates.
--
-- guest_room_type(host, room_type, from_date, nights) follows guest_room_types (096): service_role only, the host picks the hotel
-- through resolve_host, no tenant or property id in the answer. A room type that is not public, not active, has no active room, or
-- belongs to another hotel is NOT_FOUND (the same answer for all of them, so nothing is learned about other hotels).
--   * `nights` lists one entry per night from from_date (never earlier than the hotel's today; null means today), at most 31, at
--     least 1 (default 14). rate_minor is the nightly rate on the default rate plan (resolve_rate, so a seasonal rate shows), before
--     tax; a night whose rate cannot be worked out is listed with null, not left out. With no default rate plan every night is null.
--   * `from_rate_minor` is the first night's rate when there is one (null otherwise), like 096.

create function guest_room_type(p_host text, p_room_type uuid, p_from date default null, p_nights integer default 14)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_property uuid; v_today date; v_start date; v_n integer := least(greatest(coalesce(p_nights, 14), 1), 31);
  v_plan uuid; v_currency text; t room_types%rowtype; v_nights jsonb := '[]'::jsonb; v_rate bigint; v_first bigint; d date;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  v_today := property_today(v_property);
  v_start := greatest(coalesce(p_from, v_today), v_today);
  select currency into v_currency from properties where id = v_property;
  select id into v_plan from rate_plans where property_id = v_property and is_default and status = 'active';

  select * into t from room_types rt
   where rt.id = p_room_type and rt.property_id = v_property and rt.is_public and rt.status = 'active'
     and exists (select 1 from rooms r where r.room_type_id = rt.id and r.operational_status = 'active');
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;

  for i in 0 .. v_n - 1 loop
    d := v_start + i;
    v_rate := null;
    if v_plan is not null then
      begin
        select amount_minor into v_rate from resolve_rate(v_property, t.id, v_plan, d);
      exception when sqlstate 'P0001' then
        v_rate := null;   -- RATE_MISSING for that night
      end;
    end if;
    if i = 0 then v_first := v_rate; end if;
    v_nights := v_nights || jsonb_build_object('date', d, 'rate_minor', v_rate);
  end loop;

  return jsonb_build_object(
    'currency', v_currency,
    'room_type', jsonb_build_object(
      'room_type_id', t.id, 'name', t.name, 'description', t.description, 'bed_config', t.bed_config,
      'amenities', to_jsonb(t.amenities),
      'photos', coalesce((select jsonb_agg(jsonb_build_object('path', p.storage_path, 'caption', p.caption) order by p.sort_order, p.created_at)
                            from room_type_photos p where p.room_type_id = t.id), '[]'::jsonb),
      'max_adults', t.max_adults, 'max_children', t.max_children, 'max_occupancy', t.max_occupancy,
      'from_rate_minor', v_first),
    'nights', v_nights);
end $$;

revoke all on function guest_room_type(text, uuid, date, integer) from public, anon, authenticated;
grant execute on function guest_room_type(text, uuid, date, integer) to service_role;
