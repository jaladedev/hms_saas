-- 182 Theme editor extras (prototype "Branding & Theme Editor"): a favicon, a hero image, and a draft versus published look.
--
-- Until now every look setting applied the moment it was saved (093, 099, 100, 118). This adds:
--   * favicon_path and hero_path on properties: paths in the public room-photos bucket (088, 090), like the logo.
--       favicon: <tenant>/<property>/favicon/<uuid>.<png|jpg|webp>        hero: <tenant>/<property>/hero/<uuid>.<jpg|png|webp>
--     A table check ties each path to the hotel's own tenant and id, so it cannot point at another hotel's folder. Null = none.
--     The guest site shows the favicon in the browser tab and the hero image as a banner above the home page; guest_hotel returns
--     them as `favicon` and `hero`.
--   * property_theme_drafts: at most one draft per hotel, holding the same look fields (theme, main colour, fonts, corners) and the
--     two images. The draft is read by people who may configure the hotel and changed only through the functions below. NOTHING on the
--     guest site or the staff screens reads a draft: only a publish moves a draft into `properties`.
--       theme_draft_save(property, theme, primary, font_display, font_body, radius)   the look fields (the same rules as the setters:
--           INVALID_THEME, INVALID_COLOR, INVALID_FONT, INVALID_RADIUS); a hotel with no draft yet starts from its live look, so the
--           images are carried over
--       theme_draft_set_image(property, kind, path)    kind 'favicon' or 'hero'; a blank path clears that image in the draft
--       theme_draft_discard(property)                  drops the draft; the live look is untouched
--       theme_publish(property)                        copies the draft into the hotel, drops the draft; INVALID_STATE: no draft
--     Every one of them needs property.configure at that hotel (anyone else NOT_FOUND) and the 'branding' plan flag (NOT_FOUND, like
--     the other look setters), and writes an audit row. A publish also shows in the property's own audit (the columns below).
--   * files: replacing or removing a LIVE image puts the old path in room_photo_cleanup (088) as the logo does; replacing or dropping a
--     DRAFT image does the same unless the live look still uses that path (a draft starts as a copy of the live look, so it can share a
--     file with it). A published image is never queued: the live row holds the path before the draft row goes.
--   * the colour's contrast against white text is judged by the app (which can show the numbers); the database checks the shape only,
--     as for the setters in 099.

alter table properties
  add column favicon_path text,
  add column hero_path text,
  add constraint properties_favicon_path_check check (favicon_path is null or favicon_path ~ ('^' || tenant_id || '/' || id || '/favicon/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](png|jpg|webp)$')),
  add constraint properties_hero_path_check check (hero_path is null or hero_path ~ ('^' || tenant_id || '/' || id || '/hero/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|webp)$'));

drop trigger properties_audit on properties;
create trigger properties_audit after insert or update or delete on properties
  for each row execute function audit_config_row('property', 'name,code,address,city,state,country_code,timezone,currency,check_in_time,check_out_time,status,phone,contact_email,intro,logo_path,theme,theme_primary,theme_font_display,theme_font_body,theme_radius,facilities,social_instagram,social_facebook,arrival_reminder_days,review_request_enabled,digest_email,waitlist_email_enabled,sms_enabled,sms_kinds,sms_channel,sms_monthly_cap,sms_reminder_days,favicon_path,hero_path');

create function properties_queue_old_look_files() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.favicon_path is not null and new.favicon_path is distinct from old.favicon_path then
    insert into room_photo_cleanup (path) values (old.favicon_path) on conflict do nothing;
  end if;
  if old.hero_path is not null and new.hero_path is distinct from old.hero_path then
    insert into room_photo_cleanup (path) values (old.hero_path) on conflict do nothing;
  end if;
  return null;
end $$;
revoke all on function properties_queue_old_look_files() from public, anon, authenticated;
create trigger properties_queue_old_look_files after update of favicon_path, hero_path on properties
  for each row execute function properties_queue_old_look_files();

