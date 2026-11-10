-- 090 A logo for the hotel, shown in the guest site header.
--
-- The file lives in the same public bucket as the room pictures (`room-photos`), at <tenant>/<property>/logo/<uuid>.<jpg|png|webp>.
-- properties.logo_path holds that path (null = no logo); a table check ties it to the hotel's own tenant and id, so a path
-- cannot point at another hotel's folder or anywhere else in the bucket.
--
-- set_hotel_logo(property, path): property.configure at that hotel (anyone else NOT_FOUND). A null path removes the logo.
-- The app stores the file first (service key), then calls this as the signed-in person; if this refuses, the app removes the file.
-- Replacing or removing a logo puts the old path in the cleanup queue from 088, so the maintenance job deletes the old file.
-- The audit trigger lists logo_path; guest_hotel returns it as `logo`.

alter table properties
  add column logo_path text,
  add constraint properties_logo_path_check check (logo_path is null or logo_path ~ ('^' || tenant_id || '/' || id || '/logo/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|webp)$'));

drop trigger properties_audit on properties;
create trigger properties_audit after insert or update or delete on properties
  for each row execute function audit_config_row('property', 'name,code,address,city,state,country_code,timezone,currency,check_in_time,check_out_time,status,phone,contact_email,intro,logo_path');

create function properties_queue_old_logo() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.logo_path is not null and new.logo_path is distinct from old.logo_path then
    insert into room_photo_cleanup (path) values (old.logo_path) on conflict do nothing;
  end if;
  return null;
end $$;
revoke all on function properties_queue_old_logo() from public, anon, authenticated;   -- STAGING step 4c: only three functions are callable by anon
create trigger properties_queue_old_logo after update of logo_path on properties
  for each row execute function properties_queue_old_logo();

create function set_hotel_logo(p_property uuid, p_path text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  update properties set logo_path = nullif(btrim(coalesce(p_path, '')), '') where id = p_property;
end $$;
revoke all on function set_hotel_logo(uuid, text) from public, anon;
grant execute on function set_hotel_logo(uuid, text) to authenticated;

create or replace function guest_hotel(p_host text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_property uuid; r record;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  select name, address, city, state, check_in_time, check_out_time, phone, contact_email, intro, logo_path into r from properties where id = v_property;
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
    'logo', r.logo_path);
end $$;
