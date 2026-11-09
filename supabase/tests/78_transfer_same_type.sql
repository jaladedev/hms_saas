-- Room transfers stay within the booking's room type (migration 078). Reuses t_book, t_rr, t_expect (05) and t_as / t_sys.
-- Dates are 500+ days out, clear of the windows the other tests use. 'aa04' is the front-desk login the transfer tests use.
\set ON_ERROR_STOP on

-- 1. An explicit room of another type is refused, and nothing moves
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2');
  rr uuid; solo uuid; v_before jsonb;
begin
  select id into solo from rooms where property_id = '00000000-0000-0000-0000-0000000000a2' and room_type_id = '00000000-0000-0000-0000-0000000000a4' order by room_number limit 1;
  rr := t_rr(t_book('00000000-0000-0000-0000-0000000000a3', t + 500, t + 503, 'tst-78-0001'));
  select jsonb_agg(jsonb_build_array(room_id, start_date, end_date, status) order by id) into v_before from room_inventory_claims where reservation_room_id = rr;

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select transfer_room(%L, %L, %L, %L, %L)', rr, solo, t + 501, 'try an upgrade', 'tst-78-k1'), 'POLICY_VIOLATION');
  perform t_expect(format('select transfer_room(%L, %L, %L, %L, %L)', rr, solo, t + 500, 'from the first night', 'tst-78-k2'), 'POLICY_VIOLATION');
  perform t_sys();

  if (select jsonb_agg(jsonb_build_array(room_id, start_date, end_date, status) order by id) from room_inventory_claims where reservation_room_id = rr) is distinct from v_before
    then raise exception 'FAIL a refused cross-type transfer changed the claims'; end if;
  if exists (select 1 from room_inventory_claims where room_id = solo and status = 'active' and start_date < t + 503 and end_date > t + 500)
    then raise exception 'FAIL the other type''s room was taken'; end if;
  if (select count(*) from audit_logs where action = 'room.transferred' and entity_id = (select reservation_id from reservation_rooms where id = rr)) <> 0
    then raise exception 'FAIL a refused transfer was audited as done'; end if;
  raise notice 'PASS a transfer to a room of another type is refused from any date and changes nothing';
end $$;

-- 2. A room of the same type still works, named or by search, and a room outside the property is still refused as before
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2');
  rr uuid; cur uuid; other uuid; r jsonb;
begin
  rr := t_rr(t_book('00000000-0000-0000-0000-0000000000a3', t + 520, t + 524, 'tst-78-0002'));
  select room_id into cur from room_inventory_claims where reservation_room_id = rr and status = 'active';
  select id into other from rooms where property_id = '00000000-0000-0000-0000-0000000000a2' and room_type_id = '00000000-0000-0000-0000-0000000000a3' and id <> cur order by room_number limit 1;

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := transfer_room(rr, other, t + 522, 'quieter room', 'tst-78-k3');
  if r ->> 'to_room_id' <> other::text then raise exception 'FAIL same-type transfer %', r; end if;
  r := transfer_room(rr, null, t + 523, 'room fault', 'tst-78-k4');
  if (select room_type_id from rooms where id = (r ->> 'to_room_id')::uuid) <> '00000000-0000-0000-0000-0000000000a3'
    then raise exception 'FAIL a search left the booking''s type %', r; end if;
  perform t_expect(format('select transfer_room(%L, %L, %L, %L, %L)', rr, gen_random_uuid(), t + 523, 'nowhere', 'tst-78-k5'), 'POLICY_VIOLATION');
  perform t_sys();
  raise notice 'PASS a named room of the same type and a search both still work, and an unknown room is still refused';
end $$;
