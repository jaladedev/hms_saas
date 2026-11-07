-- Discount limits for each hotel (migration 059, set_discount_cap, apply_discount reading the override).
-- Reuses t_as / t_sys / t_expect / t_book (05). Users: aa01 owner A (staff.manage), aa04 front desk A (default cap 10%), aa05 accountant A,
-- aa02 housekeeping A, bb01 owner of Hotel B. Ids: a2 property A, a3 room type. Offsets 1300 and up are used by nothing else.
\set ON_ERROR_STOP on

create table t60_ctx (label text primary key, val text not null);
create function t60_disc(p_res uuid, p_pct numeric, p_key text) returns jsonb language sql as $$ select apply_discount(p_res, p_pct, 'cap test', p_key) $$;
create function t60_cap(p_role text) returns numeric language sql stable as $$
  select coalesce((select max_percent from discount_cap_overrides where property_id = '00000000-0000-0000-0000-0000000000a2' and role_key = p_role),
                  (select max_percent from discount_caps where role_key = p_role)) $$;

-- 1. Table facts
do $$ begin
  if not (select relrowsecurity from pg_class where oid = 'discount_cap_overrides'::regclass) then raise exception 'FAIL row-level security is off'; end if;
  if has_table_privilege('authenticated', 'discount_cap_overrides', 'insert') or has_table_privilege('authenticated', 'discount_cap_overrides', 'update') or has_table_privilege('authenticated', 'discount_cap_overrides', 'delete')
    then raise exception 'FAIL clients can write the overrides directly'; end if;
  raise notice 'PASS the overrides table is read-only to clients, with row-level security';
end $$;

-- 2. Who may set a limit, and what is accepted
do $$ declare p uuid := '00000000-0000-0000-0000-0000000000a2'; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select set_discount_cap(%L, %L, 50)', p, 'front_desk'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select set_discount_cap(%L, %L, 50)', p, 'front_desk'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select set_discount_cap(%L, %L, 50)', p, 'front_desk'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select set_discount_cap(%L, %L, 50)', p, 'front_desk'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select set_discount_cap(%L, %L, 50)', gen_random_uuid(), 'front_desk'), 'NOT_FOUND');
  perform t_expect(format('select set_discount_cap(%L, %L, 100.01)', p, 'front_desk'), 'POLICY_VIOLATION: percent');
  perform t_expect(format('select set_discount_cap(%L, %L, -1)', p, 'front_desk'), 'POLICY_VIOLATION: percent');
  perform t_expect(format('select set_discount_cap(%L, %L, 7.555)', p, 'front_desk'), 'POLICY_VIOLATION: percent');
  perform t_expect(format('select set_discount_cap(%L, %L, 5)', p, 'accountant'), 'POLICY_VIOLATION: role');
  perform t_expect(format('select set_discount_cap(%L, %L, 5)', p, 'housekeeping'), 'POLICY_VIOLATION: role');
  perform t_expect(format('select set_discount_cap(%L, %L, 5)', p, 'no_such_role'), 'POLICY_VIOLATION: role');
  perform t_expect(format('select set_discount_cap(%L, null, 5)', p), 'POLICY_VIOLATION: role');
  perform t_sys();
  if (select count(*) from discount_cap_overrides) <> 0 or (select count(*) from audit_logs where action = 'discount_cap.set') <> 0 then raise exception 'FAIL a refused call changed something'; end if;
  raise notice 'PASS refusals: only the owner; a role without discount.apply, a bad percent and an unknown hotel are refused; nothing changed';
end $$;

