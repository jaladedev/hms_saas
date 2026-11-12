-- Hotel places (migration 119). Reuses t_as / t_sys / t_expect (05). Hosts from 06: book.hotel-a.test, hotel-b.test.
-- Users: aa01 owner, aa04 front desk, bb01 owner of Hotel B.
\set ON_ERROR_STOP on

do $$ declare
  v_a constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_b constant uuid := '00000000-0000-0000-0000-0000000000b2';
  r jsonb; v_id uuid; v_n integer;
begin
  perform t_sys();
  delete from hotel_places where property_id in (v_a, v_b);

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select save_hotel_place(%L, null, ''Mapo Hall'', '''', true)', v_a), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select save_hotel_place(%L, null, ''Mapo Hall'', '''', true)', v_a), 'NOT_FOUND');

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select save_hotel_place(%L, null, ''   '', '''', true)', v_a), 'POLICY_VIOLATION: name');
  perform t_expect(format('select save_hotel_place(%L, null, %L, '''', true)', v_a, repeat('x', 61)), 'POLICY_VIOLATION: name');
  perform t_expect(format('select save_hotel_place(%L, null, ''A'', %L, true)', v_a, repeat('x', 141)), 'POLICY_VIOLATION: text');

  r := save_hotel_place(v_a, null, '  Mapo Hall ', ' Colonial hall with views ', true, 2);
  v_id := (r ->> 'place_id')::uuid;
  perform t_sys();
  if (select name || '|' || body from hotel_places where id = v_id) <> 'Mapo Hall|Colonial hall with views' then raise exception 'FAIL not trimmed'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform save_hotel_place(v_a, v_id, 'Mapo Hall', 'Updated', true, 2);
  perform save_hotel_place(v_a, null, 'Agodi Gardens', 'Gardens and lake', true, 1);
  perform save_hotel_place(v_a, null, 'Hidden', 'Not shown', false, 0);
  perform t_sys();
  if (select count(*) from audit_logs where action = 'hotel_place.saved' and entity_id = v_id) <> 2 then raise exception 'FAIL audit'; end if;

  -- another hotel cannot touch it
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select save_hotel_place(%L, %L, ''X'', '''', true)', v_b, v_id), 'NOT_FOUND');
  perform t_expect(format('select delete_hotel_place(%L)', v_id), 'NOT_FOUND');

  -- the homepage list: switched on only, in order, nothing internal
  perform t_sys();
  set local role service_role;
  r := guest_places('book.hotel-a.test');
  reset role;
  if jsonb_array_length(r -> 'places') <> 2 then raise exception 'FAIL expected 2 shown %', r; end if;
  if r -> 'places' -> 0 ->> 'name' <> 'Agodi Gardens' or r -> 'places' -> 1 ->> 'name' <> 'Mapo Hall' then raise exception 'FAIL order %', r; end if;
  if r::text ~* 'Hidden|property|tenant|"id"' then raise exception 'FAIL leaked %', r; end if;
  set local role service_role;
  if jsonb_array_length(guest_places('hotel-b.test') -> 'places') <> 0 then raise exception 'FAIL hotel B shows hotel A places'; end if;
  reset role;

  -- limit of 8
  perform t_sys();
  delete from hotel_places where property_id = v_a;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  for v_n in 1..8 loop perform save_hotel_place(v_a, null, 'P' || v_n, '', true, v_n); end loop;
  perform t_expect(format('select save_hotel_place(%L, null, ''One too many'', '''', true)', v_a), 'POLICY_VIOLATION: limit');

  -- delete, audited
  perform t_sys();
  select id into v_id from hotel_places where property_id = v_a limit 1;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform delete_hotel_place(v_id);
  perform t_sys();
  if exists (select 1 from hotel_places where id = v_id) or not exists (select 1 from audit_logs where action = 'hotel_place.deleted' and entity_id = v_id) then raise exception 'FAIL delete'; end if;
  delete from hotel_places where property_id in (v_a, v_b);
  raise notice 'PASS hotel places: permissions, validation, trimmed, ordered, hidden ones not shown, limit of 8, audited';
end $$;
