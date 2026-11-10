-- 093 A look for the hotel: one of three themes, shown on the guest site and in the staff app.
--
-- properties.theme is null (the standard look the app has always had), 'luxury', 'modern' or 'classic'. The colours and fonts
-- each name stands for live in the app (lib/theme.ts), not here: the database only records the choice, so a palette can be
-- tuned without a migration and an unknown value can never reach the page (the check below, and the app ignores anything else).
--
-- set_hotel_theme(property, theme): property.configure at that hotel (anyone else NOT_FOUND). Null or blank returns to the
-- standard look. Any other value than the three names is refused (INVALID_THEME).
-- The audit trigger lists theme; guest_hotel returns it as `theme` (null for the standard look).

alter table properties
  add column theme text,
  add constraint properties_theme_check check (theme is null or theme in ('luxury', 'modern', 'classic'));

drop trigger properties_audit on properties;
create trigger properties_audit after insert or update or delete on properties
  for each row execute function audit_config_row('property', 'name,code,address,city,state,country_code,timezone,currency,check_in_time,check_out_time,status,phone,contact_email,intro,logo_path,theme');

create function set_hotel_theme(p_property uuid, p_theme text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_theme text := nullif(btrim(coalesce(p_theme, '')), '');
begin
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if v_theme is not null and v_theme not in ('luxury', 'modern', 'classic') then
    raise exception 'INVALID_THEME' using errcode = 'P0001';
  end if;
  update properties set theme = v_theme where id = p_property;
end $$;
revoke all on function set_hotel_theme(uuid, text) from public, anon;
grant execute on function set_hotel_theme(uuid, text) to authenticated;

create or replace function guest_hotel(p_host text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_property uuid; r record;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  select name, address, city, state, check_in_time, check_out_time, phone, contact_email, intro, logo_path, theme into r from properties where id = v_property;
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
    'theme', r.theme);
end $$;
