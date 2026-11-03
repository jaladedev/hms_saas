-- The occupancy report (migration 040). Reuses t_as / t_sys / t_expect (05) and t07_res (07).
-- Users: aa01 owner A, aa04 front desk A, aa05 accountant A, aa02 housekeeping A, bb01 owner B.
-- Every check compares a before and an after, and every date is far ahead (offsets 1400 to 1440), which nothing else uses.
\set ON_ERROR_STOP on

create function t39_rep(p_from date, p_to date) returns jsonb language sql as $$
  select occupancy_report('00000000-0000-0000-0000-0000000000a2', p_from, p_to)
$$;
create function t39_n(j jsonb, k text) returns bigint language sql immutable as $$ select (j #>> array['totals', k])::bigint $$;
create function t39_d(j jsonb, i int, k text) returns bigint language sql immutable as $$ select (j #>> array['days', i::text, k])::bigint $$;

-- 1. Who may read it, and the range rules
do $$ declare t date := property_today('00000000-0000-0000-0000-0000000000a2'); r jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t39_rep(%L,%L)', t, t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select t39_rep(%L,%L)', t, t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select t39_rep(%L,%L)', t, t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  r := t39_rep(t + 1400, t + 1400);
  if jsonb_array_length(r -> 'days') <> 1 or r ->> 'currency' <> 'NGN' or t39_n(r, 'rooms_total') < 1 then raise exception 'FAIL one-day report %', r; end if;
  perform t_expect(format('select t39_rep(%L,%L)', t, t - 1), 'POLICY_VIOLATION: range');
  perform t_expect(format('select t39_rep(%L,%L)', t, t + 92), 'POLICY_VIOLATION: range');
  perform t_expect(format('select occupancy_report(%L,null,%L)', '00000000-0000-0000-0000-0000000000a2', t), 'POLICY_VIOLATION: range');
  if jsonb_array_length(t39_rep(t, t + 91) -> 'days') <> 92 then raise exception 'FAIL 92 days'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t39_rep(t, t);
  perform t_sys();
  raise notice 'PASS access: accountant and owner may read; front desk, housekeeping and another hotel get NOT_FOUND; 1 to 92 days only';
end $$;

-- 2. A booking sells its nights, brings an arrival and a departure, and cancelling it takes them back; holds and cancelled sell nothing
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); res uuid; web jsonb; before jsonb; after jsonb; rate bigint;
begin
  perform t_sys();
  perform t_as('00000000-0000-0000-0000-00000000aa05'); before := t39_rep(t + 1400, t + 1403);
  perform t_sys();
  res := t07_res(1400, 2, 't39-b1');
  select sum(n.rate_minor) into rate from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = res;
  perform t_as('00000000-0000-0000-0000-00000000aa05'); after := t39_rep(t + 1400, t + 1403);
  if t39_n(after, 'rooms_sold') - t39_n(before, 'rooms_sold') <> 2 then raise exception 'FAIL sold delta %', after -> 'totals'; end if;
  if t39_n(after, 'room_revenue_minor') - t39_n(before, 'room_revenue_minor') <> rate then raise exception 'FAIL revenue delta'; end if;
  if t39_d(after, 0, 'rooms_sold') - t39_d(before, 0, 'rooms_sold') <> 1 or t39_d(after, 1, 'rooms_sold') - t39_d(before, 1, 'rooms_sold') <> 1
     or t39_d(after, 2, 'rooms_sold') <> t39_d(before, 2, 'rooms_sold') then raise exception 'FAIL nights land on their own days (the departure day is not a night)'; end if;
  if t39_d(after, 0, 'arrivals') - t39_d(before, 0, 'arrivals') <> 1 or t39_d(after, 2, 'departures') - t39_d(before, 2, 'departures') <> 1
     or t39_d(after, 1, 'arrivals') <> t39_d(before, 1, 'arrivals') then raise exception 'FAIL arrival and departure days'; end if;
  if t39_n(after, 'rooms_available') <> t39_n(before, 'rooms_available') or t39_n(after, 'rooms_total') <> t39_n(before, 'rooms_total')
     then raise exception 'FAIL a booking changed the room count'; end if;

  -- cancelled: back to before
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform cancel_reservation(res, 'test', 't39-cancel');
  perform t_as('00000000-0000-0000-0000-00000000aa05'); after := t39_rep(t + 1400, t + 1403);
  if t39_n(after, 'rooms_sold') <> t39_n(before, 'rooms_sold') or t39_n(after, 'room_revenue_minor') <> t39_n(before, 'room_revenue_minor')
     or t39_n(after, 'arrivals') <> t39_n(before, 'arrivals') then raise exception 'FAIL a cancelled booking still counts %', after -> 'totals'; end if;

  -- a pending online hold sells nothing until it is paid
  perform t_sys();
  web := create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'website', t + 1420, t + 1422,
          jsonb_build_array(jsonb_build_object('room_type_id', '00000000-0000-0000-0000-0000000000a3', 'adults', 1)), 't39-web');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  if t39_n(t39_rep(t + 1420, t + 1421), 'rooms_sold') <> 0 then raise exception 'FAIL a pending hold counted as sold'; end if;
  perform t_sys();
  perform record_manual_payment((web ->> 'reservation_id')::uuid, (select total_minor from reservations where id = (web ->> 'reservation_id')::uuid), 'cash', 'w1', null, 't39-webpay');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  if t39_n(t39_rep(t + 1420, t + 1421), 'rooms_sold') <> 2 then raise exception 'FAIL a paid booking did not count'; end if;
  perform t_sys();
  raise notice 'PASS sales: nights count on their own days with their revenue, arrivals and departures follow the dates; cancelled and unpaid holds add nothing';
