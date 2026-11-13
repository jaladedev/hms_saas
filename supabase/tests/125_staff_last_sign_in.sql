-- Staff directory shows when each person last signed in (migration 125). Hotel A: owner aa01, front desk aa04. Other hotel's owner bb01.
\set ON_ERROR_STOP on

-- 1. the directory carries last_sign_in_at: the time when there is one, null when the person never signed in
do $$ declare d jsonb; v_t timestamptz := now() - interval '3 days'; begin
  perform t_sys();
  update auth.users set last_sign_in_at = v_t where id = '00000000-0000-0000-0000-00000000aa04';
  update auth.users set last_sign_in_at = null where id = '00000000-0000-0000-0000-00000000aa01';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  d := staff_directory();
  if not exists (select 1 from jsonb_array_elements(d) x where x ->> 'user_id' = '00000000-0000-0000-0000-00000000aa04'
                   and (x ->> 'last_sign_in_at')::timestamptz = v_t) then
    raise exception 'FAIL front desk sign-in time missing %', d;
  end if;
  if not exists (select 1 from jsonb_array_elements(d) x where (x ->> 'is_self')::boolean and x -> 'last_sign_in_at' = 'null'::jsonb) then
    raise exception 'FAIL a person who never signed in should show null %', d;
  end if;
  raise notice 'PASS staff directory: last sign-in shown, null when never signed in';
end $$;

-- 2. nothing else changed: the same people, still only the owner's own hotel group, front desk and anon still see nothing
do $$ declare d jsonb; begin
  perform t_sys();
  update auth.users set last_sign_in_at = now() where id = '00000000-0000-0000-0000-00000000bb01';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  d := staff_directory();
  if exists (select 1 from jsonb_array_elements(d) x where x ->> 'tenant_id' <> '00000000-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL directory leaks another hotel group';
  end if;
  if exists (select 1 from jsonb_array_elements(d) x where x ->> 'user_id' = '00000000-0000-0000-0000-00000000bb01') then
    raise exception 'FAIL hotel B owner visible to hotel A';
  end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if staff_directory() <> '[]'::jsonb then raise exception 'FAIL front desk sees the directory'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  d := staff_directory();
  if jsonb_array_length(d) <> 1 or d -> 0 ->> 'user_id' <> '00000000-0000-0000-0000-00000000bb01' then raise exception 'FAIL hotel B directory %', d; end if;
  perform t_sys();
  perform t_expect('select staff_directory()', 'NOT_FOUND');
  perform set_config('role', 'anon', true);
  begin perform staff_directory(); raise exception 'FAIL anon may read the directory';
  exception when insufficient_privilege then null; end;
  perform t_sys();
  raise notice 'PASS staff directory: still scoped to the caller''s hotel group, front desk and anon refused';
end $$;
