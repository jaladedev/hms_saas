-- Audit of policy versions (migration 031). Reuses t_as / t_sys (05).
-- Users: aa01 owner A (property.configure), aa04 front desk A (cannot configure). Ids: a1 tenant A, a2 property A.
-- The version this file makes starts in 2090 so current_policy never reads it. Each block is its own transaction.
\set ON_ERROR_STOP on

create table t29_ctx (k text primary key, id uuid);

-- 1. Publishing a version records who did it and its values
do $$ declare v_id uuid; a audit_logs%rowtype; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  insert into property_policies (tenant_id, property_id, version, effective_from, config, created_by)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 2900, '2090-01-01',
          '{"online_payment":{"mode":"deposit_percent","value":30}}', '00000000-0000-0000-0000-00000000aa01')
  returning id into v_id;
  perform t_sys();
  insert into t29_ctx values ('row', v_id);
  select * into a from audit_logs where action = 'property_policy.created' and entity_id = v_id;
  if a.id is null or a.actor_user_id is distinct from '00000000-0000-0000-0000-00000000aa01'
     or a.property_id <> '00000000-0000-0000-0000-0000000000a2' or a.entity_type <> 'property_policy'
     or (a.metadata #>> '{values,version}')::int <> 2900
     or a.metadata #>> '{values,config,online_payment,mode}' <> 'deposit_percent' then
    raise exception 'FAIL policy created audit %', a;
  end if;
  raise notice 'PASS publishing a policy version records who did it and its values';
end $$;

-- 2. Front desk cannot publish, and a refused insert leaves no audit row
do $$ declare n_before integer; n_after integer; begin
  select count(*) into n_before from audit_logs where action = 'property_policy.created';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  begin
    insert into property_policies (tenant_id, property_id, version, effective_from, config)
    values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 2901, '2090-02-01', '{}');
    raise exception 'FAIL front desk published a policy';
  exception when insufficient_privilege then null;
  end;
  perform t_sys();
  select count(*) into n_after from audit_logs where action = 'property_policy.created';
  if n_after <> n_before then raise exception 'FAIL a refused insert left an audit row'; end if;
  raise notice 'PASS front desk cannot publish and a refused insert writes nothing';
end $$;

-- 3. A version cannot be edited or deleted, by an owner either
do $$ declare v_id uuid; begin
  select id into v_id from t29_ctx where k = 'row';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin update property_policies set config = '{}' where id = v_id; raise exception 'FAIL edited a version';
  exception when insufficient_privilege or check_violation then null; end;
  begin delete from property_policies where id = v_id; raise exception 'FAIL deleted a version';
  exception when insufficient_privilege or check_violation then null; end;
  perform t_sys();
  raise notice 'PASS a published version cannot be edited or deleted';
end $$;

-- 4. Cleanup is impossible (immutable), so the row stays; it starts in 2090 and affects nothing
