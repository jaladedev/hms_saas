-- Minimum and maximum nights (migration 127). Reuses t_as / t_sys / t_expect / t_book / t_rr (05). Rooms of our own (T127-1..4, type a3).
-- Policy rows are immutable, so the test edits the one in force with triggers off (session_replication_role = replica) and puts it back.
\set ON_ERROR_STOP on

create function t127_limits(lo integer, hi integer, raw jsonb default null) returns void language plpgsql as $$
declare prop uuid := '00000000-0000-0000-0000-0000000000a2'; cfg jsonb; pid uuid;
begin
  set local session_replication_role = replica;
  select id, config into pid, cfg from property_policies where property_id = prop and effective_from <= property_today(prop) order by effective_from desc limit 1;
  if pid is null then raise exception 'FAIL test needs a policy row in force'; end if;
  cfg := cfg - 'min_nights' - 'max_nights';
  if raw is not null then cfg := cfg || raw;
  else
    if lo is not null then cfg := cfg || jsonb_build_object('min_nights', lo); end if;
    if hi is not null then cfg := cfg || jsonb_build_object('max_nights', hi); end if;
  end if;
  update property_policies set config = cfg where id = pid;
  set local session_replication_role = origin;
end $$;

do $$ declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2'; t date; typ uuid := '00000000-0000-0000-0000-0000000000a3';
  owner text := '00000000-0000-0000-0000-00000000aa01';
  rooms_ uuid[]; r jsonb; res uuid; lim integer[]; n integer;
begin
  perform t_sys();
  t := property_today(prop);
  insert into rooms (tenant_id, property_id, room_type_id, room_number, floor)
    select tenant_id, id, typ, 'T127-' || g, 9 from properties, generate_series(1, 4) g where id = prop;
  select array_agg(id order by room_number) into rooms_ from rooms where property_id = prop and room_number like 'T127-%';
  update rooms set housekeeping_status = 'clean' where id = any (rooms_);

  -- A. nothing set: 1 to 30, as before
  perform t127_limits(null, null);
  lim := stay_limits(prop, t);
  if lim <> array[1, 30] then raise exception 'FAIL defaults %', lim; end if;
  r := t_book(typ, t + 10, t + 11, 't127-a', rooms_[1]);
  if r ->> 'reservation_id' is null then raise exception 'FAIL one night refused by default'; end if;

  -- B. 2 to 5 nights: too short and too long are refused with the hotel's number; inside the range works, at both edges
  perform t127_limits(2, 5);
  perform t_expect(format('select t_book(%L, %L, %L, %L, %L)', typ, t + 20, t + 21, 't127-b1', rooms_[2]), 'POLICY_VIOLATION: minimum stay 2');
  perform t_expect(format('select t_book(%L, %L, %L, %L, %L)', typ, t + 20, t + 26, 't127-b2', rooms_[2]), 'POLICY_VIOLATION: maximum stay 5');
  r := t_book(typ, t + 20, t + 22, 't127-b3', rooms_[2]);
  r := t_book(typ, t + 30, t + 35, 't127-b4', rooms_[3]);
  perform t_sys();
  if exists (select 1 from reservations where departure_date - arrival_date in (1, 6) and property_id = prop and arrival_date in (t + 20)) then raise exception 'FAIL a refused stay left a booking'; end if;

  -- C. the guest's view of the rule
  lim := stay_limits(prop, t);
  if lim <> array[2, 5] then raise exception 'FAIL limits read %', lim; end if;

  -- D. editing dates: a change of length is checked, the same length is not, and a booking made under an older rule can still move
  perform t127_limits(2, 5);
  res := (r ->> 'reservation_id')::uuid;                                   -- 5 nights from t + 30
  perform t_as(owner);
  perform t_expect(format('select update_reservation_stay(%L, %L, %L, null, %L, %L)', res, t + 30, t + 36, 'longer', 't127-d1'), 'POLICY_VIOLATION: maximum stay 5');
  perform t_expect(format('select update_reservation_stay(%L, %L, %L, null, %L, %L)', res, t + 30, t + 31, 'shorter', 't127-d2'), 'POLICY_VIOLATION: minimum stay 2');
  perform update_reservation_stay(res, t + 32, t + 37, null, 'same length, later', 't127-d3');
  perform t_sys();
  perform t127_limits(7, 9);                                              -- the hotel tightens its rule: this 5-night booking is now outside it
  perform t_as(owner);
  perform update_reservation_stay(res, t + 40, t + 45, null, 'same length under a stricter rule', 't127-d4');
  perform t_sys();
  if (select departure_date - arrival_date from reservations where id = res) <> 5 then raise exception 'FAIL older booking could not move'; end if;

  -- E. the rest of the life of a booking is never blocked by a later rule: cancel
  perform t_as(owner);
  perform cancel_reservation(res, 'cancelled under a newer rule', 't127-e1');
  perform t_sys();
  if (select reservation_status from reservations where id = res) <> 'cancelled' then raise exception 'FAIL cancel blocked by the stay rule'; end if;

  -- F. bad stored values are ignored, never an error: 0, 31, 2.5, text, min above max
  perform t127_limits(null, null, '{"min_nights": 0, "max_nights": 31}');
  if stay_limits(prop, t) <> array[1, 30] then raise exception 'FAIL out of range values %', stay_limits(prop, t); end if;
  perform t127_limits(null, null, '{"min_nights": 2.5, "max_nights": "4"}');
  if stay_limits(prop, t) <> array[1, 30] then raise exception 'FAIL fractional or text values %', stay_limits(prop, t); end if;
  perform t127_limits(null, null, '{"min_nights": 6, "max_nights": 3}');
  if stay_limits(prop, t) <> array[6, 6] then raise exception 'FAIL min above max %', stay_limits(prop, t); end if;

  perform t127_limits(null, null);
  update rooms set operational_status = 'retired' where id = any (rooms_);
  raise notice 'PASS stay length: defaults 1 to 30; min and max refused with the hotel''s number at both edges; date edits checked only when the length changes; older bookings still move and cancel; bad stored values ignored';
end $$;

-- G. guest_policy carries the limits
do $$ declare r jsonb; host text;
begin
  perform t_sys();
  host := 'book.hotel-a.test';
  perform t127_limits(3, 8);
  r := guest_policy(host);
  if (r ->> 'min_nights')::integer <> 3 or (r ->> 'max_nights')::integer <> 8 then raise exception 'FAIL guest_policy limits %', r; end if;
  perform t127_limits(null, null);
  raise notice 'PASS stay length: guest_policy returns min_nights and max_nights';
end $$;

drop function t127_limits(integer, integer, jsonb);