-- ---- the draft ---------------------------------------------------------------------------
create table property_theme_drafts (
  property_id        uuid primary key,
  tenant_id          uuid not null,
  theme              text check (theme is null or theme in ('luxury', 'modern', 'classic')),
  theme_primary      text check (theme_primary is null or theme_primary ~ '^#[0-9a-f]{6}$'),
  theme_font_display text check (theme_font_display is null or theme_font_display in ('playfair', 'sora', 'lora', 'outfit')),
  theme_font_body    text check (theme_font_body is null or theme_font_body in ('inter', 'source-serif')),
  theme_radius       text check (theme_radius is null or theme_radius in ('sharp', 'round')),
  favicon_path       text,
  hero_path          text,
  saved_by           uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  constraint property_theme_drafts_favicon_check check (favicon_path is null or favicon_path ~ ('^' || tenant_id || '/' || property_id || '/favicon/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](png|jpg|webp)$')),
  constraint property_theme_drafts_hero_check check (hero_path is null or hero_path ~ ('^' || tenant_id || '/' || property_id || '/hero/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|webp)$'))
);

alter table property_theme_drafts enable row level security;
create policy property_theme_drafts_select on property_theme_drafts for select to authenticated
  using (has_permission(property_id, 'property.configure'));
revoke all on property_theme_drafts from anon;
revoke insert, update, delete on property_theme_drafts from authenticated;

-- A draft image that stops being used by the draft goes to the cleanup queue, unless the live look still uses the same path.
create function property_theme_drafts_queue_cleanup() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare p text;
begin
  foreach p in array array[old.favicon_path, old.hero_path] loop
    if p is not null
       and (tg_op = 'DELETE' or (p is distinct from new.favicon_path and p is distinct from new.hero_path))
       and not exists (select 1 from properties x where x.id = old.property_id and (x.favicon_path = p or x.hero_path = p)) then
      insert into room_photo_cleanup (path) values (p) on conflict do nothing;
    end if;
  end loop;
  return null;
end $$;
revoke all on function property_theme_drafts_queue_cleanup() from public, anon, authenticated;
create trigger property_theme_drafts_queue_cleanup after update of favicon_path, hero_path or delete on property_theme_drafts
  for each row execute function property_theme_drafts_queue_cleanup();

-- Internal: the permission, the plan flag and the property row, in one place. Returns the actor (null for the system).
create function theme_draft_require(p_property uuid) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid; v_tenant uuid;
begin
  v_actor := require_permission(p_property, 'property.configure', 'NOT_FOUND');
  select tenant_id into v_tenant from properties where id = p_property;
  if v_tenant is null or not tenant_feature_on(v_tenant, 'branding') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  return v_actor;
end $$;
revoke all on function theme_draft_require(uuid) from public, anon, authenticated;

-- Internal: the draft row, created from the live look when the hotel has none yet.
create function theme_draft_ensure(p_property uuid) returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into property_theme_drafts (property_id, tenant_id, theme, theme_primary, theme_font_display, theme_font_body, theme_radius, favicon_path, hero_path)
  select id, tenant_id, theme, theme_primary, theme_font_display, theme_font_body, theme_radius, favicon_path, hero_path from properties where id = p_property
  on conflict (property_id) do nothing;
end $$;
revoke all on function theme_draft_ensure(uuid) from public, anon, authenticated;

