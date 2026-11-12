-- 118 Optional corner style for the hotel's look, laid over the chosen theme (or the standard look).
--
-- theme_radius: 'sharp' or 'round'. Null = the standard corners. Only the key is stored: what each key means in pixels lives in
-- the app (lib/theme.ts), so an unknown value can never reach a style attribute. Presentation only.
-- set_hotel_radius(property, radius): property.configure at that hotel (anyone else NOT_FOUND); the 'branding' plan flag must be
-- on (NOT_FOUND, like the other three setters); blank or null clears it; any other value is refused (INVALID_RADIUS).
-- The audit trigger lists the column; guest_hotel returns it as `radius`.

alter table properties
  add column theme_radius text,
  add constraint properties_theme_radius_check check (theme_radius is null or theme_radius in ('sharp', 'round'));

drop trigger properties_audit on properties;
create trigger properties_audit after insert or update or delete on properties
  for each row execute function audit_config_row('property', 'name,code,address,city,state,country_code,timezone,currency,check_in_time,check_out_time,status,phone,contact_email,intro,logo_path,theme,theme_primary,theme_font_display,theme_font_body,theme_radius,facilities,social_instagram,social_facebook');

create function set_hotel_radius(p_property uuid, p_radius text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_radius text := nullif(lower(btrim(coalesce(p_radius, ''))), '');
begin
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if not tenant_feature_on((select tenant_id from properties where id = p_property), 'branding') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if v_radius is not null and v_radius not in ('sharp', 'round') then raise exception 'INVALID_RADIUS' using errcode = 'P0001'; end if;
  update properties set theme_radius = v_radius where id = p_property;
end $$;
revoke all on function set_hotel_radius(uuid, text) from public, anon;
grant execute on function set_hotel_radius(uuid, text) to authenticated;

create or replace function guest_hotel(p_host text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_property uuid; r record;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  select name, address, city, state, check_in_time, check_out_time, phone, contact_email, intro, logo_path, theme, theme_primary, theme_font_display, theme_font_body, theme_radius, facilities, social_instagram, social_facebook into r from properties where id = v_property;
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
    'radius', r.theme_radius,
    'facilities', to_jsonb(r.facilities),
    'instagram', r.social_instagram,
    'facebook', r.social_facebook);
end $$;
