-- 089 Editing the hotel's name, address, town, state and check-in and check-out times.
--
-- Like the profile in 087, these were set in SQL when the hotel was created. update_hotel_basics(property, name, address,
-- town, state, check_in, check_out) lets a person with property.configure change them (anyone else is told NOT_FOUND).
-- Name, town and state are required; the address may be blank (stored as null). Values are trimmed. The columns have their
-- own checks so no path can store a padded or oversized value. The code, time zone, currency and country stay as they are
-- (the code is immutable, the others affect money and dates).
--
-- The properties audit trigger (047, widened in 087) already records every one of these columns.
-- A time change applies to bookings made from now on where the booking stores its own check-in time (its policy snapshot);
-- other bookings follow the hotel's current time.

alter table properties
  add constraint properties_name_len_check check (name = btrim(name) and char_length(name) <= 120),
  add constraint properties_address_check check (address is null or char_length(address) <= 200),
  add constraint properties_city_check check (city = btrim(city) and char_length(city) between 1 and 80),
  add constraint properties_state_check check (state = btrim(state) and char_length(state) between 1 and 80);

create function update_hotel_basics(p_property uuid, p_name text, p_address text, p_city text, p_state text, p_check_in time, p_check_out time) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if p_check_in is null or p_check_out is null then raise exception 'INVALID_INPUT: times are required' using errcode = '22023'; end if;
  update properties set
    name = btrim(coalesce(p_name, '')),
    address = nullif(btrim(coalesce(p_address, '')), ''),
    city = btrim(coalesce(p_city, '')),
    state = btrim(coalesce(p_state, '')),
    check_in_time = p_check_in,
    check_out_time = p_check_out
  where id = p_property;
end $$;

revoke all on function update_hotel_basics(uuid, text, text, text, text, time, time) from public, anon;   -- STAGING step 4c: only three functions are callable by anon
grant execute on function update_hotel_basics(uuid, text, text, text, text, time, time) to authenticated;
