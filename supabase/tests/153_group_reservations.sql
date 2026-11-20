-- Group bookings, step two (migration 153): rooming names linked to real bookings, and the group statement. Hotel A as in test 149.
\set ON_ERROR_STOP on

create function t150_ref(p_arr integer, p_dep integer, p_key text) returns text language plpgsql as $$
declare r jsonb := t_book('00000000-0000-0000-0000-0000000000a3', current_date + p_arr, current_date + p_dep, p_key); v text;
begin
  select booking_reference into v from reservations where id = (r ->> 'reservation_id')::uuid;
  return v;
end $$;

do $$ declare v_g uuid; e1 jsonb; e2 jsonb; v_ref text; v_ref2 text; v_out text; s jsonb; v_res uuid; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_g := (t149_group('Link Group', 3, 0, 500, 4, 490)::jsonb ->> 'group_id')::uuid;
  e1 := add_rooming_entry(v_g, 'Chidi Eze', null, null);
  e2 := add_rooming_entry(v_g, 'Bola Ade', null, null);
  v_ref := t150_ref(500, 502, 'g150-a');
  v_ref2 := t150_ref(501, 503, 'g150-b');
  v_out := t150_ref(520, 522, 'g150-out');

  -- who may link
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select link_rooming_reservation(%L, %L)', (e1 ->> 'entry_id')::uuid, v_ref), 'NOT_FOUND');
  perform t_expect(format('select group_statement(%L)', v_g), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select link_rooming_reservation(%L, %L)', (e1 ->> 'entry_id')::uuid, v_ref), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');

  -- what is accepted
  perform t_expect(format('select link_rooming_reservation(%L, ''NOPE-0000'')', (e1 ->> 'entry_id')::uuid), 'POLICY_VIOLATION: booking not found');
  perform t_expect(format('select link_rooming_reservation(%L, %L)', (e1 ->> 'entry_id')::uuid, v_out), 'POLICY_VIOLATION: booking dates');
  perform link_rooming_reservation((e1 ->> 'entry_id')::uuid, '  ' || lower(v_ref) || ' ');
  perform t_expect(format('select link_rooming_reservation(%L, %L)', (e2 ->> 'entry_id')::uuid, v_ref), 'POLICY_VIOLATION: already linked');
  perform link_rooming_reservation((e2 ->> 'entry_id')::uuid, v_ref2);
  if (select count(*) from jsonb_array_elements(group_detail(v_g) -> 'rooming') x where x ->> 'booking_reference' is not null) <> 2 then raise exception 'FAIL detail links'; end if;

  -- the statement reads the bookings and adds only the live ones
  s := group_statement(v_g);
  if s ->> 'money_visible' <> 'true' or (s ->> 'linked_count')::int <> 2 or (s ->> 'names_without_booking')::int <> 0 then raise exception 'FAIL statement %', s; end if;
  if (s ->> 'total_minor')::bigint <> (select sum(total_minor) from reservations where booking_reference in (v_ref, v_ref2)) or (s ->> 'total_minor')::bigint <= 0 then raise exception 'FAIL statement total %', s; end if;
  perform t_sys();
  update reservations set reservation_status = 'cancelled' where booking_reference = v_ref2;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  s := group_statement(v_g);
  if (s ->> 'total_minor')::bigint <> (select total_minor from reservations where booking_reference = v_ref) or (s ->> 'linked_count')::int <> 2 then raise exception 'FAIL cancelled booking counted %', s; end if;

  -- money hidden from a manager who may not see money
  perform t_sys();
  insert into role_permissions (role_id, permission_id) select r.id, p.id from roles r, permissions p where r.key = 'housekeeping' and p.key = 'group.manage';
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  s := group_statement(v_g);
  if s ->> 'money_visible' <> 'false' or s -> 'bookings' -> 0 ->> 'total_minor' is not null or s ->> 'total_minor' is not null or (s ->> 'linked_count')::int <> 2 then raise exception 'FAIL money shown %', s; end if;
  perform t_sys();
  delete from role_permissions where role_id = (select id from roles where key = 'housekeeping') and permission_id = (select id from permissions where key = 'group.manage');

  -- unlink, then remove a name whose booking is linked
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform unlink_rooming_reservation((e1 ->> 'entry_id')::uuid);
  perform unlink_rooming_reservation((e1 ->> 'entry_id')::uuid);
  if (group_statement(v_g) ->> 'names_without_booking')::int <> 1 then raise exception 'FAIL unlink'; end if;
  perform remove_rooming_entry((e2 ->> 'entry_id')::uuid);
  if not exists (select 1 from reservations where booking_reference = v_ref2) then raise exception 'FAIL booking removed with the name'; end if;
  if (select count(*) from audit_logs where entity_id = v_g and action in ('group.booking_linked', 'group.booking_unlinked')) <> 3 then raise exception 'FAIL audit rows'; end if;
  perform cancel_group(v_g);
  perform t_expect(format('select link_rooming_reservation(%L, %L)', (e1 ->> 'entry_id')::uuid, v_ref), 'INVALID_STATE');
  raise notice 'PASS group bookings step two: link, unlink, statement adds live bookings, money hidden without money permission, audited';
end $$;
