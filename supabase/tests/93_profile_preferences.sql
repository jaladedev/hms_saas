-- update_my_profile (migration 092). Reuses t_as / t_sys / t_expect (05). aa04 front desk A, aa01 owner A.
\set ON_ERROR_STOP on

-- 1. a first save creates the row, normalises, and defaults to comfortable only when asked to
do $$
declare r jsonb; p user_profiles%rowtype;
begin
  perform t_sys();
  delete from user_profiles where id = '00000000-0000-0000-0000-00000000aa04';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := update_my_profile('  Ngozi   Okoye ', ' +2348000000042 ', 'compact');
  perform t_sys();
  select * into p from user_profiles where id = '00000000-0000-0000-0000-00000000aa04';
  if p.full_name <> 'Ngozi Okoye' or p.phone <> '+2348000000042' or p.density <> 'compact' then raise exception 'FAIL stored %', to_jsonb(p); end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := update_my_profile('Ngozi Okoye', '   ', 'comfortable');
  perform t_sys();
  select * into p from user_profiles where id = '00000000-0000-0000-0000-00000000aa04';
  if p.phone is not null or p.density <> 'comfortable' then raise exception 'FAIL second save %', to_jsonb(p); end if;
  if (select count(*) from user_profiles where id = '00000000-0000-0000-0000-00000000aa04') <> 1 then raise exception 'FAIL duplicate profile rows'; end if;
  raise notice 'PASS update_my_profile: creates the row on first save, trims, a blank phone clears it, a second save updates the same row';
end $$;

-- 2. it only ever changes the caller's own row
do $$
declare v_other text;
begin
  perform t_sys();
  insert into user_profiles (id, full_name, density) values ('00000000-0000-0000-0000-00000000aa01', 'Owner A', 'comfortable')
    on conflict (id) do update set full_name = 'Owner A', density = 'comfortable';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform update_my_profile('Changed Name', null, 'compact');
  perform t_sys();
  select full_name || '/' || density into v_other from user_profiles where id = '00000000-0000-0000-0000-00000000aa01';
  if v_other <> 'Owner A/comfortable' then raise exception 'FAIL another person''s profile changed: %', v_other; end if;
  raise notice 'PASS update_my_profile: another person''s profile is untouched';
end $$;

-- 3. bad values change nothing
do $$
declare v_try text; v_refused integer := 0; v_name text;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform update_my_profile('Steady Name', null, 'comfortable');
  for v_try in select unnest(array['no name', 'blank name', 'name long', 'phone long', 'no density', 'bad density'])
  loop
    begin
      case v_try
        when 'no name' then perform update_my_profile(null, null, 'comfortable');
        when 'blank name' then perform update_my_profile('   ', null, 'comfortable');
        when 'name long' then perform update_my_profile(repeat('n', 201), null, 'comfortable');
        when 'phone long' then perform update_my_profile('X', repeat('1', 41), 'comfortable');
        when 'no density' then perform update_my_profile('X', null, null);
        when 'bad density' then perform update_my_profile('X', null, 'cosy');
      end case;
      raise exception 'FAIL % was accepted', v_try;
    exception when sqlstate 'P0001' then
      if sqlerrm not like 'POLICY_VIOLATION%' then raise; end if;
      v_refused := v_refused + 1;
    end;
  end loop;
  if v_refused <> 6 then raise exception 'FAIL only % refused', v_refused; end if;
  perform t_sys();
  select full_name into v_name from user_profiles where id = '00000000-0000-0000-0000-00000000aa04';
  if v_name <> 'Steady Name' then raise exception 'FAIL a refused save changed the name: %', v_name; end if;
  raise notice 'PASS update_my_profile: 6 bad values refused and nothing stored';
end $$;

-- 4. signed out and unknown callers are refused; anon cannot call it
do $$
declare v_state text;
begin
  perform t_sys();
  perform t_expect($q$select update_my_profile('X', null, 'comfortable')$q$, 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-0000000000ff');
  perform t_expect($q$select update_my_profile('X', null, 'comfortable')$q$, 'NOT_FOUND');
  perform t_sys();
  begin
    set local role anon;
    perform update_my_profile('X', null, 'comfortable');
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon may call update_my_profile'; end if;
  raise notice 'PASS update_my_profile: no caller, an unknown user and anon are all refused';
end $$;
