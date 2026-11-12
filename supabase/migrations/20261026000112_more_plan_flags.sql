-- 112 Four more enforced feature flags: housekeeping, maintenance, audit_log, branding.
--
-- The platform prototype lists these as plan features. Same rule as reports.export (052) and discounts (063): a hotel group with a
-- flag row set to enabled = false loses the feature, no row (or enabled = true) means on, so no existing hotel changes.
--   housekeeping   has_permission answers false for housekeeping.view / .update / .assign: the housekeeping screens and actions refuse
--                  (NOT_FOUND, like any person without the permission). Tasks already made stay in the database; room status changes
--                  that the system makes itself (check-out, room changes) are security definer triggers and keep working.
--   maintenance    the same for maintenance.view / maintenance.manage.
--   audit_log      the same for audit.view: the hotel's own audit screens show nothing. The log is still WRITTEN, and the platform's
--                  own reading of it is unaffected, so switching this off hides history, never loses it.
--   branding       set_hotel_theme, set_hotel_primary_color and set_hotel_fonts refuse (NOT_FOUND). The look a hotel already chose stays.
-- Not made flags: "multi-property" (no screen lets a hotel add a property: the platform creates them) and "API access" (the system has
-- no public API). A flag that switches nothing would only mislead, so they wait for the features.
--
-- The permission-to-flag map lives in one place (permission_feature) so the next gated permission is one line.

create function permission_feature(p_permission text) returns text
language sql immutable as $$
  select case
    when p_permission = 'report.export' then 'reports.export'
    when p_permission = 'discount.apply' then 'discounts'
    when p_permission in ('housekeeping.view', 'housekeeping.update', 'housekeeping.assign') then 'housekeeping'
    when p_permission in ('maintenance.view', 'maintenance.manage') then 'maintenance'
    when p_permission = 'audit.view' then 'audit_log'
  end
$$;
revoke all on function permission_feature(text) from public, anon, authenticated;

create or replace function has_permission(p_property uuid, p_permission text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from tenant_memberships m
      join membership_roles mr on mr.membership_id = m.id
      join role_permissions rp on rp.role_id = mr.role_id
      join permissions p on p.id = rp.permission_id
      join properties pr on pr.id = p_property and pr.tenant_id = m.tenant_id
     where m.user_id = (select auth.uid())
       and m.status = 'active'
       and p.key = p_permission
       and (mr.property_id is null or mr.property_id = p_property)
       and (permission_feature(p_permission) is null or tenant_feature_on(m.tenant_id, permission_feature(p_permission)))
  )
$$;

-- branding: the three setters
create or replace function set_hotel_theme(p_property uuid, p_theme text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_theme text := nullif(btrim(coalesce(p_theme, '')), '');
begin
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if not tenant_feature_on((select tenant_id from properties where id = p_property), 'branding') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if v_theme is not null and v_theme not in ('luxury', 'modern', 'classic') then
    raise exception 'INVALID_THEME' using errcode = 'P0001';
  end if;
  update properties set theme = v_theme where id = p_property;
end $$;

create or replace function set_hotel_primary_color(p_property uuid, p_color text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_color text := nullif(lower(btrim(coalesce(p_color, ''))), '');
begin
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if not tenant_feature_on((select tenant_id from properties where id = p_property), 'branding') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if v_color is not null and v_color !~ '^#[0-9a-f]{6}$' then
    raise exception 'INVALID_COLOR' using errcode = 'P0001';
  end if;
  update properties set theme_primary = v_color where id = p_property;
end $$;

create or replace function set_hotel_fonts(p_property uuid, p_display text, p_body text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_display text := nullif(lower(btrim(coalesce(p_display, ''))), '');
  v_body text := nullif(lower(btrim(coalesce(p_body, ''))), '');
begin
  perform require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if not tenant_feature_on((select tenant_id from properties where id = p_property), 'branding') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if v_display is not null and v_display not in ('playfair', 'sora', 'lora', 'outfit') then raise exception 'INVALID_FONT' using errcode = 'P0001'; end if;
  if v_body is not null and v_body not in ('inter', 'source-serif') then raise exception 'INVALID_FONT' using errcode = 'P0001'; end if;
  update properties set theme_font_display = v_display, theme_font_body = v_body where id = p_property;
end $$;

-- The platform's enforced list, and the starting plans: the four new flags go in every plan so that applying a plan to a hotel
-- changes nothing for it. The prices and what each plan includes are placeholders to be edited on /platform/plans.
create or replace function plan_enforced_flags() returns text[]
language sql immutable as $$
  select array['reports.export', 'online_payments', 'discounts', 'online_booking', 'guest_cancel', 'guest_changes', 'early_checkin',
               'housekeeping', 'maintenance', 'audit_log', 'branding']
$$;

update plans set features = (select array_agg(distinct k order by k) from unnest(features || array['housekeeping', 'maintenance', 'audit_log', 'branding']) k)
 where code in ('starter', 'standard', 'pro');
