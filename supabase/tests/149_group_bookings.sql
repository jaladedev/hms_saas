-- Group bookings, step one (migration 149): groups, room blocks with a release date, rooming list. Hotel A: tenant a1, property a2, Standard a3 (5 rooms),
-- Deluxe a4 (1 room). Owner aa01, front desk aa04, other hotel's owner bb01. Dates sit far out so the hotel's own "today" cannot matter.
\set ON_ERROR_STOP on

create function t149_group(p_name text, p_std integer, p_dlx integer default 0, p_arr integer default 400, p_nights integer default 3, p_rel integer default 390, p_key text default null)
returns jsonb language sql as $$
  select create_group('00000000-0000-0000-0000-0000000000a2', p_name, 'Acme Ltd', 'Ada Obi', '08012345678', 'ada@example.com',
    current_date + p_arr, current_date + p_arr + p_nights, current_date + p_rel, 'Team retreat',
    (select jsonb_agg(x) from (select jsonb_build_object('room_type_id', '00000000-0000-0000-0000-0000000000a3', 'quantity', p_std) x where p_std > 0
       union all select jsonb_build_object('room_type_id', '00000000-0000-0000-0000-0000000000a4', 'quantity', p_dlx) where p_dlx > 0) s),
    coalesce(p_key, 'g-' || p_name));
$$;
create function t149_held(p_group uuid) returns integer language sql as $$
  select count(*)::integer from group_block_units u join room_inventory_claims c on c.id = u.claim_id where u.group_id = p_group and u.status = 'held' and c.status = 'active';
$$;