create function theme_draft_save(p_property uuid, p_theme text, p_primary text, p_font_display text, p_font_body text, p_radius text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actor uuid; v_tenant uuid;
  v_theme text := nullif(lower(btrim(coalesce(p_theme, ''))), '');
  v_color text := nullif(lower(btrim(coalesce(p_primary, ''))), '');
  v_display text := nullif(lower(btrim(coalesce(p_font_display, ''))), '');
  v_body text := nullif(lower(btrim(coalesce(p_font_body, ''))), '');
  v_radius text := nullif(lower(btrim(coalesce(p_radius, ''))), '');
begin
  v_actor := theme_draft_require(p_property);
  if v_theme is not null and v_theme not in ('luxury', 'modern', 'classic') then raise exception 'INVALID_THEME' using errcode = 'P0001'; end if;
  if v_color is not null and v_color !~ '^#[0-9a-f]{6}$' then raise exception 'INVALID_COLOR' using errcode = 'P0001'; end if;
  if v_display is not null and v_display not in ('playfair', 'sora', 'lora', 'outfit') then raise exception 'INVALID_FONT' using errcode = 'P0001'; end if;
  if v_body is not null and v_body not in ('inter', 'source-serif') then raise exception 'INVALID_FONT' using errcode = 'P0001'; end if;
  if v_radius is not null and v_radius not in ('sharp', 'round') then raise exception 'INVALID_RADIUS' using errcode = 'P0001'; end if;
  perform theme_draft_ensure(p_property);
  update property_theme_drafts
     set theme = v_theme, theme_primary = v_color, theme_font_display = v_display, theme_font_body = v_body, theme_radius = v_radius,
         saved_by = v_actor, updated_at = now()
   where property_id = p_property
  returning tenant_id into v_tenant;
  perform write_audit(v_tenant, p_property, v_actor, 'theme_draft.saved', 'property', p_property, null,
                      jsonb_build_object('theme', v_theme, 'primary', v_color, 'font_display', v_display, 'font_body', v_body, 'radius', v_radius));
end $$;
revoke all on function theme_draft_save(uuid, text, text, text, text, text) from public, anon;
grant execute on function theme_draft_save(uuid, text, text, text, text, text) to authenticated;

create function theme_draft_set_image(p_property uuid, p_kind text, p_path text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid; v_tenant uuid; v_path text := nullif(btrim(coalesce(p_path, '')), '');
begin
  v_actor := theme_draft_require(p_property);
  if p_kind is null or p_kind not in ('favicon', 'hero') then raise exception 'POLICY_VIOLATION: image kind' using errcode = 'P0001'; end if;
  perform theme_draft_ensure(p_property);
  if p_kind = 'favicon' then
    update property_theme_drafts set favicon_path = v_path, saved_by = v_actor, updated_at = now() where property_id = p_property returning tenant_id into v_tenant;
  else
    update property_theme_drafts set hero_path = v_path, saved_by = v_actor, updated_at = now() where property_id = p_property returning tenant_id into v_tenant;
  end if;
  perform write_audit(v_tenant, p_property, v_actor, 'theme_draft.image', 'property', p_property, null,
                      jsonb_build_object('kind', p_kind, 'has_image', v_path is not null));
end $$;
revoke all on function theme_draft_set_image(uuid, text, text) from public, anon;
grant execute on function theme_draft_set_image(uuid, text, text) to authenticated;

create function theme_draft_discard(p_property uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid; v_tenant uuid;
begin
  v_actor := theme_draft_require(p_property);
  delete from property_theme_drafts where property_id = p_property returning tenant_id into v_tenant;
  if v_tenant is null then return false; end if;
  perform write_audit(v_tenant, p_property, v_actor, 'theme_draft.discarded', 'property', p_property, null, '{}'::jsonb);
  return true;
end $$;
revoke all on function theme_draft_discard(uuid) from public, anon;
grant execute on function theme_draft_discard(uuid) to authenticated;

create function theme_publish(p_property uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_actor uuid; d property_theme_drafts%rowtype;
begin
  v_actor := theme_draft_require(p_property);
  select * into d from property_theme_drafts where property_id = p_property for update;
  if not found then raise exception 'INVALID_STATE: no draft' using errcode = 'P0001'; end if;
  update properties
     set theme = d.theme, theme_primary = d.theme_primary, theme_font_display = d.theme_font_display, theme_font_body = d.theme_font_body,
         theme_radius = d.theme_radius, favicon_path = d.favicon_path, hero_path = d.hero_path
   where id = p_property;
  delete from property_theme_drafts where property_id = p_property;   -- after the update, so the draft's files are the live ones and are kept
  perform write_audit(d.tenant_id, p_property, v_actor, 'theme_draft.published', 'property', p_property, null,
                      jsonb_build_object('theme', d.theme, 'primary', d.theme_primary, 'font_display', d.theme_font_display, 'font_body', d.theme_font_body,
                                         'radius', d.theme_radius, 'has_favicon', d.favicon_path is not null, 'has_hero', d.hero_path is not null));
end $$;
revoke all on function theme_publish(uuid) from public, anon;
grant execute on function theme_publish(uuid) to authenticated;

-- ---- the guest site -----------------------------------------------------------------------
create or replace function guest_hotel(p_host text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_property uuid; r record;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  select name, address, city, state, check_in_time, check_out_time, phone, contact_email, intro, logo_path, theme, theme_primary, theme_font_display, theme_font_body, theme_radius, facilities, social_instagram, social_facebook, favicon_path, hero_path into r from properties where id = v_property;
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
    'facebook', r.social_facebook,
    'favicon', r.favicon_path,
    'hero', r.hero_path);
end $$;