end $$;

-- 3. Blocks and rooms out of service shrink what can be sold; sold never exceeds what is available
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); room uuid; before jsonb; after jsonb; blk uuid; res uuid; ids uuid[];
begin
  perform t_sys();
  -- a room nothing else claims in the window (a 'fail' block on a taken room answers created: false, it does not raise)
  select r.id into room from rooms r where r.property_id = '00000000-0000-0000-0000-0000000000a2' and r.operational_status = 'active'
     and not exists (select 1 from room_inventory_claims c where c.room_id = r.id and c.status = 'active' and c.start_date < t + 1413 and c.end_date > t + 1405)
   order by r.room_number limit 1;
  perform t_as('00000000-0000-0000-0000-00000000aa05'); before := t39_rep(t + 1410, t + 1413);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if (create_room_block(room, t + 1410, t + 1412, 'test leak', 'fail', 't39-block') ->> 'created') <> 'true' then raise exception 'FAIL fixture block'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa05'); after := t39_rep(t + 1410, t + 1413);
  if t39_n(after, 'rooms_blocked') - t39_n(before, 'rooms_blocked') <> 2 or t39_n(after, 'rooms_available') - t39_n(before, 'rooms_available') <> -2
     then raise exception 'FAIL block effect %', after -> 'totals'; end if;
  if t39_d(after, 2, 'rooms_blocked') <> t39_d(before, 2, 'rooms_blocked') then raise exception 'FAIL block end date is exclusive'; end if;
  perform t_sys();
  select id into blk from room_inventory_claims where room_id = room and claim_type = 'block' and start_date = t + 1410;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform release_room_block(blk);
  perform t_as('00000000-0000-0000-0000-00000000aa05'); after := t39_rep(t + 1410, t + 1413);
  if t39_n(after, 'rooms_blocked') <> t39_n(before, 'rooms_blocked') then raise exception 'FAIL a released block still counts'; end if;

  -- a room out of service is not in the total
  perform t_sys();
  update rooms set operational_status = 'out_of_service' where id = room;
  perform t_as('00000000-0000-0000-0000-00000000aa05'); after := t39_rep(t + 1410, t + 1410);
  if t39_n(after, 'rooms_total') <> t39_d(before, 0, 'rooms_total') - 1 then raise exception 'FAIL out of service room counted'; end if;
  perform t_sys();
  update rooms set operational_status = 'active' where id = room;

  -- every room out of service later, yet a past booking stays sold: available is held up to sold, so occupancy cannot pass 100 percent
  res := t07_res(1430, 1, 't39-b2');
  select array_agg(id) into ids from rooms where property_id = '00000000-0000-0000-0000-0000000000a2' and operational_status = 'active';
  update rooms set operational_status = 'out_of_service' where property_id = '00000000-0000-0000-0000-0000000000a2' and operational_status = 'active';
  perform t_as('00000000-0000-0000-0000-00000000aa05'); after := t39_rep(t + 1430, t + 1430);
  perform t_sys();
  update rooms set operational_status = 'active' where id = any(ids);
  if t39_n(after, 'rooms_total') <> 0 or t39_n(after, 'rooms_sold') < 1 or t39_n(after, 'rooms_available') < t39_n(after, 'rooms_sold')
     then raise exception 'FAIL available below sold %', after -> 'totals'; end if;
  raise notice 'PASS capacity: blocks take rooms off the day they cover (end date free), released ones come back, out of service rooms leave the total, available never drops below sold';
end $$;

-- 4. No-shows count on their arrival day
do $$ declare t date := property_today('00000000-0000-0000-0000-0000000000a2'); res uuid; before jsonb; after jsonb; begin
  perform t_sys();
  perform t_as('00000000-0000-0000-0000-00000000aa05'); before := t39_rep(t + 1440, t + 1440);
  perform t_sys();
  res := t07_res(1440, 1, 't39-b3');
  update reservations set reservation_status = 'no_show' where id = res;
  perform t_as('00000000-0000-0000-0000-00000000aa05'); after := t39_rep(t + 1440, t + 1440);
  if t39_n(after, 'no_shows') - t39_n(before, 'no_shows') <> 1 then raise exception 'FAIL no-show count %', after -> 'totals'; end if;
  if t39_n(after, 'rooms_sold') <> t39_n(before, 'rooms_sold') or t39_n(after, 'arrivals') <> t39_n(before, 'arrivals') then raise exception 'FAIL a no-show counted as sold or arriving'; end if;
  perform t_sys();
  raise notice 'PASS no-shows: counted on the arrival day, never as sold or arriving';
end $$;

-- 5. The function is closed to anon
do $$ begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('role', 'anon', true);
  begin
    perform occupancy_report('00000000-0000-0000-0000-0000000000a2', current_date, current_date);
    raise exception 'FAIL anon ran occupancy_report';
  exception when insufficient_privilege then null;
  end;
  perform set_config('role', 'postgres', true);
  raise notice 'PASS anon cannot run occupancy_report';
end $$;
