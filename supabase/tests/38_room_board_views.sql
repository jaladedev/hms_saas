-- Room board views (migration 034). Reuses t_as / t_sys (05) and the users from earlier files:
-- aa01 owner A, aa02 housekeeping A, aa03 owner A but revoked, aa04 front desk A, aa05 accountant A,
-- aa08 maintenance A, bb01 owner of Hotel B. Property A is a2, Hotel B's property is b2 (room 101).
-- Everything here runs in one transaction that is rolled back, so the extra rooms and claims never reach later tests.
\set ON_ERROR_STOP on
begin;

-- A room type with a rate nobody without rate.view should learn, six rooms, and one claim of each kind.
insert into room_types (id, tenant_id, property_id, name, code, slug, max_adults, max_occupancy, base_rate_minor) values
  ('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'Garden Room', 'GRD', 'garden-room', 2, 2, 987654300);
insert into rooms (id, tenant_id, property_id, room_type_id, room_number, floor, operational_status, housekeeping_status) values
  ('00000000-0000-0000-0000-0000000f1001', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000f0001', 'T901', 9, 'active', 'dirty'),
  ('00000000-0000-0000-0000-0000000f1002', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000f0001', 'T902', 9, 'active', 'clean'),
  ('00000000-0000-0000-0000-0000000f1003', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000f0001', 'T903', 9, 'active', 'clean'),
  ('00000000-0000-0000-0000-0000000f1004', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000f0001', 'T904', 9, 'active', 'clean'),
  ('00000000-0000-0000-0000-0000000f1005', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000f0001', 'T905', 9, 'out_of_service', 'clean'),
  ('00000000-0000-0000-0000-0000000f1006', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000f0001', 'T906', 9, 'retired', 'clean');

create temp table t33 (label text primary key, rr uuid);
grant all on t33 to authenticated;
insert into t33 values
  ('in_house', test_rr('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000f0001', current_date - 1, current_date + 2)),
  ('booked',   test_rr('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000f0001', current_date - 1, current_date + 2)),
  ('holder',   test_rr('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000f0001', current_date, current_date + 2)),
  ('left',     test_rr('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000f0001', current_date - 5, current_date - 3));
update reservation_rooms set room_status = 'checked_in'  where id = (select rr from t33 where label = 'in_house');
update reservation_rooms set room_status = 'checked_out' where id = (select rr from t33 where label = 'left');

insert into room_inventory_claims (id, tenant_id, property_id, room_id, claim_type, status, start_date, end_date, reservation_room_id, hold_expires_at, block_reason) values
  ('00000000-0000-0000-0000-0000000f2001', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000f1001', 'stay',  'active',   current_date - 1, current_date + 2, (select rr from t33 where label = 'in_house'), null, null),
  ('00000000-0000-0000-0000-0000000f2002', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000f1002', 'stay',  'active',   current_date - 1, current_date + 2, (select rr from t33 where label = 'booked'), null, null),
  ('00000000-0000-0000-0000-0000000f2003', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000f1003', 'block', 'active',   current_date,     current_date + 3, null, null, 'Leak in the ceiling'),
  ('00000000-0000-0000-0000-0000000f2004', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000f1004', 'hold',  'active',   current_date,     current_date + 2, (select rr from t33 where label = 'holder'), now() + interval '1 hour', null),
  -- a stay whose guest has left, and claims that are no longer live: released, and expired
  ('00000000-0000-0000-0000-0000000f2005', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000f1006', 'stay',  'active',   current_date - 5, current_date - 3, (select rr from t33 where label = 'left'), null, null),
  ('00000000-0000-0000-0000-0000000f2006', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000f1003', 'block', 'released', current_date + 10,  current_date + 12, null, null, 'Old released block'),
  ('00000000-0000-0000-0000-0000000f2007', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000f1004', 'hold',  'expired',  current_date + 10,  current_date + 12, (select rr from t33 where label = 'holder'), now() - interval '1 hour', null),
  -- Hotel B's own block, which nobody at Hotel A may see
  ('00000000-0000-0000-0000-0000000f2008', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b2', (select id from rooms where property_id = '00000000-0000-0000-0000-0000000000b2' limit 1), 'block', 'active', current_date, current_date + 2, null, null, 'Hotel B only');

create function t33_rooms(p_user text) returns text[] language plpgsql as $$
declare v text[];
begin
  perform t_as(p_user);
  select array_agg(room_number order by room_number) into v from room_board_view where room_number like 'T9%';
  perform t_sys();
  return v;
end $$;

-- 1. What housekeeping sees: every room of its own hotel, with the type name and statuses, and none of Hotel B's
do $$ declare r record; n integer; names text[]; begin
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  select count(*), array_agg(distinct room_type_name) into n, names from room_board_view where property_id = '00000000-0000-0000-0000-0000000000a2' and room_number like 'T9%';
  select * into r from room_board_view where room_number = 'T901';
  if n <> 6 then raise exception 'FAIL housekeeping sees % of the 6 rooms', n; end if;
  if names is distinct from array['Garden Room'] then raise exception 'FAIL type names %', names; end if;
  if r.housekeeping_status <> 'dirty' or r.operational_status <> 'active' or r.floor <> 9 or r.property_id <> '00000000-0000-0000-0000-0000000000a2' then raise exception 'FAIL room row %', r; end if;
  if (select count(*) from room_board_view where property_id <> '00000000-0000-0000-0000-0000000000a2') <> 0 then raise exception 'FAIL housekeeping sees another hotel''s rooms'; end if;
  if (select operational_status from room_board_view where room_number = 'T905') <> 'out_of_service' or (select operational_status from room_board_view where room_number = 'T906') <> 'retired' then raise exception 'FAIL service status'; end if;
  perform t_sys();
  raise notice 'PASS housekeeping sees every room of its own hotel with the type name and statuses, and no other hotel''s';
end $$;

-- 2. ...although it still cannot read the tables the view draws on
do $$ declare t integer; rr integer; g integer; begin
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  select count(*) into t from room_types;
  select count(*) into rr from reservation_rooms;
  select count(*) into g from guests;
  perform t_sys();
  if t <> 0 or rr <> 0 or g <> 0 then raise exception 'FAIL premise: housekeeping reads room_types %, reservation_rooms %, guests %', t, rr, g; end if;
  raise notice 'PASS housekeeping still cannot read room types, reservation rooms or guests directly';
end $$;

-- 3. Nothing in either view is a price, a booking or a guest
do $$ declare bad text; begin
  select string_agg(table_name || '.' || column_name, ', ') into bad from information_schema.columns
   where table_schema = 'public' and table_name in ('room_board_view', 'room_board_claims_view')
     and (column_name ~* '(rate|minor|price|amount|tax|total|guest|reference|email|phone|name)' and column_name not in ('room_type_name'));
  if bad is not null then raise exception 'FAIL money, booking or guest columns: %', bad; end if;
  if (select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'room_board_view')
     <> 'id,property_id,room_type_id,room_type_name,room_number,floor,operational_status,housekeeping_status' then raise exception 'FAIL room_board_view columns changed'; end if;
  if (select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'room_board_claims_view')
     <> 'id,property_id,room_id,claim_type,start_date,end_date,reservation_room_id,block_reason,checked_in' then raise exception 'FAIL room_board_claims_view columns changed'; end if;
  raise notice 'PASS the views carry no price, tax, booking reference or guest column (only the room type''s name)';
end $$;

-- 4. Claims as housekeeping: live claims only, whether the guest is in the room, and no booking ids
do $$ declare ids text[]; r record; begin
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  select array_agg(right(id::text, 4) order by id) into ids from room_board_claims_view where id::text like '00000000-0000-0000-0000-0000000f20%';
  if ids is distinct from array['2001','2002','2003','2004','2005'] then raise exception 'FAIL housekeeping sees claims %', ids; end if;
  if not (select checked_in from room_board_claims_view where right(id::text, 4) = '2001') then raise exception 'FAIL in-house stay not marked checked in'; end if;
  if (select checked_in from room_board_claims_view where right(id::text, 4) = '2002') then raise exception 'FAIL booked stay marked checked in'; end if;
  if (select checked_in from room_board_claims_view where right(id::text, 4) = '2005') then raise exception 'FAIL a stay whose guest left is marked checked in'; end if;
  if (select checked_in from room_board_claims_view where right(id::text, 4) in ('2003', '2004') limit 1) then raise exception 'FAIL block or hold marked checked in'; end if;
  select * into r from room_board_claims_view where right(id::text, 4) = '2003';
  if r.block_reason <> 'Leak in the ceiling' or r.claim_type <> 'block' or r.start_date <> current_date then raise exception 'FAIL block row %', r; end if;
  if (select count(*) from room_board_claims_view where reservation_room_id is not null) <> 0 then raise exception 'FAIL housekeeping was given booking ids'; end if;
  if (select count(*) from room_board_claims_view where block_reason = 'Hotel B only') <> 0 then raise exception 'FAIL housekeeping sees Hotel B''s block'; end if;
  perform t_sys();
  raise notice 'PASS housekeeping sees live claims only, knows who is in the room, and is given no booking ids';
end $$;

-- 5. Maintenance is in the same position
do $$ begin
  if t33_rooms('00000000-0000-0000-0000-00000000aa08') is distinct from array['T901','T902','T903','T904','T905','T906'] then raise exception 'FAIL maintenance rooms'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa08');
  if not (select checked_in from room_board_claims_view where right(id::text, 4) = '2001') or (select count(*) from room_board_claims_view where reservation_room_id is not null) <> 0 then raise exception 'FAIL maintenance claims'; end if;
  perform t_sys();
  raise notice 'PASS maintenance sees the same board and no booking ids';
end $$;

-- 6. Front desk and the owner may read reservations, so they get the booking link too
do $$ declare n integer; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  select count(*) into n from room_board_claims_view where id::text like '00000000-0000-0000-0000-0000000f20%' and claim_type in ('stay', 'hold') and reservation_room_id is null;
  if n <> 0 then raise exception 'FAIL front desk got % stays or holds without a booking link', n; end if;
  if (select reservation_room_id from room_board_claims_view where right(id::text, 4) = '2001') is distinct from (select rr from t33 where label = 'in_house') then raise exception 'FAIL front desk booking link'; end if;
  if (select reservation_room_id from room_board_claims_view where right(id::text, 4) = '2003') is not null then raise exception 'FAIL a block has no booking'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if (select reservation_room_id from room_board_claims_view where right(id::text, 4) = '2002') is distinct from (select rr from t33 where label = 'booked') then raise exception 'FAIL owner booking link'; end if;
  perform t_sys();
  raise notice 'PASS people who may read reservations get each stay''s booking link';
end $$;

-- 7. Without room.view (accountant), after revocation, or for another hotel group: nothing of Hotel A
do $$ begin
  if t33_rooms('00000000-0000-0000-0000-00000000aa05') is not null then raise exception 'FAIL accountant sees rooms'; end if;
  if t33_rooms('00000000-0000-0000-0000-00000000aa03') is not null then raise exception 'FAIL revoked owner sees rooms'; end if;
  if t33_rooms('00000000-0000-0000-0000-00000000bb01') is not null then raise exception 'FAIL Hotel B sees Hotel A rooms'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  if (select count(*) from room_board_view) <> 0 or (select count(*) from room_board_claims_view) <> 0 then raise exception 'FAIL accountant reads a view'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa03');
  if (select count(*) from room_board_view) <> 0 or (select count(*) from room_board_claims_view) <> 0 then raise exception 'FAIL revoked login reads a view'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  if (select count(*) from room_board_claims_view where property_id = '00000000-0000-0000-0000-0000000000a2') <> 0 then raise exception 'FAIL Hotel B reads Hotel A claims'; end if;
  if (select array_agg(block_reason) from room_board_claims_view) is distinct from array['Hotel B only'] then raise exception 'FAIL Hotel B sees %', (select array_agg(block_reason) from room_board_claims_view); end if;
  if (select count(*) from room_board_view where property_id <> '00000000-0000-0000-0000-0000000000b2') <> 0 then raise exception 'FAIL Hotel B sees a room of another hotel'; end if;
  perform t_sys();
  raise notice 'PASS no room.view, a revoked login, or another hotel group sees nothing of this hotel';
end $$;

-- 8. anon cannot read either view; the views refuse the writes a table would take
do $$ begin
  perform set_config('role', 'anon', true);
  begin perform 1 from room_board_view; raise exception 'FAIL anon read room_board_view'; exception when insufficient_privilege then null; end;
  begin perform 1 from room_board_claims_view; raise exception 'FAIL anon read room_board_claims_view'; exception when insufficient_privilege then null; end;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin update room_board_view set housekeeping_status = 'clean'; raise exception 'FAIL owner updated a view'; exception when insufficient_privilege or feature_not_supported or object_not_in_prerequisite_state then null; end;
  begin delete from room_board_claims_view; raise exception 'FAIL owner deleted from a view'; exception when insufficient_privilege or feature_not_supported or object_not_in_prerequisite_state then null; end;
  perform t_sys();
  raise notice 'PASS anon cannot read the views and nobody can write through them';
end $$;

-- 9. The views are barriers (a caller's own function cannot see rows ahead of the permission test)
do $$ begin
  if (select count(*) from pg_class where relname in ('room_board_view', 'room_board_claims_view') and 'security_barrier=true' = any (reloptions)) <> 2 then raise exception 'FAIL security_barrier'; end if;
  raise notice 'PASS both views are security barriers';
end $$;

rollback;
