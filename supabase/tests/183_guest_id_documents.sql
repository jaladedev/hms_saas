-- Guest ID type and number (migration 183). Reuses t_as / t_sys / t_expect (05).
-- Users: aa01 owner A (guest.id_view), aa04 front desk A (guest.manage, no id_view), aa02 housekeeping A (no guest rights), bb01 owner of Hotel B.
\set ON_ERROR_STOP on

do $$
declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t constant uuid := '00000000-0000-0000-0000-0000000000a1';
  owner text := '00000000-0000-0000-0000-00000000aa01'; fd text := '00000000-0000-0000-0000-00000000aa04';
  hk text := '00000000-0000-0000-0000-00000000aa02'; ob text := '00000000-0000-0000-0000-00000000bb01';
  g uuid; g2 uuid; g3 uuid; r jsonb; n integer; res jsonb;
begin
  perform t_as(owner);
  g := (create_guest(v_p, 't183 Ada Obi', 't183a@example.test', null, null, null) ->> 'guest_id')::uuid;
  g2 := (create_guest(v_p, 't183 Bola Eze', 't183b@example.test', null, null, null) ->> 'guest_id')::uuid;
  g3 := (create_guest(v_p, 't183 Chi Uzo', 't183c@example.test', null, null, null) ->> 'guest_id')::uuid;
  perform t_sys();

  -- 1. the table is closed: no privilege for anon or authenticated, row security on, and no existing guest read carries an id column
  if has_table_privilege('authenticated', 'guest_identity_documents', 'select') or has_table_privilege('anon', 'guest_identity_documents', 'select')
     or has_table_privilege('authenticated', 'guest_identity_documents', 'insert') then raise exception 'FAIL a login can reach the ID table directly'; end if;
  if not (select relrowsecurity from pg_class where relname = 'guest_identity_documents') then raise exception 'FAIL row security is off'; end if;
  if exists (select 1 from information_schema.columns where table_name = 'guests' and column_name ilike '%id_number%') then raise exception 'FAIL an ID column is on guests'; end if;
  if not exists (select 1 from role_permissions rp join roles ro on ro.id = rp.role_id join permissions p on p.id = rp.permission_id where p.key = 'guest.id_view' and ro.key = 'owner')
     or not exists (select 1 from role_permissions rp join roles ro on ro.id = rp.role_id join permissions p on p.id = rp.permission_id where p.key = 'guest.id_view' and ro.key = 'general_manager') then raise exception 'FAIL owner and general manager lack guest.id_view'; end if;
  -- none of the other built-in roles holds it (a hotel may give it to a custom role of its own, 084, and an earlier test's all-permissions fixture has it)
  if exists (select 1 from role_permissions rp join roles ro on ro.id = rp.role_id join permissions p on p.id = rp.permission_id
              where p.key = 'guest.id_view' and ro.key in ('front_desk', 'reservations_officer', 'accountant', 'housekeeping', 'maintenance')) then
    raise exception 'FAIL guest.id_view is held by a role other than owner and general manager';
  end if;

  -- 2. front desk sets an ID: normalised; the audit names the type and never the number
  perform t_as(fd);
  perform set_guest_id(g, ' Passport ', '  a01234  5678 ');
  perform t_sys();
  if (select id_type || '|' || id_number from guest_identity_documents where guest_id = g) <> 'passport|A01234 5678' then raise exception 'FAIL not normalised'; end if;
  if (select count(*) from audit_logs where action = 'guest_id.set' and entity_id = g and metadata ->> 'id_type' = 'passport') <> 1 then raise exception 'FAIL set not audited with the type'; end if;
  if exists (select 1 from audit_logs where action like 'guest_id.%' and (metadata::text ilike '%A01234%' or metadata::text ilike '%5678%' or to_jsonb(audit_logs)::text ilike '%A01234%')) then raise exception 'FAIL an ID number reached the audit trail'; end if;

  -- 3. masked for guest.view (front desk), full only with guest.id_view; every reveal is audited
  perform t_as(fd);
  r := guest_id_summary(g);
  if r ->> 'last3' <> '678' or r ->> 'id_type' <> 'passport' or r ? 'id_number' then raise exception 'FAIL summary is not masked: %', r; end if;
  perform t_expect(format('select guest_id_reveal(%L)', g), 'NOT_FOUND');
  perform t_as(owner);
  perform t_sys();
  select count(*) into n from audit_logs where action = 'guest_id.viewed';
  if n <> 0 then raise exception 'FAIL a refused reveal was audited as a view'; end if;
  perform t_as(owner);
  r := guest_id_reveal(g);
  if r ->> 'id_number' <> 'A01234 5678' or r ->> 'id_type' <> 'passport' then raise exception 'FAIL reveal wrong: %', r; end if;
  perform guest_id_reveal(g);
  perform t_sys();
  if (select count(*) from audit_logs where action = 'guest_id.viewed' and entity_id = g and actor_user_id = owner::uuid) <> 2 then raise exception 'FAIL each reveal must leave an audit row'; end if;
  if exists (select 1 from audit_logs where action = 'guest_id.viewed' and metadata::text ilike '%A01234%') then raise exception 'FAIL a reveal logged the number'; end if;
  perform t_as(owner);
  if guest_id_reveal(g2) is not null then raise exception 'FAIL reveal for a guest with no ID should be null'; end if;
  if guest_id_summary(g2) is not null then raise exception 'FAIL summary for a guest with no ID should be null'; end if;
  perform t_sys();
  if (select count(*) from audit_logs where action = 'guest_id.viewed' and entity_id = g2) <> 0 then raise exception 'FAIL a reveal with nothing to show was audited'; end if;

  -- 4. who: housekeeping and another group are refused everywhere (NOT_FOUND)
  foreach r in array array[to_jsonb(hk), to_jsonb(ob)] loop
    perform t_as(r #>> '{}');
    perform t_expect(format('select set_guest_id(%L, ''nin'', ''12345678901'')', g), 'NOT_FOUND');
    perform t_expect(format('select guest_id_summary(%L)', g), 'NOT_FOUND');
    perform t_expect(format('select guest_id_reveal(%L)', g), 'NOT_FOUND');
  end loop;
  perform t_sys();
  if (select id_number from guest_identity_documents where guest_id = g) <> 'A01234 5678' then raise exception 'FAIL a refused caller changed the ID'; end if;

  -- 5. validation: both or neither, listed types, 6 to 40 safe characters
  perform t_as(fd);
  perform t_expect(format('select set_guest_id(%L, ''nin'', '''')', g), 'POLICY_VIOLATION: id both');
  perform t_expect(format('select set_guest_id(%L, '''', ''12345678'')', g), 'POLICY_VIOLATION: id both');
  perform t_expect(format('select set_guest_id(%L, ''library'', ''12345678'')', g), 'POLICY_VIOLATION: id type');
  perform t_expect(format('select set_guest_id(%L, ''nin'', ''12345'')', g), 'POLICY_VIOLATION: id number');
  perform t_expect(format('select set_guest_id(%L, ''nin'', %L)', g, repeat('1', 41)), 'POLICY_VIOLATION: id number');
  perform t_expect(format('select set_guest_id(%L, ''nin'', ''1234567; drop table guests'')', g), 'POLICY_VIOLATION: id number');
  perform t_sys();
  if (select id_number from guest_identity_documents where guest_id = g) <> 'A01234 5678' then raise exception 'FAIL a refused value changed the ID'; end if;

  -- 6. replace then clear (both blank); clearing a guest with none writes nothing
  perform t_as(fd);
  perform set_guest_id(g, 'nin', '12345678901');
  perform t_sys();
  if (select id_type from guest_identity_documents where guest_id = g) <> 'nin' then raise exception 'FAIL replace did not work'; end if;
  perform t_as(fd);
  perform set_guest_id(g2, '', '');
  perform set_guest_id(g, '', '');
  perform t_sys();
  if exists (select 1 from guest_identity_documents where guest_id = g) then raise exception 'FAIL clear did not remove the ID'; end if;
  if (select count(*) from audit_logs where action = 'guest_id.cleared' and entity_id = g) <> 1 or (select count(*) from audit_logs where action = 'guest_id.cleared' and entity_id = g2) <> 0 then raise exception 'FAIL clear audit wrong'; end if;

  -- 7. retention: an ID stays while the guest has a live or recent stay; goes 90 days after the last one; a cancelled stay does not count;
  -- a fresh ID on a guest with no stay stays for 90 days
  perform t_as(fd);
  perform set_guest_id(g, 'nin', '11111111111');     -- recent stay: keep
  perform set_guest_id(g2, 'passport', 'B0000002');  -- only a cancelled stay, old ID: purge
  perform set_guest_id(g3, 'voters_card', 'C0000003'); -- no stay, but added just now: keep, then old: purge
  perform t_sys();
  insert into reservations (tenant_id, property_id, booking_reference, primary_guest_id, source, reservation_status, arrival_date, departure_date)
    values (v_t, v_p, 'T183-A', g, 'staff_entry', 'checked_out', current_date - 5, current_date - 3),
           (v_t, v_p, 'T183-B', g2, 'staff_entry', 'cancelled', current_date + 5, current_date + 7);
  update guest_identity_documents set updated_at = now() - interval '100 days' where guest_id in (g, g2);
  res := purge_old_operational_data();
  if not exists (select 1 from guest_identity_documents where guest_id = g) then raise exception 'FAIL an ID was purged while the guest has a recent stay'; end if;
  if exists (select 1 from guest_identity_documents where guest_id = g2) then raise exception 'FAIL an old ID with only a cancelled stay was kept'; end if;
  if not exists (select 1 from guest_identity_documents where guest_id = g3) then raise exception 'FAIL a fresh ID was purged'; end if;
  if (res ->> 'guest_ids')::int <> 1 then raise exception 'FAIL purge count %', res; end if;
  if (select count(*) from audit_logs where action = 'guest_id.purged' and entity_id = g2) <> 1 then raise exception 'FAIL purge not audited'; end if;
  update reservations set departure_date = current_date - 120, arrival_date = current_date - 122 where booking_reference = 'T183-A';
  update guest_identity_documents set updated_at = now() - interval '100 days' where guest_id in (g, g3);
  res := purge_old_operational_data();
  if exists (select 1 from guest_identity_documents where guest_id in (g, g3)) then raise exception 'FAIL IDs 90 days past the last stay were kept'; end if;
  if (res ->> 'guest_ids')::int <> 2 then raise exception 'FAIL second purge count %', res; end if;
  perform t_as(owner);
  begin perform purge_old_operational_data(); raise exception 'FAIL a signed-in owner ran the purge';
  exception when insufficient_privilege then null; end;

  raise notice 'PASS guest ID: closed table, masked for guest.view, full only for owner and general manager with every reveal audited, numbers never in the audit trail, validation, replace and clear, 90-day retention purge';
end $$;
