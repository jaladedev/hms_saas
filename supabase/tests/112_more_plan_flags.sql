-- The housekeeping, maintenance, audit_log and branding plan flags (migration 112). Reuses t_as / t_sys / t_expect (05).
-- Hotel group A (a1) is switched off and on; everything is put back on at the end.
\set ON_ERROR_STOP on

do $$ declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2'; v_t uuid := '00000000-0000-0000-0000-0000000000a1';
  owner text := '00000000-0000-0000-0000-00000000aa01'; hk text := '00000000-0000-0000-0000-00000000aa02';
  k text; perm text; v_theme text;
begin
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = v_t and feature_key in ('housekeeping', 'maintenance', 'audit_log', 'branding');

  -- no row: everything works as before
  perform t_as(owner);
  foreach perm in array array['housekeeping.view', 'housekeeping.update', 'maintenance.manage', 'audit.view', 'property.configure'] loop
    if not has_permission(prop, perm) then raise exception 'FAIL default: owner lacks %', perm; end if;
  end loop;
  perform set_hotel_theme(prop, 'modern');

  -- each flag off removes exactly its permissions
  foreach k in array array['housekeeping', 'maintenance', 'audit_log', 'branding'] loop
    perform t_as('00000000-0000-0000-0000-00000000f050');
    perform platform_set_entitlement(v_t, k, false);
    perform t_as(owner);
    if (k = 'housekeeping') <> not (has_permission(prop, 'housekeeping.view') or has_permission(prop, 'housekeeping.update')) then raise exception 'FAIL % housekeeping perms', k; end if;
    if (k = 'maintenance') <> not has_permission(prop, 'maintenance.manage') then raise exception 'FAIL % maintenance perm', k; end if;
    if (k = 'audit_log') <> not has_permission(prop, 'audit.view') then raise exception 'FAIL % audit perm', k; end if;
    if not has_permission(prop, 'reservation.view') or not has_permission(prop, 'property.configure') then raise exception 'FAIL % switched off an unrelated permission', k; end if;
    perform t_as('00000000-0000-0000-0000-00000000f050');
    perform platform_set_entitlement(v_t, k, true);
  end loop;

  -- housekeeping off: the housekeeping user is locked out of the task actions as well
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'housekeeping', false);
  perform t_as(hk);
  if has_permission(prop, 'housekeeping.view') or has_permission(prop, 'housekeeping.update') then raise exception 'FAIL housekeeping user still has access'; end if;
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'housekeeping', true);
  perform t_as(hk);
  if not has_permission(prop, 'housekeeping.view') then raise exception 'FAIL housekeeping did not return'; end if;

  -- branding off: the three setters refuse and change nothing; on again they work
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'branding', false);
  perform t_as(owner);
  perform t_expect(format('select set_hotel_theme(%L, %L)', prop, 'luxury'), 'NOT_FOUND');
  perform t_expect(format('select set_hotel_primary_color(%L, %L)', prop, '#112233'), 'NOT_FOUND');
  perform t_expect(format('select set_hotel_fonts(%L, %L, %L)', prop, 'sora', 'inter'), 'NOT_FOUND');
  perform t_sys();
  select p.theme into v_theme from properties p where p.id = prop;
  if v_theme is distinct from 'modern' then raise exception 'FAIL a refused look change altered the theme: %', v_theme; end if;
  perform t_as('00000000-0000-0000-0000-00000000f050');
  perform platform_set_entitlement(v_t, 'branding', true);
  perform t_as(owner);
  perform set_hotel_theme(prop, 'luxury');
  perform set_hotel_primary_color(prop, '#112233');
  perform set_hotel_fonts(prop, 'sora', 'inter');
  perform t_sys();
  if (select theme from properties where id = prop) <> 'luxury' then raise exception 'FAIL branding did not return'; end if;
  update properties set theme = null, theme_primary = null, theme_font_display = null, theme_font_body = null where id = prop;

  -- the platform lists the four as enforced
  if not (plan_enforced_flags() @> array['housekeeping', 'maintenance', 'audit_log', 'branding']) then raise exception 'FAIL enforced list'; end if;
  raise notice 'PASS more plan flags: housekeeping, maintenance, audit_log and branding each remove only their own feature when off, and return when on';
end $$;
