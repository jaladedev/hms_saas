-- The week ahead in the morning summary (migration 184). Hotel A: tenant a1, property a2. Reuses t_as / t_sys / t_expect (05), t07_res (07), t129_zone (129).
-- The test moves hotel A to a time zone where the local hour suits the summary and puts it back at the end (see test 138).
\set ON_ERROR_STOP on

create table t184_orig (timezone text, digest_email text);
insert into t184_orig select timezone, digest_email from properties where id = '00000000-0000-0000-0000-0000000000a2';

-- The independent count: rooms with an active stay claim covering a night (the definition migration 180 states).
create function t184_occupied(p_night date) returns bigint language sql as $$
  select count(distinct k.room_id) from room_inventory_claims k
   where k.property_id = '00000000-0000-0000-0000-0000000000a2' and k.claim_type = 'stay' and k.status = 'active'
     and k.start_date <= p_night and k.end_date > p_night
$$;

create function t184_payload() returns jsonb language plpgsql as $$
declare v_pl jsonb; v_today date := property_today('00000000-0000-0000-0000-0000000000a2');
begin
  delete from digest_outbox where property_id = '00000000-0000-0000-0000-0000000000a2';
  if queue_daily_digests() < 1 then raise exception 'FAIL nothing queued'; end if;
  select payload into v_pl from digest_outbox where property_id = '00000000-0000-0000-0000-0000000000a2' and report_date = v_today;
  return v_pl;
end $$;

-- 1. The week ahead: seven nights, each the same count as an independent query, tonight and tomorrow agreeing with migration 180's keys
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; t date; pl jsonb; i integer; v_a uuid; v_b uuid; v_keys text[];
begin
  perform t_sys();
  update properties set timezone = t129_zone(12), digest_email = 'owner@hotel-a.test' where id = v_p;
  t := property_today(v_p);
  v_a := t07_res(0, 5, 't184-a');   -- tonight to the fourth night
  v_b := t07_res(2, 2, 't184-b');   -- the third and fourth night
  pl := t184_payload();
  if jsonb_array_length(pl -> 'outlook') <> 7 then raise exception 'FAIL expected 7 nights %', pl -> 'outlook'; end if;
  for i in 0..6 loop
    if (pl -> 'outlook' -> i ->> 'date')::date <> t + i then raise exception 'FAIL date at %: %', i, pl -> 'outlook' -> i; end if;
    if (pl -> 'outlook' -> i ->> 'occupied')::bigint <> t184_occupied(t + i) then raise exception 'FAIL night %: % vs %', i, pl -> 'outlook' -> i, t184_occupied(t + i); end if;
    if (pl -> 'outlook' -> i ->> 'occupied')::int > (pl ->> 'rooms')::int then raise exception 'FAIL more occupied than rooms at %', i; end if;
    if (select array_agg(k order by k) from jsonb_object_keys(pl -> 'outlook' -> i) k) <> array['date', 'occupied'] then raise exception 'FAIL a night carries more than date and occupied'; end if;
  end loop;
  if (pl -> 'outlook' -> 0 ->> 'occupied') <> (pl ->> 'occupied_tonight') or (pl -> 'outlook' -> 1 ->> 'occupied') <> (pl ->> 'occupied_tomorrow') then
    raise exception 'FAIL the outlook disagrees with migration 180''s keys %', pl;
  end if;
  -- the two bookings are visible: the third and fourth night hold one more room than the second
  if (pl -> 'outlook' -> 2 ->> 'occupied')::int < 2 or (pl -> 'outlook' -> 4 ->> 'occupied')::int < 1 then raise exception 'FAIL the setup bookings are not counted %', pl -> 'outlook'; end if;
  select array_agg(k order by k) into v_keys from jsonb_object_keys(pl) k;
  if v_keys <> array['arrivals', 'date', 'departures', 'holds', 'hotel', 'in_house', 'messages', 'occupied_tomorrow', 'occupied_tonight', 'outlook', 'rooms', 'tomorrow', 'waiting'] then raise exception 'FAIL keys %', v_keys; end if;
  if pl::text ~* '@|minor|guest' then raise exception 'FAIL names or money in the summary %', pl; end if;
  raise notice 'PASS outlook: seven nights from the hotel''s own today, each the same as an independent count, agreeing with occupied_tonight and occupied_tomorrow, only date and occupied';
end $$;

-- 2. A booking adds one room on its own nights only; a cancelled booking and an unpaid hold add nothing
do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; before jsonb; after jsonb; res uuid; web jsonb; t date := property_today('00000000-0000-0000-0000-0000000000a2'); i integer; v_exp integer;
begin
  perform t_sys();
  before := t184_payload() -> 'outlook';
  res := t07_res(5, 1, 't184-c');           -- the sixth night only
  after := t184_payload() -> 'outlook';
  for i in 0..6 loop
    v_exp := case when i = 5 then 1 else 0 end;
    if (after -> i ->> 'occupied')::int - (before -> i ->> 'occupied')::int <> v_exp then raise exception 'FAIL booking effect at night %: % then %', i, before -> i, after -> i; end if;
  end loop;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform cancel_reservation(res, 'test', 't184-cancel');
  perform t_sys();
  if t184_payload() -> 'outlook' <> before then raise exception 'FAIL a cancelled booking still counts'; end if;
  web := create_reservation(v_p, '00000000-0000-0000-0000-0000000000a5', 'website', t + 5, t + 6,
          jsonb_build_array(jsonb_build_object('room_type_id', '00000000-0000-0000-0000-0000000000a3', 'adults', 1)), 't184-web');
  if t184_payload() -> 'outlook' <> before then raise exception 'FAIL an unpaid hold counted'; end if;
  raise notice 'PASS outlook: a booking adds a room on its own nights only; a cancelled booking and an unpaid hold add nothing';
end $$;

-- leave hotel A as found
update properties p set timezone = o.timezone, digest_email = o.digest_email from t184_orig o where p.id = '00000000-0000-0000-0000-0000000000a2';
delete from digest_outbox where property_id = '00000000-0000-0000-0000-0000000000a2';
