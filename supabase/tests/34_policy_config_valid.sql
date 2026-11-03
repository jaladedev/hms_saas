-- Policy JSON validity (migration 035). Reuses t_as / t_sys (05). bb01 owns Hotel B (property b2).
\set ON_ERROR_STOP on

-- 1. What a valid policy looks like (the checks run on the exact shapes the functions read)
do $$ declare c record; begin
  for c in select * from (values
    ('empty', '{}', true),
    ('the shapes the cancellation tests use', '{"cancellation_rules":[{"within_hours":48,"charge":{"type":"nights","value":1}},{"within_hours":0,"charge":{"type":"percent","value":100}}]}', true),
    ('a deposit and a hold length', '{"online_payment":{"mode":"deposit_percent","value":30},"hold_minutes":25}', true),
    ('pay in full online', '{"online_payment":{"mode":"full"}}', true),
    ('a fixed charge in kobo, payment before check-in, a check-in time, and a key nobody reads yet', '{"cancellation_rules":[{"within_hours":24,"charge":{"type":"fixed","value":500000}}],"checkin_payment":"full","check_in_time":"14:00","something_else":{"x":1}}', true),
    ('eight rules', (select jsonb_build_object('cancellation_rules', jsonb_agg(jsonb_build_object('within_hours', h, 'charge', jsonb_build_object('type','percent','value',10))))::text from generate_series(1, 8) h), true),
    ('nine rules', (select jsonb_build_object('cancellation_rules', jsonb_agg(jsonb_build_object('within_hours', h, 'charge', jsonb_build_object('type','percent','value',10))))::text from generate_series(1, 9) h), false),
    ('not an object', '[]', false),
    ('hold too short', '{"hold_minutes":4}', false),
    ('hold too long', '{"hold_minutes":121}', false),
    ('hold not whole', '{"hold_minutes":20.5}', false),
    ('hold as text', '{"hold_minutes":"20"}', false),
    ('rules not a list', '{"cancellation_rules":{"within_hours":1}}', false),
    ('two rules for the same window', '{"cancellation_rules":[{"within_hours":24,"charge":{"type":"percent","value":10}},{"within_hours":24,"charge":{"type":"percent","value":20}}]}', false),
    ('negative window', '{"cancellation_rules":[{"within_hours":-1,"charge":{"type":"percent","value":10}}]}', false),
    ('window as text', '{"cancellation_rules":[{"within_hours":"24","charge":{"type":"percent","value":10}}]}', false),
    ('percent over 100', '{"cancellation_rules":[{"within_hours":24,"charge":{"type":"percent","value":101}}]}', false),
    ('percent of nothing', '{"cancellation_rules":[{"within_hours":24,"charge":{"type":"percent","value":0}}]}', false),
    ('half a night', '{"cancellation_rules":[{"within_hours":24,"charge":{"type":"nights","value":1.5}}]}', false),
    ('more than thirty nights', '{"cancellation_rules":[{"within_hours":24,"charge":{"type":"nights","value":31}}]}', false),
    ('a fixed charge with a fraction of a kobo', '{"cancellation_rules":[{"within_hours":24,"charge":{"type":"fixed","value":10.5}}]}', false),
    ('an unknown charge type', '{"cancellation_rules":[{"within_hours":24,"charge":{"type":"free","value":1}}]}', false),
    ('no charge', '{"cancellation_rules":[{"within_hours":24}]}', false),
    ('an unknown payment mode', '{"online_payment":{"mode":"half"}}', false),
    ('a deposit with no amount', '{"online_payment":{"mode":"deposit_percent"}}', false),
    ('a deposit over 100', '{"online_payment":{"mode":"deposit_percent","value":150}}', false),
    ('payment before check-in set to something else', '{"checkin_payment":"half"}', false),
    ('a check-in time that is not a time', '{"check_in_time":"teatime"}', false)
  ) as t(label, config, expected) loop
    if policy_config_valid(c.config::jsonb) is distinct from c.expected then
      raise exception 'FAIL policy_config_valid(%) expected % for: %', c.label, c.expected, c.config;
    end if;
  end loop;
  if policy_config_valid(null) then raise exception 'FAIL null is not a policy'; end if;
  raise notice 'PASS the validity check accepts what the functions read and refuses what would break them';
end $$;

-- 2. A bad policy is refused however it is written, even by an owner inserting straight into the table
do $$ declare n0 integer; begin
  select count(*) into n0 from property_policies where property_id = '00000000-0000-0000-0000-0000000000b2';
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  begin
    insert into property_policies (tenant_id, property_id, version, effective_from, config)
    values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2', 9999, date '2099-01-01',
            '{"cancellation_rules":[{"within_hours":"soon","charge":{"type":"percent","value":10}}]}');
    raise exception 'FAIL a malformed cancellation rule was accepted';
  exception when check_violation then null;
  end;
  perform t_sys();
  if (select count(*) from property_policies where property_id = '00000000-0000-0000-0000-0000000000b2') <> n0 then
    raise exception 'FAIL a refused policy left a row';
  end if;
  raise notice 'PASS a malformed policy is refused at the table';
end $$;
