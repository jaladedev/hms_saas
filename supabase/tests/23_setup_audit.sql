-- Audit of hotel setup changes (migration 024): room types, rooms, rate plans and nightly prices.
-- Reuses t_as / t_sys (05). Users: aa01 owner A (property.configure, rate.manage), aa04 front desk (neither).
-- Uses its own room type, room and dates, so no other test is involved. Each block is its own transaction.
\set ON_ERROR_STOP on

create table t23_ctx (k text primary key, id uuid);

-- 1. A room type is created: who, and what values (setup columns only)
do $$ declare v_type uuid; a audit_logs%rowtype; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  insert into room_types (tenant_id, property_id, name, code, slug, max_adults, max_children, max_occupancy, base_rate_minor, is_public)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'Audit Suite', 'T23', 'audit-suite', 2, 0, 2, 100000, true)
  returning id into v_type;
  perform t_sys();
  insert into t23_ctx values ('type', v_type);
  select * into a from audit_logs where action = 'room_type.created' and entity_id = v_type;
  if a.id is null or a.actor_user_id is distinct from '00000000-0000-0000-0000-00000000aa01'
     or a.property_id <> '00000000-0000-0000-0000-0000000000a2' or a.entity_type <> 'room_type'
     or a.metadata #>> '{values,name}' <> 'Audit Suite' or (a.metadata #>> '{values,base_rate_minor}')::bigint <> 100000
     or (a.metadata -> 'values') ? 'updated_at' or (a.metadata -> 'values') ? 'created_at' then
    raise exception 'FAIL room type created audit %', a;
  end if;
  raise notice 'PASS creating a room type records who did it and its setup values';
end $$;

