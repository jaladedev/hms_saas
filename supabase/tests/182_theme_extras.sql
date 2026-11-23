-- Theme extras (migration 182): favicon, hero image, and a draft that goes live only when published. Reuses t_as / t_sys / t_expect (05).
-- Hotel A: tenant a1, property a2. Users: aa01 owner A (property.configure), aa02 housekeeping A (no configure), bb01 owner of Hotel B,
-- f050 the platform user who switches plan flags. The file store is outside the database: what is proven here is the tables, who may
-- do what, that nothing reads a draft but a publish, the path rules, the cleanup queue, and the guest site's view.
\set ON_ERROR_STOP on

do $$
declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t constant uuid := '00000000-0000-0000-0000-0000000000a1';
  owner text := '00000000-0000-0000-0000-00000000aa01'; hk text := '00000000-0000-0000-0000-00000000aa02';
  ob text := '00000000-0000-0000-0000-00000000bb01'; plat text := '00000000-0000-0000-0000-00000000f050';
  r jsonb; f1 text; f2 text; f3 text; f4 text; h1 text; n integer; other_prop uuid; other_tenant uuid; bad text;
begin
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = v_t and feature_key = 'branding';
  select id, tenant_id into other_prop, other_tenant from properties where tenant_id <> v_t order by id limit 1;
  if other_prop is null then raise exception 'FAIL setup: no second group'; end if;
  delete from property_theme_drafts where property_id = v_p;
  update properties set theme = 'classic', theme_primary = null, theme_font_display = null, theme_font_body = null, theme_radius = null,
         favicon_path = null, hero_path = null where id = v_p;
  delete from room_photo_cleanup;
  f1 := v_t || '/' || v_p || '/favicon/' || gen_random_uuid() || '.png';
  f2 := v_t || '/' || v_p || '/favicon/' || gen_random_uuid() || '.webp';
  f3 := v_t || '/' || v_p || '/favicon/' || gen_random_uuid() || '.jpg';
  f4 := v_t || '/' || v_p || '/favicon/' || gen_random_uuid() || '.png';
  h1 := v_t || '/' || v_p || '/hero/' || gen_random_uuid() || '.jpg';

  -- 1. a draft is saved as the owner; the live look and the guest site do not move
  perform t_as(owner);
  perform theme_draft_save(v_p, ' LUXURY ', '#0F766E', 'playfair', 'inter', 'round');
  perform theme_draft_set_image(v_p, 'favicon', f1);
  perform theme_draft_set_image(v_p, 'hero', h1);
  perform t_sys();
  if (select theme from property_theme_drafts where property_id = v_p) <> 'luxury' then raise exception 'FAIL draft theme not normalised'; end if;
  if (select theme_primary from property_theme_drafts where property_id = v_p) <> '#0f766e' then raise exception 'FAIL draft colour not normalised'; end if;
  if (select theme from properties where id = v_p) <> 'classic' then raise exception 'FAIL a draft changed the live theme'; end if;
  r := guest_hotel('book.hotel-a.test');
  if r ->> 'theme' <> 'classic' or r -> 'favicon' <> 'null'::jsonb or r -> 'hero' <> 'null'::jsonb or r -> 'radius' <> 'null'::jsonb then raise exception 'FAIL the guest site read a draft: %', r; end if;
  if (select count(*) from audit_logs where entity_id = v_p and action = 'theme_draft.saved') <> 1 then raise exception 'FAIL draft save not audited'; end if;
  if (select count(*) from audit_logs where entity_id = v_p and action = 'theme_draft.image') <> 2 then raise exception 'FAIL draft images not audited'; end if;
  if (select count(*) from property_theme_drafts) <> 1 then raise exception 'FAIL expected one draft'; end if;

  -- 2. only the listed values; images only under the hotel's own folder, of the right kind and type
  perform t_as(owner);
  perform t_expect($q$select theme_draft_save('00000000-0000-0000-0000-0000000000a2', 'neon', '', '', '', '')$q$, 'INVALID_THEME');
  perform t_expect($q$select theme_draft_save('00000000-0000-0000-0000-0000000000a2', '', 'red', '', '', '')$q$, 'INVALID_COLOR');
  perform t_expect($q$select theme_draft_save('00000000-0000-0000-0000-0000000000a2', '', '', 'comic', '', '')$q$, 'INVALID_FONT');
  perform t_expect($q$select theme_draft_save('00000000-0000-0000-0000-0000000000a2', '', '', '', 'comic', '')$q$, 'INVALID_FONT');
  perform t_expect($q$select theme_draft_save('00000000-0000-0000-0000-0000000000a2', '', '', '', '', 'pill')$q$, 'INVALID_RADIUS');
  perform t_expect($q$select theme_draft_set_image('00000000-0000-0000-0000-0000000000a2', 'banner', 'x')$q$, 'POLICY_VIOLATION: image kind');
  foreach bad in array array[
    other_tenant || '/' || v_p || '/favicon/' || gen_random_uuid() || '.png',
    v_t || '/' || other_prop || '/favicon/' || gen_random_uuid() || '.png',
    v_t || '/' || v_p || '/hero/' || gen_random_uuid() || '.png',           -- a hero path offered as a favicon
    v_t || '/' || v_p || '/favicon/' || gen_random_uuid() || '.gif',
    v_t || '/' || v_p || '/favicon/not-a-uuid.png',
    '../' || v_t || '/' || v_p || '/favicon/' || gen_random_uuid() || '.png'] loop
    begin
      perform theme_draft_set_image(v_p, 'favicon', bad);
      raise exception 'FAIL a bad favicon path was accepted: %', bad;
    exception when check_violation then null; end;
  end loop;
  begin
    perform theme_draft_set_image(v_p, 'hero', v_t || '/' || v_p || '/hero/' || gen_random_uuid() || '.svg');
    raise exception 'FAIL an svg hero was accepted';
  exception when check_violation then null; end;
  perform t_sys();
  if (select favicon_path from property_theme_drafts where property_id = v_p) <> f1 then raise exception 'FAIL a refused image changed the draft'; end if;

  -- 3. publish: the draft moves into the hotel, is dropped, and its files are KEPT (not queued)
  perform t_as(owner);
  perform theme_publish(v_p);
  perform t_sys();
  if (select count(*) from property_theme_drafts where property_id = v_p) <> 0 then raise exception 'FAIL the draft stayed after publishing'; end if;
  if not exists (select 1 from properties where id = v_p and theme = 'luxury' and theme_primary = '#0f766e' and theme_font_display = 'playfair'
                    and theme_font_body = 'inter' and theme_radius = 'round' and favicon_path = f1 and hero_path = h1) then raise exception 'FAIL publish did not copy the look'; end if;
  r := guest_hotel('book.hotel-a.test');
  if r ->> 'theme' <> 'luxury' or r ->> 'favicon' <> f1 or r ->> 'hero' <> h1 or r ->> 'radius' <> 'round' then raise exception 'FAIL the guest site does not show the published look: %', r; end if;
  if exists (select 1 from room_photo_cleanup where path in (f1, h1)) then raise exception 'FAIL a published file was queued for removal'; end if;
  if not exists (select 1 from audit_logs where entity_id = v_p and action = 'theme_draft.published') then raise exception 'FAIL publish not audited'; end if;
  if not exists (select 1 from audit_logs where entity_id = v_p and action = 'property.updated' and metadata -> 'changed' ? 'favicon_path') then raise exception 'FAIL the favicon change is not in the property audit'; end if;
  perform t_as(owner);
  perform t_expect($q$select theme_publish('00000000-0000-0000-0000-0000000000a2')$q$, 'INVALID_STATE: no draft');

  -- 4. a new draft starts from the live look (images carried over); replacing the favicon in it does NOT queue the live file, publishing does
  perform t_as(owner);
  perform theme_draft_save(v_p, 'luxury', '#0f766e', 'playfair', 'inter', 'round');
  perform t_sys();
  if (select favicon_path from property_theme_drafts where property_id = v_p) is distinct from f1 then raise exception 'FAIL the new draft did not start from the live favicon'; end if;
  perform t_as(owner);
  perform theme_draft_set_image(v_p, 'favicon', f2);
  perform t_sys();
  if exists (select 1 from room_photo_cleanup where path = f1) then raise exception 'FAIL the live favicon was queued while the draft still only replaced it'; end if;
  if (select favicon_path from properties where id = v_p) <> f1 then raise exception 'FAIL the live favicon moved before publishing'; end if;
  perform t_as(owner);
  perform theme_publish(v_p);
  perform t_sys();
  if not exists (select 1 from room_photo_cleanup where path = f1) then raise exception 'FAIL the replaced live favicon was not queued'; end if;
  if exists (select 1 from room_photo_cleanup where path in (f2, h1)) then raise exception 'FAIL a file still in use was queued'; end if;

  -- 5. a file only a draft used goes to the queue when the draft replaces it or is discarded; the live files stay
  perform t_as(owner);
  perform theme_draft_set_image(v_p, 'favicon', f3);
  perform theme_draft_set_image(v_p, 'favicon', f4);
  perform t_sys();
  if not exists (select 1 from room_photo_cleanup where path = f3) then raise exception 'FAIL a replaced draft-only file was not queued'; end if;
  perform t_as(owner);
  if theme_draft_discard(v_p) is not true then raise exception 'FAIL discard did not report a draft'; end if;
  if theme_draft_discard(v_p) is not false then raise exception 'FAIL a second discard should report none'; end if;
  perform t_sys();
  if not exists (select 1 from room_photo_cleanup where path = f4) then raise exception 'FAIL a discarded draft-only file was not queued'; end if;
  if exists (select 1 from room_photo_cleanup where path in (f2, h1)) then raise exception 'FAIL discarding queued a live file'; end if;
  if (select favicon_path from properties where id = v_p) <> f2 then raise exception 'FAIL discarding changed the live look'; end if;
  if (select count(*) from audit_logs where entity_id = v_p and action = 'theme_draft.discarded') <> 1 then raise exception 'FAIL discard not audited exactly once'; end if;

  -- 6. a draft that clears an image: publishing removes it from the hotel and queues the old file
  perform t_as(owner);
  perform theme_draft_set_image(v_p, 'hero', '');
  perform theme_publish(v_p);
  perform t_sys();
  if (select hero_path from properties where id = v_p) is not null then raise exception 'FAIL the hero was not cleared'; end if;
  if not exists (select 1 from room_photo_cleanup where path = h1) then raise exception 'FAIL the cleared hero was not queued'; end if;

  -- 7. who: housekeeping and another group get NOT_FOUND from every function, and see no draft; nobody writes the table directly
  perform t_as(owner);
  perform theme_draft_save(v_p, 'modern', '', '', '', '');
  foreach bad in array array[hk, ob] loop
    perform t_as(bad);
    perform t_expect($q$select theme_draft_save('00000000-0000-0000-0000-0000000000a2', 'modern', '', '', '', '')$q$, 'NOT_FOUND');
    perform t_expect($q$select theme_draft_set_image('00000000-0000-0000-0000-0000000000a2', 'hero', '')$q$, 'NOT_FOUND');
    perform t_expect($q$select theme_draft_discard('00000000-0000-0000-0000-0000000000a2')$q$, 'NOT_FOUND');
    perform t_expect($q$select theme_publish('00000000-0000-0000-0000-0000000000a2')$q$, 'NOT_FOUND');
    select count(*) into n from property_theme_drafts;
    if n <> 0 then raise exception 'FAIL a person without configure rights read % drafts', n; end if;
  end loop;
  perform t_as(owner);
  select count(*) into n from property_theme_drafts;
  if n <> 1 then raise exception 'FAIL the owner sees % drafts, expected 1', n; end if;
  begin delete from property_theme_drafts where property_id = v_p; raise exception 'FAIL the owner deleted a draft directly'; exception when insufficient_privilege then null; end;
  begin update property_theme_drafts set theme = 'luxury' where property_id = v_p; raise exception 'FAIL the owner edited a draft directly'; exception when insufficient_privilege then null; end;
  begin insert into property_theme_drafts (property_id, tenant_id) values (other_prop, other_tenant); raise exception 'FAIL the owner inserted a draft directly'; exception when insufficient_privilege then null; end;
  perform t_sys();
  if has_table_privilege('anon', 'property_theme_drafts', 'select') then raise exception 'FAIL anon can read drafts'; end if;
  if (select count(*) from pg_policies where tablename = 'property_theme_drafts') <> 1 then raise exception 'FAIL expected exactly one policy on drafts'; end if;

  -- 8. the branding plan flag: off, every function refuses (NOT_FOUND) and the saved draft stays; on again, they work
  perform t_as(plat);
  perform platform_set_entitlement(v_t, 'branding', false);
  perform t_as(owner);
  perform t_expect($q$select theme_draft_save('00000000-0000-0000-0000-0000000000a2', 'luxury', '', '', '', '')$q$, 'NOT_FOUND');
  perform t_expect($q$select theme_draft_set_image('00000000-0000-0000-0000-0000000000a2', 'hero', '')$q$, 'NOT_FOUND');
  perform t_expect($q$select theme_draft_discard('00000000-0000-0000-0000-0000000000a2')$q$, 'NOT_FOUND');
  perform t_expect($q$select theme_publish('00000000-0000-0000-0000-0000000000a2')$q$, 'NOT_FOUND');
  perform t_sys();
  if (select theme from property_theme_drafts where property_id = v_p) <> 'modern' then raise exception 'FAIL the flag changed a saved draft'; end if;
  perform t_as(plat);
  perform platform_set_entitlement(v_t, 'branding', true);
  perform t_as(owner);
  perform theme_publish(v_p);
  perform t_sys();
  if (select theme from properties where id = v_p) <> 'modern' then raise exception 'FAIL publish did not work after the flag came back'; end if;

  -- 9. the path checks also guard the live table, and the new columns are in the guest site answer
  begin
    update properties set favicon_path = v_t || '/' || other_prop || '/favicon/' || gen_random_uuid() || '.png' where id = v_p;
    raise exception 'FAIL the live table took another hotel''s favicon path';
  exception when check_violation then null; end;
  if not (guest_hotel('book.hotel-a.test') ? 'favicon' and guest_hotel('book.hotel-a.test') ? 'hero') then raise exception 'FAIL guest_hotel lacks favicon or hero'; end if;

  delete from room_photo_cleanup;
  update properties set theme = null, favicon_path = null, hero_path = null, theme_primary = null, theme_font_display = null, theme_font_body = null, theme_radius = null where id = v_p;
  raise notice 'PASS theme extras: a draft changes nothing live until published, images and values refused when wrong, publish keeps the files in use and queues replaced ones, discard queues draft-only files, configure rights and the branding flag enforced, direct writes blocked, guest site shows the published favicon and hero';
end $$;
