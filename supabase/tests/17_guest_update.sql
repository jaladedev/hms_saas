-- update_guest (migration 020). Reuses t_as / t_sys / t_expect (05).
-- aa01 owner A, aa02 housekeeping A, aa04 front desk A (guest.manage), aa05 accountant A (guest.view only), bb01 owner B.
-- Guest a5 (Ada Okafor) belongs to hotel A; b5 to hotel B.
\set ON_ERROR_STOP on

do $$ declare r jsonb; v_audit integer; begin
  perform t_sys();
  update guests set email = null, phone = '+2348000000001', address = null, country_code = null where id = '00000000-0000-0000-0000-0000000000a5';
  select count(*) into v_audit from audit_logs where action = 'guest.updated';

  -- front desk may edit; names are trimmed and single-spaced (so this name is unchanged), emails lower-cased, blanks become null, country upper-cased
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := update_guest('00000000-0000-0000-0000-0000000000a5', '  Ada  Okafor ', ' ADA@Example.COM ', ' +2348000000001 ', '  ', ' ng ');
  if not (r ->> 'changed')::boolean or r -> 'fields' <> '["email","country_code"]'::jsonb then raise exception 'FAIL first edit %', r; end if;
  perform t_sys();
  if (select email from guests where id = '00000000-0000-0000-0000-0000000000a5') <> 'ada@example.com'
     or (select country_code from guests where id = '00000000-0000-0000-0000-0000000000a5') <> 'NG'
     or (select address from guests where id = '00000000-0000-0000-0000-0000000000a5') is not null then raise exception 'FAIL stored values'; end if;
  if (select count(*) from audit_logs where action = 'guest.updated') <> v_audit + 1 then raise exception 'FAIL audit count'; end if;
  if exists (select 1 from audit_logs where action = 'guest.updated' and metadata::text like '%ada@example.com%') then raise exception 'FAIL audit holds personal data'; end if;

  -- saving the same values again changes nothing and writes nothing
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := update_guest('00000000-0000-0000-0000-0000000000a5', 'Ada Okafor', 'ada@example.com', '+2348000000001', '', 'NG');
  if (r ->> 'changed')::boolean then raise exception 'FAIL repeat changed %', r; end if;
  perform t_sys();
  if (select count(*) from audit_logs where action = 'guest.updated') <> v_audit + 1 then raise exception 'FAIL repeat wrote audit'; end if;
  raise notice 'PASS update_guest: normalised, only changed fields audited (names not values), repeat is a no-op';
end $$;

do $$ begin
  -- who may not
  perform t_as('00000000-0000-0000-0000-00000000aa05');         -- accountant: guest.view only
  perform t_expect($q$select update_guest('00000000-0000-0000-0000-0000000000a5', 'X', null, null, null, null)$q$, 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');         -- housekeeping
  perform t_expect($q$select update_guest('00000000-0000-0000-0000-0000000000a5', 'X', null, null, null, null)$q$, 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');         -- another hotel group
  perform t_expect($q$select update_guest('00000000-0000-0000-0000-0000000000a5', 'X', null, null, null, null)$q$, 'NOT_FOUND');
  perform t_expect($q$select update_guest(gen_random_uuid(), 'X', null, null, null, null)$q$, 'NOT_FOUND');
  perform t_sys();
  perform t_expect($q$select update_guest('00000000-0000-0000-0000-0000000000a5', 'X', null, null, null, null)$q$, 'NOT_FOUND');
  if (select full_name from guests where id = '00000000-0000-0000-0000-0000000000a5') <> 'Ada Okafor' then raise exception 'FAIL a refused edit changed the guest'; end if;

  -- validation (owner)
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect($q$select update_guest('00000000-0000-0000-0000-0000000000a5', '   ', null, null, null, null)$q$, 'POLICY_VIOLATION: name');
  perform t_expect($q$select update_guest('00000000-0000-0000-0000-0000000000a5', 'Ada', 'not-an-email', null, null, null)$q$, 'POLICY_VIOLATION: email');
  perform t_expect($q$select update_guest('00000000-0000-0000-0000-0000000000a5', 'Ada', 'a b@x.com', null, null, null)$q$, 'POLICY_VIOLATION: email');
  perform t_expect($q$select update_guest('00000000-0000-0000-0000-0000000000a5', 'Ada', null, null, null, 'NGA')$q$, 'POLICY_VIOLATION: country');
  perform t_expect(format('select update_guest(%L, %L, null, %L, null, null)', '00000000-0000-0000-0000-0000000000a5', 'Ada', repeat('9', 41)), 'POLICY_VIOLATION: too long');
  perform t_sys();
  raise notice 'PASS update_guest refusals: view-only, housekeeping and other hotels cannot edit; bad name, email, country and length are refused';
end $$;