-- 2. An edit records only what changed, with the old and new value
do $$ declare v_type uuid; a audit_logs%rowtype; keys text[]; begin
  select id into v_type from t23_ctx where k = 'type';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  update room_types set name = 'Audit Suite Plus', base_rate_minor = 120000 where id = v_type;
  perform t_sys();
  select * into a from audit_logs where action = 'room_type.updated' and entity_id = v_type;
  select array_agg(key order by key) into keys from jsonb_object_keys(a.metadata -> 'changed') key;
  if keys <> array['base_rate_minor', 'name'] or a.actor_user_id is distinct from '00000000-0000-0000-0000-00000000aa01'
     or (a.metadata #>> '{changed,base_rate_minor,from}')::bigint <> 100000 or (a.metadata #>> '{changed,base_rate_minor,to}')::bigint <> 120000
     or a.metadata #>> '{changed,name,from}' <> 'Audit Suite' or a.metadata #>> '{changed,name,to}' <> 'Audit Suite Plus' then
    raise exception 'FAIL room type updated audit % %', keys, a;
  end if;
  raise notice 'PASS an edit records only the changed columns, old and new';
end $$;

-- 3. Saving without changing anything writes nothing; switching off is recorded
do $$ declare v_type uuid; n integer; a audit_logs%rowtype; begin
  select id into v_type from t23_ctx where k = 'type';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  update room_types set name = name where id = v_type;
  perform t_sys();
  select count(*) into n from audit_logs where action = 'room_type.updated' and entity_id = v_type;
  if n <> 1 then raise exception 'FAIL a no-op save wrote an audit row (%)', n; end if;

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  update room_types set status = 'inactive' where id = v_type;
  perform t_sys();
  select * into a from audit_logs where action = 'room_type.updated' and entity_id = v_type and (metadata -> 'changed') ? 'status';
  if a.id is null or a.metadata #>> '{changed,status,from}' <> 'active' or a.metadata #>> '{changed,status,to}' <> 'inactive' then
    raise exception 'FAIL switch-off audit %', a;
  end if;
  raise notice 'PASS a no-op save writes nothing and switching a type off is recorded';
end $$;

-- 4. Rooms: setup columns are audited, housekeeping status is not (it has its own audit)
do $$ declare v_type uuid; v_room uuid; n integer; a audit_logs%rowtype; begin
  select id into v_type from t23_ctx where k = 'type';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  insert into rooms (tenant_id, property_id, room_type_id, room_number, floor)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', v_type, 'T23-1', 2) returning id into v_room;
  update rooms set operational_status = 'out_of_service', floor = 3 where id = v_room;
  update rooms set housekeeping_status = 'dirty' where id = v_room;
  perform t_sys();
  insert into t23_ctx values ('room', v_room);

  select * into a from audit_logs where action = 'room.created' and entity_id = v_room;
  if a.id is null or a.metadata #>> '{values,room_number}' <> 'T23-1' or (a.metadata -> 'values') ? 'housekeeping_status' then raise exception 'FAIL room created audit %', a; end if;

  select count(*) into n from audit_logs where action = 'room.updated' and entity_id = v_room;
  select * into a from audit_logs where action = 'room.updated' and entity_id = v_room;
  if n <> 1 or a.metadata #>> '{changed,operational_status,to}' <> 'out_of_service' or (a.metadata #>> '{changed,floor,from}')::int <> 2
     or (a.metadata #>> '{changed,floor,to}')::int <> 3 or (a.metadata -> 'changed') ? 'housekeeping_status' then
    raise exception 'FAIL room updated audit (% rows) %', n, a;
  end if;
  raise notice 'PASS rooms: setup changes are audited, housekeeping status changes are not duplicated';
end $$;

-- 5. Rate plans
do $$ declare v_plan uuid; a audit_logs%rowtype; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  insert into rate_plans (tenant_id, property_id, name, code, is_default)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'Audit plan', 'T23', false) returning id into v_plan;
  update rate_plans set status = 'inactive' where id = v_plan;
  perform t_sys();
  select * into a from audit_logs where action = 'rate_plan.created' and entity_id = v_plan;
  if a.id is null or a.actor_user_id is distinct from '00000000-0000-0000-0000-00000000aa01' or a.metadata #>> '{values,code}' <> 'T23' then raise exception 'FAIL rate plan created audit %', a; end if;
  select * into a from audit_logs where action = 'rate_plan.updated' and entity_id = v_plan;
  if a.id is null or a.metadata #>> '{changed,status,to}' <> 'inactive' then raise exception 'FAIL rate plan updated audit %', a; end if;
  raise notice 'PASS rate plans: created and changed are audited';
end $$;

-- 6. Nightly prices: one summary row per statement, against the room type
do $$ declare v_type uuid; v_plan uuid; a audit_logs%rowtype; n integer; begin
  select id into v_type from t23_ctx where k = 'type';
  select id into v_plan from rate_plans where property_id = '00000000-0000-0000-0000-0000000000a2' and is_default;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  insert into daily_rates (tenant_id, property_id, room_type_id, rate_plan_id, business_date, amount_minor)
  select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', v_type, v_plan, current_date + g, 50000 from generate_series(30, 34) g
  on conflict (property_id, room_type_id, rate_plan_id, business_date) do update set amount_minor = excluded.amount_minor;
  perform t_sys();
  select count(*) into n from audit_logs where action = 'rates.set' and entity_id = v_type;
  select * into a from audit_logs where action = 'rates.set' and entity_id = v_type;
  if n <> 1 or (a.metadata ->> 'nights')::int <> 5 or (a.metadata ->> 'amount_minor_min')::bigint <> 50000 or (a.metadata ->> 'amount_minor_max')::bigint <> 50000
     or (a.metadata ->> 'from')::date <> current_date + 30 or (a.metadata ->> 'to')::date <> current_date + 34
     or a.actor_user_id is distinct from '00000000-0000-0000-0000-00000000aa01' or a.entity_type <> 'room_type' then
    raise exception 'FAIL rates.set audit (% rows) %', n, a;
  end if;

  -- the same five nights at a new price: one rates.changed with old and new, no extra rates.set
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  insert into daily_rates (tenant_id, property_id, room_type_id, rate_plan_id, business_date, amount_minor)
  select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', v_type, v_plan, current_date + g, 60000 from generate_series(30, 34) g
  on conflict (property_id, room_type_id, rate_plan_id, business_date) do update set amount_minor = excluded.amount_minor;
  perform t_sys();
  select * into a from audit_logs where action = 'rates.changed' and entity_id = v_type;
  if (select count(*) from audit_logs where action = 'rates.changed' and entity_id = v_type) <> 1
     or (select count(*) from audit_logs where action = 'rates.set' and entity_id = v_type) <> 1
     or (a.metadata ->> 'nights')::int <> 5 or (a.metadata ->> 'old_amount_minor_min')::bigint <> 50000 or (a.metadata ->> 'new_amount_minor_max')::bigint <> 60000 then
    raise exception 'FAIL rates.changed audit %', a;
  end if;

  -- seven nights, five of them already at 60000 and two new: only the two new nights are recorded, as rates.set
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  insert into daily_rates (tenant_id, property_id, room_type_id, rate_plan_id, business_date, amount_minor)
  select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', v_type, v_plan, current_date + g, 60000 from generate_series(30, 36) g
  on conflict (property_id, room_type_id, rate_plan_id, business_date) do update set amount_minor = excluded.amount_minor;
  perform t_sys();
  if (select count(*) from audit_logs where action = 'rates.set' and entity_id = v_type) <> 2
     or (select count(*) from audit_logs where action = 'rates.set' and entity_id = v_type and (metadata ->> 'nights')::int = 2) <> 1
     or (select count(*) from audit_logs where action = 'rates.changed' and entity_id = v_type) <> 1 then
    raise exception 'FAIL re-saving unchanged nights was recorded';
  end if;

  -- clearing two nights
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  delete from daily_rates where room_type_id = v_type and business_date >= current_date + 35;
  perform t_sys();
  select * into a from audit_logs where action = 'rates.cleared' and entity_id = v_type;
  if (select count(*) from audit_logs where action = 'rates.cleared' and entity_id = v_type) <> 1
     or (a.metadata ->> 'nights')::int <> 2 or (a.metadata ->> 'old_amount_minor_max')::bigint <> 60000 then raise exception 'FAIL rates.cleared audit %', a; end if;
  raise notice 'PASS nightly prices: one summary per statement for set, changed and cleared; unchanged nights write nothing';
end $$;

-- 7. A person without the permission, or from another hotel, changes nothing and leaves no audit row
do $$ declare v_type uuid; before_n integer; after_n integer; v_denied boolean := false; begin
  select id into v_type from t23_ctx where k = 'type';
  select count(*) into before_n from audit_logs;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  begin
    insert into room_types (tenant_id, property_id, name, code, slug, max_adults, max_occupancy, base_rate_minor)
    values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'Denied Type', 'DNY', 'denied-type', 1, 1, 1000);
  exception when insufficient_privilege then v_denied := true; end;
  update room_types set base_rate_minor = 1 where id = v_type;
  update daily_rates set amount_minor = 1 where room_type_id = v_type;
  delete from daily_rates where room_type_id = v_type;
  -- the owner of another hotel cannot touch these prices either: the policy hides the rows
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  delete from daily_rates where room_type_id = v_type;
  update daily_rates set amount_minor = 1 where room_type_id = v_type;
  perform t_sys();
  if (select count(*) from daily_rates where room_type_id = v_type) <> 5 or (select min(amount_minor) from daily_rates where room_type_id = v_type) <> 60000 then
    raise exception 'FAIL another hotel changed these prices';
  end if;
  select count(*) into after_n from audit_logs;
  if not v_denied or before_n <> after_n then raise exception 'FAIL denied writes left audit rows (denied %, % -> %)', v_denied, before_n, after_n; end if;
  if (select base_rate_minor from room_types where id = v_type) <> 120000 then raise exception 'FAIL front desk changed a price'; end if;
  raise notice 'PASS people without permission, or from another hotel, change nothing and leave no audit row';
end $$;

-- 8. Service-role and script changes are audited too, with no actor
do $$ declare v_type uuid; a audit_logs%rowtype; begin
  select id into v_type from t23_ctx where k = 'type';
  perform t_sys();
  update room_types set max_children = 1 where id = v_type;
  select * into a from audit_logs where action = 'room_type.updated' and entity_id = v_type and (metadata -> 'changed') ? 'max_children';
  if a.id is null or a.actor_user_id is not null then raise exception 'FAIL system change audit %', a; end if;
  raise notice 'PASS changes made by the service role are audited with no actor';
end $$;

-- 9. The trigger functions are not callable by anyone
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ begin
  begin perform audit_setup_row(); raise exception 'FAIL authenticated can call audit_setup_row'; exception when insufficient_privilege then null; end;
  begin perform audit_daily_rates_inserted(); raise exception 'FAIL authenticated can call audit_daily_rates_inserted'; exception when insufficient_privilege then null; end;
end $$;
rollback;
do $$ begin raise notice 'PASS the audit trigger functions are closed to callers'; end $$;
