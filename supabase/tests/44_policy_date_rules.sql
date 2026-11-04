-- Policy version dates (migration 043). Owner of Hotel A (aa01) holds property.configure at a2; the accountant (aa05 in 03? use ab04 from 42)
-- has none. Dates are built from the latest stored version so the file does not depend on what earlier tests inserted.
\set ON_ERROR_STOP on

do $$ declare
  a constant uuid := '00000000-0000-0000-0000-0000000000a2'; ten constant uuid := '00000000-0000-0000-0000-0000000000a1';
  v_latest date; v_ver integer; v_new date;
begin
  select max(effective_from), max(version) into v_latest, v_ver from property_policies where property_id = a;
  v_new := v_latest + 10;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  -- before today
  begin
    insert into property_policies (tenant_id, property_id, version, effective_from, config) values (ten, a, v_ver + 1, current_date - 5, '{}');
    raise exception 'FAIL a past date was accepted';
  exception when sqlstate 'P0001' then
    if sqlerrm not like 'POLICY_VIOLATION: policy date in the past%' then raise exception 'FAIL wrong refusal %', sqlerrm; end if;
  end;
  -- on the latest date, and before it
  begin
    insert into property_policies (tenant_id, property_id, version, effective_from, config) values (ten, a, v_ver + 1, v_latest, '{}');
    raise exception 'FAIL the latest date again was accepted';
  exception when sqlstate 'P0001' then
    if sqlerrm not like 'POLICY_VIOLATION: policy date not after the latest version%' then raise exception 'FAIL wrong refusal %', sqlerrm; end if;
  end;
  begin
    insert into property_policies (tenant_id, property_id, version, effective_from, config) values (ten, a, v_ver + 1, v_latest - 1, '{}');
    raise exception 'FAIL a date before the latest was accepted';
  exception when sqlstate 'P0001' then null;
  end;
  if (select count(*) from property_policies where property_id = a) <> (select count(*) from property_policies where property_id = a and version <= v_ver) then
    raise exception 'FAIL a refused version was stored';
  end if;
  -- a later date goes in, then the same date again is refused
  insert into property_policies (tenant_id, property_id, version, effective_from, config) values (ten, a, v_ver + 1, v_new, '{}');
  begin
    insert into property_policies (tenant_id, property_id, version, effective_from, config) values (ten, a, v_ver + 2, v_new, '{}');
    raise exception 'FAIL the same date twice was accepted';
  exception when sqlstate 'P0001' then null;
  end;
  perform t_sys();
  raise notice 'PASS an owner cannot publish a policy dated in the past, on or before the latest version, or twice on one day';

  -- Another hotel's dates do not constrain this one
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  insert into property_policies (tenant_id, property_id, version, effective_from, config)
    select '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2', coalesce(max(version), 0) + 1, greatest(coalesce(max(effective_from), current_date), current_date) + 1, '{}'
      from property_policies where property_id = '00000000-0000-0000-0000-0000000000b2';
  perform t_sys();
  raise notice 'PASS the rule is per property: Hotel B publishes without regard to Hotel A''s versions';

  -- The system loads history as it always has
  insert into property_policies (tenant_id, property_id, version, effective_from, config) values (ten, a, v_ver + 50, current_date - 400, '{}');
  raise notice 'PASS the system can still insert a past version (fixtures, migrations)';

  -- A login without property.configure is still refused by row level security, before any date is looked at
  perform t_as('00000000-0000-0000-0000-00000000ab04');
  begin
    insert into property_policies (tenant_id, property_id, version, effective_from, config) values (ten, a, v_ver + 60, v_new + 400, '{}');
    raise exception 'FAIL an accountant published a policy';
  exception when insufficient_privilege then null;
  end;
  perform t_sys();
  raise notice 'PASS a login without property.configure is still refused';
end $$;
