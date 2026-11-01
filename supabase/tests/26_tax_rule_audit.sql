-- Audit of tax rule changes (migration 028). Reuses t_as / t_sys (05).
-- Users: aa01 owner A (property.configure), aa04 front desk A (cannot configure), bb01 owner of Hotel B.
-- Ids: a1 tenant A, a2 property A. The rule this file makes is inactive and starts far in the future, so it never
-- taxes anything and cannot disturb another test. Each block is its own transaction.
\set ON_ERROR_STOP on

create table t26_ctx (k text primary key, id uuid);

-- 1. A rule is created: who, and what values (setup columns only)
do $$ declare v_rule uuid; a audit_logs%rowtype; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  insert into tax_rules (tenant_id, property_id, name, basis, rate_value, sequence, effective_from, status)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'T26 Levy', 'percent', 5, 90, '2090-01-01', 'inactive')
  returning id into v_rule;
  perform t_sys();
  insert into t26_ctx values ('rule', v_rule);
  select * into a from audit_logs where action = 'tax_rule.created' and entity_id = v_rule;
  if a.id is null or a.actor_user_id is distinct from '00000000-0000-0000-0000-00000000aa01'
     or a.property_id <> '00000000-0000-0000-0000-0000000000a2' or a.entity_type <> 'tax_rule'
     or a.metadata #>> '{values,name}' <> 'T26 Levy' or (a.metadata #>> '{values,rate_value}')::numeric <> 5
     or (a.metadata #>> '{values,applies_to_charges}')::boolean is distinct from false
     or (a.metadata -> 'values') ? 'updated_at' or (a.metadata -> 'values') ? 'created_at' then
    raise exception 'FAIL tax rule created audit %', a;
  end if;
  raise notice 'PASS creating a tax rule records who did it and its values';
end $$;

-- 2. Marking a rule for extras records only that change, old and new
do $$ declare v_rule uuid; a audit_logs%rowtype; keys text[]; begin
  select id into v_rule from t26_ctx where k = 'rule';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  update tax_rules set applies_to_charges = true where id = v_rule;
  perform t_sys();
  select * into a from audit_logs where action = 'tax_rule.updated' and entity_id = v_rule;
  select array_agg(key order by key) into keys from jsonb_object_keys(a.metadata -> 'changed') key;
  if a.id is null or keys <> array['applies_to_charges'] or a.actor_user_id is distinct from '00000000-0000-0000-0000-00000000aa01'
     or (a.metadata #>> '{changed,applies_to_charges,from}')::boolean <> false
     or (a.metadata #>> '{changed,applies_to_charges,to}')::boolean <> true then
    raise exception 'FAIL marking a rule audit % %', keys, a;
  end if;
  raise notice 'PASS marking a rule for extras records only that change, old and new';
end $$;

-- 3. Saving without changing anything writes nothing; a rate change is recorded
do $$ declare v_rule uuid; n integer; a audit_logs%rowtype; begin
  select id into v_rule from t26_ctx where k = 'rule';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  update tax_rules set applies_to_charges = true, name = name where id = v_rule;
  perform t_sys();
  select count(*) into n from audit_logs where action = 'tax_rule.updated' and entity_id = v_rule;
  if n <> 1 then raise exception 'FAIL a no-op save wrote an audit row (%)', n; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  update tax_rules set rate_value = 7.5 where id = v_rule;
  perform t_sys();
  select * into a from audit_logs where action = 'tax_rule.updated' and entity_id = v_rule and (metadata -> 'changed') ? 'rate_value';
  if a.id is null or (a.metadata #>> '{changed,rate_value,from}')::numeric <> 5 or (a.metadata #>> '{changed,rate_value,to}')::numeric <> 7.5 then
    raise exception 'FAIL rate change audit %', a;
  end if;
  raise notice 'PASS a no-op save writes nothing and a rate change is recorded';
end $$;

-- 4. People who cannot configure the property, and other hotels, change nothing and leave no trace
do $$ declare v_rule uuid; n integer; rows integer; begin
  select id into v_rule from t26_ctx where k = 'rule';
  select count(*) into n from audit_logs where entity_id = v_rule;

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  update tax_rules set applies_to_charges = false where id = v_rule;
  get diagnostics rows = row_count;
  if rows <> 0 then raise exception 'FAIL front desk changed a tax rule'; end if;

  perform t_as('00000000-0000-0000-0000-00000000bb01');
  update tax_rules set applies_to_charges = false where id = v_rule;
  get diagnostics rows = row_count;
  if rows <> 0 then raise exception 'FAIL another hotel changed a tax rule'; end if;
  perform t_sys();

  if (select applies_to_charges from tax_rules where id = v_rule) is not true then raise exception 'FAIL the rule changed'; end if;
  if (select count(*) from audit_logs where entity_id = v_rule) <> n then raise exception 'FAIL a refused change left an audit row'; end if;
  raise notice 'PASS front desk and another hotel change nothing and leave no audit row';
end $$;

-- 5. A fixed-per-night rule cannot be marked for extras (027), so the screen never offers it
do $$ declare v_rule uuid; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  insert into tax_rules (tenant_id, property_id, name, basis, rate_value, sequence, effective_from, status)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'T26 Fixed', 'fixed_per_night', 1000, 91, '2090-01-01', 'inactive')
  returning id into v_rule;
  begin
    update tax_rules set applies_to_charges = true where id = v_rule;
    raise exception 'FAIL a fixed rule was marked for extras';
  exception when check_violation then null;
  end;
  perform t_sys();
  raise notice 'PASS a fixed-per-night rule cannot be marked for extras';
end $$;