-- 3. The override replaces the default for this hotel only: front desk is held to 10%, then given 25%, then back to 10%
do $$ declare
  p uuid := '00000000-0000-0000-0000-0000000000a2'; t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; r jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1300, t + 1302, 'dcc-res-1'); res := (b ->> 'reservation_id')::uuid;
  perform t_sys(); insert into t60_ctx values ('res', res::text);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t60_disc(%L, 20, %L)', res, 'dcc-k-0001'), 'POLICY_VIOLATION: discount limit');   -- the default is 10
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := set_discount_cap(p, 'front_desk', 25);
  perform set_discount_cap(p, 'front_desk', 25);   -- the same value again: no new audit row
  perform t_sys();
  if r ->> 'source' <> 'override' or (r ->> 'percent')::numeric <> 25 then raise exception 'FAIL answer %', r; end if;
  if (select count(*) from audit_logs where action = 'discount_cap.set') <> 1 then raise exception 'FAIL one audit row for one change'; end if;
  if (select (metadata ->> 'from_percent') || '>' || (metadata ->> 'to_percent') from audit_logs where action = 'discount_cap.set') <> '10.00>25.00'
    then raise exception 'FAIL audit content %', (select metadata from audit_logs where action = 'discount_cap.set'); end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t60_disc(res, 20, 'dcc-k-0002');          -- now allowed
  perform t_expect(format('select t60_disc(%L, 25.01, %L)', res, 'dcc-k-0003'), 'POLICY_VIOLATION: discount limit');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := set_discount_cap(p, 'front_desk', null);     -- back to the default
  perform t_sys();
  if r ->> 'source' <> 'default' or (r ->> 'percent')::numeric <> 10 then raise exception 'FAIL reset answer %', r; end if;
  if (select count(*) from discount_cap_overrides) <> 0 then raise exception 'FAIL the override was not removed'; end if;
  if (select count(*) from audit_logs where action = 'discount_cap.set') <> 2 then raise exception 'FAIL reset audit'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t60_disc(%L, 20, %L)', res, 'dcc-k-0004'), 'POLICY_VIOLATION: discount limit');
  perform t60_disc(res, 10, 'dcc-k-0005');
  -- resetting what was never overridden writes no audit
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_discount_cap(p, 'front_desk', null);
  perform t_sys();
  if (select count(*) from audit_logs where action = 'discount_cap.set') <> 2 then raise exception 'FAIL a no-op reset wrote audit'; end if;
  raise notice 'PASS override: replaces the default for this hotel, same value or no-op reset writes no audit, reset returns to the default';
end $$;

-- 4. A lower limit than the default holds too, and a person with two roles gets the highest
do $$ declare
  p uuid := '00000000-0000-0000-0000-0000000000a2'; res uuid := (select val::uuid from t60_ctx where label = 'res'); begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_discount_cap(p, 'front_desk', 2);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t60_disc(%L, 5, %L)', res, 'dcc-k-0010'), 'POLICY_VIOLATION: discount limit');
  perform t60_disc(res, 2, 'dcc-k-0011');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_discount_cap(p, 'front_desk', 0);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t60_disc(%L, 1, %L)', res, 'dcc-k-0012'), 'POLICY_VIOLATION: discount limit');
  perform t60_disc(res, 0, 'dcc-k-0013');           -- removing is still fine at a 0% limit
  -- front desk and general manager together: the highest limit wins (general manager's default is 100)
  perform t_sys();
  insert into membership_roles (membership_id, role_id) select '00000000-0000-0000-0000-0000000aaa04', id from roles where key = 'general_manager';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t60_disc(res, 40, 'dcc-k-0014');
  perform t_sys();
  delete from membership_roles where membership_id = '00000000-0000-0000-0000-0000000aaa04' and role_id = (select id from roles where key = 'general_manager');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_discount_cap(p, 'front_desk', null);
  perform t_sys();
  if (select discount_minor from reservations where id = res) = 0 then raise exception 'FAIL the 40%% discount should be in place'; end if;
  raise notice 'PASS a hotel may set a lower limit than the default (even 0), removing is always allowed, two roles give the higher limit';
end $$;

-- 5. Hotels do not touch each other; who reads the overrides
do $$ declare p uuid := '00000000-0000-0000-0000-0000000000a2'; n integer; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_discount_cap(p, 'general_manager', 60);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  select count(*) into n from discount_cap_overrides; if n <> 1 then raise exception 'FAIL owner reads the override (%)', n; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  select count(*) into n from discount_cap_overrides; if n <> 1 then raise exception 'FAIL front desk reads its hotel''s overrides (%)', n; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  select count(*) into n from discount_cap_overrides; if n <> 0 then raise exception 'FAIL accountant reads overrides (%)', n; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  select count(*) into n from discount_cap_overrides; if n <> 0 then raise exception 'FAIL housekeeping reads overrides (%)', n; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  select count(*) into n from discount_cap_overrides; if n <> 0 then raise exception 'FAIL another hotel reads overrides (%)', n; end if;
  if (select max_percent from discount_caps where role_key = 'general_manager') <> 100 then raise exception 'FAIL the platform default changed'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_discount_cap(p, 'general_manager', null);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('role', 'anon', true);
  begin perform set_discount_cap(p, 'front_desk', 5); raise exception 'FAIL anon set a limit';
  exception when insufficient_privilege then null; end;
  perform set_config('role', 'postgres', true);
  raise notice 'PASS isolation: the default table is untouched, the override is seen only by that hotel''s people who can discount or manage staff, anon cannot set one';
end $$;
