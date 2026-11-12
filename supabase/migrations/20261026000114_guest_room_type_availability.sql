-- 114 Which nights of a room type are full, for the guest Room Details price calendar (106 gives the rates only).
--
-- guest_room_type_availability(host, room_type, from_date, nights) follows guest_room_type (106): service_role only, the host
-- picks the hotel through resolve_host, no tenant or property id, and a type that is not public, not active, has no active room or
-- belongs to another hotel is NOT_FOUND. It is a separate function so 106's answer is untouched.
--   * `nights` has one entry per night from from_date (never before the hotel's today; null means today), 1 to 31 like 106, each
--     `{date, available}`. available is whether a room of the type is free that night, on the rule search_availability (014) uses:
--     an active stay, block or unexpired hold on a room takes it, an expired hold does not. Only a yes or a no is given, never how many.

create function guest_room_type_availability(p_host text, p_room_type uuid, p_from date default null, p_nights integer default 14)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_property uuid; v_today date; v_start date; v_n integer := least(greatest(coalesce(p_nights, 14), 1), 31);
  d date; v_free integer; v_nights jsonb := '[]'::jsonb;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  v_today := property_today(v_property);
  v_start := greatest(coalesce(p_from, v_today), v_today);

  if not exists (
    select 1 from room_types rt
     where rt.id = p_room_type and rt.property_id = v_property and rt.is_public and rt.status = 'active'
       and exists (select 1 from rooms r where r.room_type_id = rt.id and r.operational_status = 'active')
  ) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;

  for i in 0 .. v_n - 1 loop
    d := v_start + i;
    select count(*) into v_free from rooms r
     where r.property_id = v_property and r.room_type_id = p_room_type and r.operational_status = 'active'
       and not exists (
         select 1 from room_inventory_claims c
          where c.room_id = r.id and c.status = 'active'
            and (c.claim_type <> 'hold' or c.hold_expires_at > now())
            and daterange(c.start_date, c.end_date, '[)') && daterange(d, d + 1, '[)'));
    v_nights := v_nights || jsonb_build_object('date', d, 'available', v_free > 0);
  end loop;

  return jsonb_build_object('nights', v_nights);
end $$;

revoke all on function guest_room_type_availability(text, uuid, date, integer) from public, anon, authenticated;
grant execute on function guest_room_type_availability(text, uuid, date, integer) to service_role;
