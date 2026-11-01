-- Names for the audit trail (migration 029). Reuses t_as / t_sys (05).
-- Users: aa01 owner A (audit.view), aa04 front desk A (no audit.view), bb01 owner of Hotel B (another hotel group).
-- Each block is its own transaction. Profile and email data is set here as the table owner.
\set ON_ERROR_STOP on

update auth.users set email = 'owner.a@example.test' where id = '00000000-0000-0000-0000-00000000aa01';
update auth.users set email = 'frontdesk.a@example.test' where id = '00000000-0000-0000-0000-00000000aa04';
update auth.users set email = 'owner.b@example.test' where id = '00000000-0000-0000-0000-00000000bb01';
insert into user_profiles (id, full_name) values ('00000000-0000-0000-0000-00000000aa01', '  Ada Owner  ')
  on conflict (id) do update set full_name = excluded.full_name;
insert into user_profiles (id, full_name) values ('00000000-0000-0000-0000-00000000aa04', '   ')
  on conflict (id) do update set full_name = excluded.full_name;

-- 1. An owner sees names for people in their own hotel group: full name trimmed, else email; other groups and unknown ids are absent
do $$ declare r record; n integer; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  select count(*) into n from audit_actor_names(array[
    '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000aa04',
    '00000000-0000-0000-0000-00000000bb01', gen_random_uuid()]::uuid[]);
  select * into r from audit_actor_names(array['00000000-0000-0000-0000-00000000aa01']::uuid[]);
  if r.name is distinct from 'Ada Owner' then raise exception 'FAIL full name % ', r.name; end if;
  select * into r from audit_actor_names(array['00000000-0000-0000-0000-00000000aa04']::uuid[]);
  if r.name is distinct from 'frontdesk.a@example.test' then raise exception 'FAIL blank name falls back to email: %', r.name; end if;
  perform t_sys();
  if n <> 2 then raise exception 'FAIL expected only the two people of hotel A, got %', n; end if;
  raise notice 'PASS an owner gets names for their own hotel group only';
end $$;

-- 2. Someone without audit.view gets nothing, not even their own name
do $$ declare n integer; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  select count(*) into n from audit_actor_names(array[
    '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000aa04']::uuid[]);
  perform t_sys();
  if n <> 0 then raise exception 'FAIL front desk read % names', n; end if;
  raise notice 'PASS a login without audit.view gets no names';
end $$;

-- 3. Another hotel group's owner cannot read hotel A's people
do $$ declare n integer; m integer; begin
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  select count(*) into n from audit_actor_names(array['00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000aa04']::uuid[]);
  select count(*) into m from audit_actor_names(array['00000000-0000-0000-0000-00000000bb01']::uuid[]);
  perform t_sys();
  if n <> 0 or m <> 1 then raise exception 'FAIL cross-hotel names: others % own %', n, m; end if;
  raise notice 'PASS another hotel group cannot look up this hotel''s people';
end $$;

-- 4. A revoked member still resolves (history outlives access); a null or empty list returns nothing; extra ids are capped
do $$ declare n integer; begin
  update tenant_memberships set status = 'revoked' where user_id = '00000000-0000-0000-0000-00000000aa04';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  select count(*) into n from audit_actor_names(array['00000000-0000-0000-0000-00000000aa04']::uuid[]);
  if n <> 1 then raise exception 'FAIL revoked member did not resolve (%)', n; end if;
  select count(*) into n from audit_actor_names(null);
  if n <> 0 then raise exception 'FAIL null list returned %', n; end if;
  select count(*) into n from audit_actor_names(array_fill('00000000-0000-0000-0000-00000000aa01'::uuid, array[500]));
  perform t_sys();
  update tenant_memberships set status = 'active' where user_id = '00000000-0000-0000-0000-00000000aa04';
  if n <> 1 then raise exception 'FAIL repeated ids returned %', n; end if;
  raise notice 'PASS revoked members still resolve, a null list is empty, a long list is read safely';
end $$;

-- 5. Anonymous callers cannot run it at all
do $$ begin
  perform set_config('role', 'anon', true);
  begin
    perform * from audit_actor_names(array['00000000-0000-0000-0000-00000000aa01']::uuid[]);
    raise exception 'FAIL anon ran audit_actor_names';
  exception when insufficient_privilege then
    null;
  end;
  perform t_sys();
  raise notice 'PASS anon cannot call audit_actor_names';
end $$;