-- 1. who may write and read, and what is accepted
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb; g uuid; d jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect('select t149_group(''Nope'', 1)', 'NOT_FOUND');
  perform t_expect(format('select group_list(%L)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect('select t149_group(''Nope'', 1)', 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect('select t149_group('''', 1)', 'POLICY_VIOLATION: details');
  perform t_expect('select t149_group(''Late'', 1, 0, 400, 3, 401)', 'POLICY_VIOLATION: dates');     -- release after arrival
  perform t_expect('select t149_group(''Long'', 1, 0, 400, 61)', 'POLICY_VIOLATION: dates');
  perform t_expect('select t149_group(''Past'', 1, 0, -5, 3, -6)', 'POLICY_VIOLATION: dates');
  perform t_expect('select t149_group(''Zero'', 0)', 'POLICY_VIOLATION: rooms');
  perform t_expect('select t149_group(''Many'', 51)', 'POLICY_VIOLATION: rooms');
  r := t149_group('Wedding', 3, 1);
  g := (r ->> 'group_id')::uuid;
  if (r ->> 'rooms_held')::int <> 4 or t149_held(g) <> 4 then raise exception 'FAIL held %', r; end if;
  if t149_group('Wedding', 3, 1) <> r then raise exception 'FAIL idempotent replay'; end if;
  if (select count(*) from group_bookings where name = 'Wedding') <> 1 then raise exception 'FAIL duplicate group'; end if;
  d := group_detail(g);
  if jsonb_array_length(d -> 'rooms') <> 2 or d ->> 'status' <> 'open' then raise exception 'FAIL detail %', d; end if;
  if jsonb_array_length(group_list(v_p)) <> 1 then raise exception 'FAIL list'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select group_detail(%L)', g), 'NOT_FOUND');
  perform t_expect(format('select cancel_group(%L)', g), 'NOT_FOUND');
  raise notice 'PASS groups: permission, validation, hold, idempotent replay';
end $$;

-- 2. the block really holds the rooms, all or nothing
do $$ declare v_g uuid; v_n integer; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  select id into v_g from group_bookings where name = 'Wedding';
  -- other tests add rooms, so ask for the most a group may hold (50 Standard): more than the hotel has, refused, nothing may stay held
  perform t_expect('select t149_group(''Too big'', 50)', 'POLICY_VIOLATION: ROOMS_UNAVAILABLE');
  perform t_expect('select t149_group(''Dlx twice'', 1, 1)', 'POLICY_VIOLATION: ROOMS_UNAVAILABLE');   -- Deluxe is already held; the Standard hold must roll back too
  perform t_sys();
  if exists (select 1 from group_bookings where name in ('Too big', 'Dlx twice')) then raise exception 'FAIL refused group left a row'; end if;
  if (select count(*) from group_block_units) <> 4 or (select count(*) from room_inventory_claims c join group_block_units u on u.claim_id = c.id where c.status = 'active') <> 4 then raise exception 'FAIL claims after refusal'; end if;
end $$;

-- 3. rooming list
do $$ declare v_g uuid; e jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  select id into v_g from group_bookings where name = 'Wedding';
  e := add_rooming_entry(v_g, '  Chidi Eze ', '00000000-0000-0000-0000-0000000000a3', 'late arrival');
  perform add_rooming_entry(v_g, 'Bola Ade', null, null);
  perform t_expect(format('select add_rooming_entry(%L, '''', null, null)', v_g), 'POLICY_VIOLATION: details');
  perform t_expect(format('select add_rooming_entry(%L, ''X'', ''00000000-0000-0000-0000-0000000000b3'', null)', v_g), 'POLICY_VIOLATION: room type');
  if jsonb_array_length(group_detail(v_g) -> 'rooming') <> 2 or group_detail(v_g) -> 'rooming' -> 0 ->> 'guest_name' <> 'Chidi Eze' then raise exception 'FAIL rooming %', group_detail(v_g); end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select remove_rooming_entry(%L)', (e ->> 'entry_id')::uuid), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform remove_rooming_entry((e ->> 'entry_id')::uuid);
  if jsonb_array_length(group_detail(v_g) -> 'rooming') <> 1 then raise exception 'FAIL rooming remove'; end if;
  raise notice 'PASS groups: block is all or nothing, rooming list add and remove';
end $$;

-- 4. use a held room, update, cancel
do $$ declare v_g uuid; r jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  select id into v_g from group_bookings where name = 'Wedding';
  r := use_group_unit(v_g, '00000000-0000-0000-0000-0000000000a3');
  if (r ->> 'held_left')::int <> 2 or t149_held(v_g) <> 3 then raise exception 'FAIL use unit %', r; end if;
  perform use_group_unit(v_g, '00000000-0000-0000-0000-0000000000a4');
  perform t_expect(format('select use_group_unit(%L, ''00000000-0000-0000-0000-0000000000a4'')', v_g), 'POLICY_VIOLATION: no held room');
  perform t_expect(format('select update_group(%L, null, '''', null, null, current_date + 390, null)', v_g), 'POLICY_VIOLATION: details');
  perform t_expect(format('select update_group(%L, null, ''Ada'', null, null, current_date + 401, null)', v_g), 'POLICY_VIOLATION: dates');
  perform update_group(v_g, 'New Co', 'Ada Obi', null, null, current_date + 395, 'moved');
  if (select release_date from group_bookings where id = v_g) <> current_date + 395 then raise exception 'FAIL update'; end if;
  r := cancel_group(v_g);
  if (r ->> 'rooms_freed')::int <> 2 or t149_held(v_g) <> 0 then raise exception 'FAIL cancel %', r; end if;
  perform t_expect(format('select cancel_group(%L)', v_g), 'INVALID_STATE');
  perform t_expect(format('select add_rooming_entry(%L, ''Z'', null, null)', v_g), 'INVALID_STATE');
  -- the rooms are free again for the same dates
  perform t149_group('Again', 5, 1);
  if (select count(*) from audit_logs where entity_id = v_g and action like 'group.%') < 5 then raise exception 'FAIL audit rows'; end if;
  raise notice 'PASS groups: use a held room, update, cancel frees the rooms, audited';
end $$;

-- 5. the release date, the flag, and who may call the system function
do $$ declare v_g uuid; v_n integer; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  select id into v_g from group_bookings where name = 'Again';
  begin perform release_due_group_blocks(); raise exception 'FAIL staff ran the system function';
  exception when insufficient_privilege then null; end;
end $$;
do $$ declare v_g uuid; v_n integer; begin
  perform t_sys();
  select id into v_g from group_bookings where name = 'Again';
  v_n := release_due_group_blocks();
  if v_n <> 0 or t149_held(v_g) <> 6 then raise exception 'FAIL released early %', v_n; end if;
  update group_bookings set release_date = current_date - 3, arrival_date = current_date - 3, departure_date = current_date + 1 where id = v_g;
  v_n := release_due_group_blocks();
  if v_n <> 1 or t149_held(v_g) <> 0 or (select status from group_bookings where id = v_g) <> 'released' then raise exception 'FAIL release %', v_n; end if;
  if release_due_group_blocks() <> 0 then raise exception 'FAIL release repeat'; end if;
  if (select count(*) from audit_logs where entity_id = v_g and action = 'group.released') <> 1 then raise exception 'FAIL release audit'; end if;
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values ('00000000-0000-0000-0000-0000000000a1', 'group_bookings', false);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect('select t149_group(''Off'', 1)', 'POLICY_VIOLATION: group bookings off');
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = '00000000-0000-0000-0000-0000000000a1' and feature_key = 'group_bookings';
  if not ('group_bookings' = any (plan_enforced_flags())) then raise exception 'FAIL flag not in the enforced list'; end if;
  raise notice 'PASS groups: release date frees the rooms once, flag off blocks writes';
end $$;
