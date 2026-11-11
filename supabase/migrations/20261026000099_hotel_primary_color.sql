-- 099 An optional main colour for the hotel's look, laid over the chosen theme (or over the standard look).
--
-- properties.theme_primary is '#rrggbb' in lower case, or null (use the theme's own colour). It is a presentation setting only.
-- set_hotel_primary_color(property, colour): property.configure at that hotel (anyone else NOT_FOUND); blank or null clears it;
-- anything that is not #rrggbb is refused (INVALID_COLOR). Whether white text can be read on the colour is checked by the app
-- (which can show the person the numbers); the database checks the shape only, so a hand-made call can set a poor colour on its
-- own hotel and no other. The audit trigger lists the column; guest_hotel returns it as `theme_primary`.

alter table properties
  add column theme_primary text,
  add constraint properties_theme_primary_check check (theme_primary is null or theme_primary ~ '^#[0-9a-f]{6}$');

drop trigger properties_audit on properties;
create trigger properties_audit after insert or update or delete on properties
  for each row execute function audit_config_row('property', 'name,code,address,city,state,country_code,timezone,currency,check_in_time,check_out_time,status,phone,contact_email,intro,logo_path,theme,theme_primary');

create function set_hotel_primary_color(p_property uuid, p_color text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_color text := nullif(lower(btrim(coalesce(p_color, ''))), '');
begin
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if v_color is not null and v_color !~ '^#[0-9a-f]{6}$' then
    raise exception 'INVALID_COLOR' using errcode = 'P0001';
  end if;
  update properties set theme_primary = v_color where id = p_property;
end $$;
revoke all on function set_hotel_primary_color(uuid, text) from public, anon;
grant execute on function set_hotel_primary_color(uuid, text) to authenticated;

create or replace function guest_hotel(p_host text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_property uuid; r record;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  select name, address, city, state, check_in_time, check_out_time, phone, contact_email, intro, logo_path, theme, theme_primary into r from properties where id = v_property;
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
    'theme_primary', r.theme_primary);
end $$;
