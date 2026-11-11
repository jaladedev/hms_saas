-- 105 Hotel facilities and social links for the guest site (prototype screen "Hotel Contact & Operational Settings").
--
-- The prototype lists the hotel's own facilities (Pool, Restaurant, Bar, Gym, Conference) and its Instagram and Facebook next to
-- the check-in and check-out times. Times, phone, email and introduction already exist (087, 089); this adds the rest. Room
-- amenities stay on each room type (077): these are what the hotel as a whole offers.
--
--   facilities        up to 20 plain-words entries, 1 to 40 characters each, trimmed, no repeats (the same rule as a room type's
--                     amenities, amenities_valid from 077), so a script cannot store anything else
--   social_instagram  null, or exactly https://instagram.com/<name> (optionally www. and a trailing slash); a name is 1 to 30
--                     letters, digits, dots or underscores
--   social_facebook   null, or exactly https://facebook.com/<name> (same shape); a name is 5 to 50 letters, digits, dots,
--                     underscores or hyphens
-- Only those two sites, over https, with a single plain path segment, are stored. The guest site turns these into links, so
-- a value that could be a script, another site or a tracking URL can never reach a page (the checks are on the table, and the
-- guest site checks again before it draws a link).
--
-- set_hotel_extras(property, facilities, instagram, facebook): property.configure at that hotel (anyone else NOT_FOUND). It
-- trims, drops blank facilities and stores a blank link as null; a value that fails the rules is refused as
-- POLICY_VIOLATION: facilities / instagram / facebook. The audit trigger lists the three columns; guest_hotel returns them as
-- `facilities` (an array, empty when none), `instagram` and `facebook` (null when not set).

-- The facilities check calls amenities_valid, and a CHECK runs with the rights of whoever updates the row. Staff (authenticated) keep
-- EXECUTE (079). The platform's own changes to a hotel (onboarding, the logo cleanup job) run as the service role, which must be
-- able to call it too, so that is granted here rather than left to a project's default privileges.
grant execute on function amenities_valid(text[]) to service_role;

alter table properties
  add column facilities text[] not null default '{}'::text[],
  add column social_instagram text,
  add column social_facebook text,
  add constraint properties_facilities_check check (amenities_valid(facilities)),
  add constraint properties_social_instagram_check check (social_instagram is null or social_instagram ~ '^https://(www[.])?instagram[.]com/[A-Za-z0-9._]{1,30}/?$'),
  add constraint properties_social_facebook_check check (social_facebook is null or social_facebook ~ '^https://(www[.])?facebook[.]com/[A-Za-z0-9._-]{5,50}/?$');

drop trigger properties_audit on properties;
create trigger properties_audit after insert or update or delete on properties
  for each row execute function audit_config_row('property', 'name,code,address,city,state,country_code,timezone,currency,check_in_time,check_out_time,status,phone,contact_email,intro,logo_path,theme,theme_primary,theme_font_display,theme_font_body,facilities,social_instagram,social_facebook');

create function set_hotel_extras(p_property uuid, p_facilities text[], p_instagram text, p_facebook text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_fac text[];
  v_ig text := nullif(btrim(coalesce(p_instagram, '')), '');
  v_fb text := nullif(btrim(coalesce(p_facebook, '')), '');
begin
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  select coalesce(array_agg(x order by ord), '{}'::text[]) into v_fac
    from (select nullif(btrim(e), '') as x, ord from unnest(coalesce(p_facilities, '{}'::text[])) with ordinality as t(e, ord)) s
   where x is not null;
  if not amenities_valid(v_fac) then raise exception 'POLICY_VIOLATION: facilities' using errcode = 'P0001'; end if;
  if v_ig is not null and v_ig !~ '^https://(www[.])?instagram[.]com/[A-Za-z0-9._]{1,30}/?$' then raise exception 'POLICY_VIOLATION: instagram' using errcode = 'P0001'; end if;
  if v_fb is not null and v_fb !~ '^https://(www[.])?facebook[.]com/[A-Za-z0-9._-]{5,50}/?$' then raise exception 'POLICY_VIOLATION: facebook' using errcode = 'P0001'; end if;
  update properties set facilities = v_fac, social_instagram = v_ig, social_facebook = v_fb where id = p_property;
end $$;
revoke all on function set_hotel_extras(uuid, text[], text, text) from public, anon;
grant execute on function set_hotel_extras(uuid, text[], text, text) to authenticated;

create or replace function guest_hotel(p_host text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_property uuid; r record;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  select name, address, city, state, check_in_time, check_out_time, phone, contact_email, intro, logo_path, theme, theme_primary, theme_font_display, theme_font_body, facilities, social_instagram, social_facebook into r from properties where id = v_property;
  return jsonb_build_object(
    'name', r.name,
    'address', nullif(trim(r.address), ''),
    'city', r.city,
    'state', r.state,
    'check_in_time', r.check_in_time,
    'check_out_time', r.check_out_time,
    'phone', r.phone,
    'email', r.contact_email,
    'intro', r.intro,
    'logo', r.logo_path,
    'theme', r.theme,
    'theme_primary', r.theme_primary,
    'font_display', r.theme_font_display,
    'font_body', r.theme_font_body,
    'facilities', to_jsonb(r.facilities),
    'instagram', r.social_instagram,
    'facebook', r.social_facebook);
end $$;
