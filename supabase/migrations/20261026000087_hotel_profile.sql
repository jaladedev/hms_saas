-- 087 Hotel profile for the guest site: a contact phone, a contact email and a short introduction.
--
-- Until now the hotel's public details (name, address, times) were set in SQL when the hotel was created and no screen could
-- change them. This adds three optional facts a visitor sees before they search, and one function so a person with
-- property.configure (owner, general manager) can change them. The columns have their own checks, so no path can store a
-- padded, blank or oversized value.
--
--   phone          5 to 32 characters: digits, spaces, + ( ) -
--   contact_email  up to 254 characters, one @ and a dot after it, no spaces
--   intro          1 to 500 characters, trimmed
--
-- update_hotel_profile(property, phone, email, intro): property.configure at that hotel (anyone else is told NOT_FOUND).
-- It trims every value and stores a blank one as null. The existing properties audit trigger now also records these three.
-- guest_hotel(host) returns them too (null when not filled in).

alter table properties
  add column phone text,
  add column contact_email text,
  add column intro text,
  add constraint properties_phone_check check (phone is null or (phone = btrim(phone) and phone ~ '^[0-9+() -]{5,32}$')),
  add constraint properties_contact_email_check check (contact_email is null or (contact_email = btrim(contact_email) and length(contact_email) <= 254 and contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$')),
  add constraint properties_intro_check check (intro is null or (intro = btrim(intro) and char_length(intro) between 1 and 500));

drop trigger properties_audit on properties;
create trigger properties_audit after insert or update or delete on properties
  for each row execute function audit_config_row('property', 'name,code,address,city,state,country_code,timezone,currency,check_in_time,check_out_time,status,phone,contact_email,intro');

create function update_hotel_profile(p_property uuid, p_phone text, p_email text, p_intro text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  update properties set
    phone = nullif(btrim(p_phone), ''),
    contact_email = nullif(btrim(p_email), ''),
    intro = nullif(btrim(p_intro), '')
  where id = p_property;
end $$;

revoke all on function update_hotel_profile(uuid, text, text, text) from public, anon;   -- STAGING step 4c: only three functions are callable by anon
grant execute on function update_hotel_profile(uuid, text, text, text) to authenticated;

create or replace function guest_hotel(p_host text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_property uuid; r record;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  select name, address, city, state, check_in_time, check_out_time, phone, contact_email, intro into r from properties where id = v_property;
  return jsonb_build_object(
    'name', r.name,
    'address', nullif(trim(r.address), ''),
    'city', r.city,
    'state', r.state,
    'check_in_time', r.check_in_time,
    'check_out_time', r.check_out_time,
    'phone', r.phone,
    'email', r.contact_email,
    'intro', r.intro);
end $$;
