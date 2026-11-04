-- 041 Hotel identity for the guest site.
--
-- Until now the guest pages learned the hotel's name only from a search result, so the header could not say whose
-- site it was and the first screen said nothing about the hotel. guest_hotel(host) returns what a visitor may see
-- before they search: the name, the address, the town, and the check-in and check-out times.
--
-- It follows guest_policy: service_role only, the host picks the hotel through resolve_host (a verified domain of an
-- active tenant and an active property, else NOT_FOUND), and it returns no ids, no tenant, no timezone.

create function guest_hotel(p_host text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_property uuid; r record;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  select name, address, city, state, check_in_time, check_out_time into r from properties where id = v_property;
  return jsonb_build_object(
    'name', r.name,
    'address', nullif(trim(r.address), ''),
    'city', r.city,
    'state', r.state,
    'check_in_time', r.check_in_time,
    'check_out_time', r.check_out_time);
end $$;

revoke all on function guest_hotel(text) from public, anon, authenticated;
grant execute on function guest_hotel(text) to service_role;
