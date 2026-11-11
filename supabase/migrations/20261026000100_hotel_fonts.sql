-- 100 Optional heading and body fonts for the hotel's look, laid over the chosen theme (or the standard look).
--
-- theme_font_display: 'playfair', 'sora', 'lora' or 'outfit'; theme_font_body: 'inter' or 'source-serif'. Null = the theme's own
-- font. Only the key is stored: the font stacks live in the app (lib/theme.ts), so an unknown value can never reach a style
-- attribute (the checks below, and the app ignores anything else). Presentation only.
-- set_hotel_fonts(property, display, body): property.configure at that hotel (anyone else NOT_FOUND); blank or null clears one;
-- any other value is refused (INVALID_FONT). The audit trigger lists both columns; guest_hotel returns them as `font_display`
-- and `font_body`.

alter table properties
  add column theme_font_display text,
  add column theme_font_body text,
  add constraint properties_theme_font_display_check check (theme_font_display is null or theme_font_display in ('playfair', 'sora', 'lora', 'outfit')),
  add constraint properties_theme_font_body_check check (theme_font_body is null or theme_font_body in ('inter', 'source-serif'));

drop trigger properties_audit on properties;
create trigger properties_audit after insert or update or delete on properties
  for each row execute function audit_config_row('property', 'name,code,address,city,state,country_code,timezone,currency,check_in_time,check_out_time,status,phone,contact_email,intro,logo_path,theme,theme_primary,theme_font_display,theme_font_body');

create function set_hotel_fonts(p_property uuid, p_display text, p_body text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_display text := nullif(lower(btrim(coalesce(p_display, ''))), '');
  v_body text := nullif(lower(btrim(coalesce(p_body, ''))), '');
begin
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if v_display is not null and v_display not in ('playfair', 'sora', 'lora', 'outfit') then raise exception 'INVALID_FONT' using errcode = 'P0001'; end if;
  if v_body is not null and v_body not in ('inter', 'source-serif') then raise exception 'INVALID_FONT' using errcode = 'P0001'; end if;
  update properties set theme_font_display = v_display, theme_font_body = v_body where id = p_property;
end $$;
revoke all on function set_hotel_fonts(uuid, text, text) from public, anon;
grant execute on function set_hotel_fonts(uuid, text, text) to authenticated;

create or replace function guest_hotel(p_host text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_property uuid; r record;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  select name, address, city, state, check_in_time, check_out_time, phone, contact_email, intro, logo_path, theme, theme_primary, theme_font_display, theme_font_body into r from properties where id = v_property;
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
    'font_body', r.theme_font_body);
end $$;
