-- create_guest (migration 091). Reuses t_as / t_sys / t_expect (05).
-- Hotel A is property a2 (tenant of owner aa01, front desk aa04 with guest.manage, accountant aa05 with guest.view only);
-- bb01 owns hotel B, a different group.
\set ON_ERROR_STOP on

-- 1. front desk adds a guest: values normalised, audited by field names only, listed under the right group
do $$
declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb; v_id uuid; g guests%rowtype; v_audit integer;
begin
  perform t_sys();
  select count(*) into v_audit from audit_logs where action = 'guest.created';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := create_guest(v_p, '  Chidi   Eze ', ' CHIDI.EZE@Example.COM ', ' +2348000000099 ', '   ', ' ng ');
  v_id := (r ->> 'guest_id')::uuid;
  if not (r ->> 'created')::boolean then raise exception 'FAIL not created %', r; end if;
  perform t_sys();
  select * into g from guests where id = v_id;
  if g.full_name <> 'Chidi Eze' or g.email <> 'chidi.eze@example.com' or g.phone <> '+2348000000099' or g.address is not null or g.country_code <> 'NG'
     or g.tenant_id <> (select tenant_id from properties where id = v_p) then raise exception 'FAIL stored values %', to_jsonb(g); end if;
  if (select count(*) from audit_logs where action = 'guest.created') <> v_audit + 1 then raise exception 'FAIL audit count'; end if;
  if not exists (select 1 from audit_logs where action = 'guest.created' and entity_id = v_id and metadata -> 'fields' = '["full_name","email","phone","country_code"]'::jsonb)
    then raise exception 'FAIL audit fields'; end if;
  if exists (select 1 from audit_logs where action = 'guest.created' and (metadata::text like '%chidi%' or metadata::text like '%Eze%' or metadata::text like '%2348000000099%'))
    then raise exception 'FAIL audit holds personal data'; end if;
  raise notice 'PASS create_guest: trimmed, email lower-cased, blank address null, country upper-cased, audited by field names only';
end $$;

-- 2. the same email again (any case) returns the existing guest and adds nothing; no email always adds
do $$
declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r1 jsonb; r2 jsonb; r3 jsonb; r4 jsonb; v_n integer; v_audit integer;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r1 := create_guest(v_p, 'Dup One', 'dup@example.com', null, null, null);
  perform t_sys();
  select count(*) into v_audit from audit_logs where action = 'guest.created';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r2 := create_guest(v_p, 'Dup Two', ' DUP@EXAMPLE.COM ', null, null, null);
  if (r2 ->> 'created')::boolean or r2 ->> 'guest_id' <> r1 ->> 'guest_id' then raise exception 'FAIL duplicate email made a second guest %', r2; end if;
  r3 := create_guest(v_p, 'No Email', null, null, null, null);
  r4 := create_guest(v_p, 'No Email', '', null, null, null);
  if not (r3 ->> 'created')::boolean or not (r4 ->> 'created')::boolean or r3 ->> 'guest_id' = r4 ->> 'guest_id' then raise exception 'FAIL no-email guests %', r3; end if;
  perform t_sys();
  select count(*) into v_n from guests where lower(email) = 'dup@example.com';
  if v_n <> 1 then raise exception 'FAIL % guests share the email', v_n; end if;
  if (select full_name from guests where id = (r1 ->> 'guest_id')::uuid) <> 'Dup One' then raise exception 'FAIL the existing guest was overwritten'; end if;
  if (select count(*) from audit_logs where action = 'guest.created') <> v_audit + 2 then raise exception 'FAIL the repeat wrote an audit row or a new guest missed one'; end if;
  raise notice 'PASS create_guest: a repeat email returns the existing guest untouched, guests without an email are always added';
end $$;

-- 3. a booking guest is reused too: the email of a guest made another way is found
do $$
declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_other uuid; r jsonb;
begin
  perform t_sys();
  insert into guests (tenant_id, full_name, email) values ((select tenant_id from properties where id = v_p), 'From Booking', 'frombooking@example.com') returning id into v_other;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := create_guest(v_p, 'Someone Else', 'FromBooking@example.com', null, null, null);
  if (r ->> 'created')::boolean or (r ->> 'guest_id')::uuid <> v_other then raise exception 'FAIL did not reuse the booking guest %', r; end if;
  raise notice 'PASS create_guest: reuses a guest that a booking made';
end $$;

-- 4. refused values add nothing
do $$
declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_try text; v_refused integer := 0; v_before integer; v_after integer;
begin
  perform t_sys();
  select count(*) into v_before from guests;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  for v_try in select unnest(array['no name', 'blank name', 'name long', 'bad email', 'country', 'phone long', 'address long'])
  loop
    begin
      case v_try
        when 'no name' then perform create_guest(v_p, null, null, null, null, null);
        when 'blank name' then perform create_guest(v_p, '   ', null, null, null, null);
        when 'name long' then perform create_guest(v_p, repeat('n', 201), null, null, null, null);
        when 'bad email' then perform create_guest(v_p, 'X', 'not-an-email', null, null, null);
        when 'country' then perform create_guest(v_p, 'X', null, null, null, 'NGA');
        when 'phone long' then perform create_guest(v_p, 'X', null, repeat('1', 41), null, null);
        when 'address long' then perform create_guest(v_p, 'X', null, null, repeat('a', 501), null);
      end case;
      raise exception 'FAIL % was accepted', v_try;
    exception when sqlstate 'P0001' then
      if sqlerrm not like 'POLICY_VIOLATION%' then raise; end if;
      v_refused := v_refused + 1;
    end;
  end loop;
  if v_refused <> 7 then raise exception 'FAIL only % refused', v_refused; end if;
  perform t_sys();
  select count(*) into v_after from guests;
  if v_after <> v_before then raise exception 'FAIL a refused guest was stored'; end if;
  raise notice 'PASS create_guest: 7 bad values refused and nothing stored';
end $$;

-- 5. only guest.manage in this group; anon cannot call it; an unknown hotel looks like no access
do $$
declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_before integer; v_state text;
begin
  perform t_sys();
  select count(*) into v_before from guests;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select create_guest(%L, %L, null, null, null, null)', v_p, 'Viewer Add'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select create_guest(%L, %L, null, null, null, null)', v_p, 'Housekeeping Add'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select create_guest(%L, %L, null, null, null, null)', v_p, 'Other Hotel Add'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select create_guest(%L, %L, null, null, null, null)', gen_random_uuid(), 'Nowhere'), 'NOT_FOUND');
  perform t_sys();
  if (select count(*) from guests) <> v_before then raise exception 'FAIL a refused caller added a guest'; end if;
  begin
    set local role anon;
    perform create_guest(v_p, 'Anon', null, null, null, null);
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon may call create_guest'; end if;
  raise notice 'PASS create_guest: accountant, housekeeping, another hotel and an unknown hotel all get NOT_FOUND; anon is refused';
end $$;
