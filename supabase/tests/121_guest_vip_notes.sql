-- set_guest_profile (migration 121). Reuses t_as / t_sys / t_expect (05). Hotel A: tenant a1, guest a5. Owner aa01, front desk aa04,
-- housekeeping aa02, accountant aa05, other hotel's owner bb01.
\set ON_ERROR_STOP on

-- 1. the owner sets VIP and a note: trimmed, stored, audited by field name only, and read back by the front desk
do $$
declare
  v_g constant uuid := '00000000-0000-0000-0000-0000000000a5'; r jsonb; v_audit integer; v_notes text; v_vip boolean;
begin
  perform t_sys();
  update guests set vip = false, notes = null where id = v_g;
  select count(*) into v_audit from audit_logs where action = 'guest.profile_updated';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := set_guest_profile(v_g, true, E'  Prefers a quiet room.\r\nAllergic to feathers.  ');
  if not (r ->> 'changed')::boolean or r -> 'fields' <> '["vip","notes"]'::jsonb then raise exception 'FAIL result %', r; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  select vip, notes into v_vip, v_notes from guests where id = v_g;
  if v_vip is not true or v_notes <> E'Prefers a quiet room.\nAllergic to feathers.' then raise exception 'FAIL front desk reads % / %', v_vip, v_notes; end if;
  perform t_sys();
  if (select count(*) from audit_logs where action = 'guest.profile_updated') <> v_audit + 1 then raise exception 'FAIL audit count'; end if;
  if not exists (select 1 from audit_logs where action = 'guest.profile_updated' and entity_id = v_g and metadata -> 'fields' = '["vip","notes"]'::jsonb)
    then raise exception 'FAIL audit fields'; end if;
  if exists (select 1 from audit_logs where action = 'guest.profile_updated' and (metadata::text ilike '%feathers%' or metadata::text ilike '%quiet%'))
    then raise exception 'FAIL the audit row holds the note'; end if;
  raise notice 'PASS set_guest_profile: VIP and note stored, notes trimmed, line breaks made \n, readable by the front desk, audited by field names only';
end $$;

-- 2. saving the same thing again changes nothing and audits nothing; changing one field audits just that field
do $$
declare
  v_g constant uuid := '00000000-0000-0000-0000-0000000000a5'; r jsonb; v_audit integer;
begin
  perform t_sys();
  select count(*) into v_audit from audit_logs where action = 'guest.profile_updated';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := set_guest_profile(v_g, true, E'Prefers a quiet room.\nAllergic to feathers.');
  if (r ->> 'changed')::boolean then raise exception 'FAIL an unchanged save reported a change %', r; end if;
  perform t_sys();
  if (select count(*) from audit_logs where action = 'guest.profile_updated') <> v_audit then raise exception 'FAIL an unchanged save was audited'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := set_guest_profile(v_g, false, E'Prefers a quiet room.\nAllergic to feathers.');
  if r -> 'fields' <> '["vip"]'::jsonb then raise exception 'FAIL only vip changed %', r; end if;
  perform t_sys();
  if (select count(*) from audit_logs where action = 'guest.profile_updated') <> v_audit + 1 then raise exception 'FAIL one audit row expected'; end if;
  raise notice 'PASS set_guest_profile: an unchanged save is silent; one changed field is one audited field';
end $$;

-- 3. a blank note clears it
do $$
declare
  v_g constant uuid := '00000000-0000-0000-0000-0000000000a5'; r jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := set_guest_profile(v_g, false, '   ');
  if r -> 'fields' <> '["notes"]'::jsonb then raise exception 'FAIL clearing %', r; end if;
  perform t_sys();
  if (select notes from guests where id = v_g) is not null then raise exception 'FAIL the note was not cleared'; end if;
  raise notice 'PASS set_guest_profile: a blank note becomes null';
end $$;

-- 4. bad values change nothing, by the function and by the table
do $$
declare
  v_g constant uuid := '00000000-0000-0000-0000-0000000000a5'; v_try text; v_refused integer := 0;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_guest_profile(v_g, false, 'Steady note');
  for v_try in select unnest(array['note too long', 'no vip'])
  loop
    begin
      case v_try
        when 'note too long' then perform set_guest_profile(v_g, true, repeat('n', 2001));
        when 'no vip' then perform set_guest_profile(v_g, null, 'x');
      end case;
      raise exception 'FAIL % was accepted', v_try;
    exception when sqlstate 'P0001' then
      if sqlerrm not like 'POLICY_VIOLATION%' then raise; end if;
      v_refused := v_refused + 1;
    end;
  end loop;
  if v_refused <> 2 then raise exception 'FAIL only % refused', v_refused; end if;
  -- exactly 2000 is allowed
  perform set_guest_profile(v_g, false, repeat('n', 2000));
  perform t_sys();
  if (select length(notes) from guests where id = v_g) <> 2000 then raise exception 'FAIL a 2000 character note was not kept'; end if;
  begin update guests set notes = repeat('n', 2001) where id = v_g; raise exception 'FAIL the table took 2001 characters';
  exception when check_violation then null; end;
  begin update guests set notes = '' where id = v_g; raise exception 'FAIL the table took an empty note';
  exception when check_violation then null; end;
  update guests set vip = false, notes = null where id = v_g;
  raise notice 'PASS set_guest_profile: too-long notes and a missing VIP value are refused; 2000 characters is the limit; the table refuses too';
end $$;

-- 5. only guest.manage in the guest's hotel group; nobody can write the columns directly; anon cannot call it
do $$
declare
  v_g constant uuid := '00000000-0000-0000-0000-0000000000a5'; v_state text; v_u text;
begin
  foreach v_u in array array['00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-00000000aa05', '00000000-0000-0000-0000-00000000bb01'] loop
    perform t_as(v_u);
    perform t_expect(format('select set_guest_profile(%L, true, %L)', v_g, 'sneaky'), 'NOT_FOUND');
  end loop;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select set_guest_profile(%L, true, null)', gen_random_uuid()), 'NOT_FOUND');
  begin update guests set vip = true where id = v_g; raise exception 'FAIL a client wrote guests.vip directly';
  exception when insufficient_privilege then null; end;
  perform t_sys();
  if (select vip from guests where id = v_g) or (select notes from guests where id = v_g) is not null then raise exception 'FAIL a refused caller changed the guest'; end if;
  begin
    set local role anon;
    perform set_guest_profile(v_g, true, null);
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon may call set_guest_profile'; end if;
  raise notice 'PASS set_guest_profile: housekeeping, accountant, another hotel and an unknown guest get NOT_FOUND; no direct writes; anon refused';
end $$;
