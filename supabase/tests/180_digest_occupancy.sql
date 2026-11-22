-- Morning summary occupancy (migration 180). Hotel A: tenant a1, property a2.
\set ON_ERROR_STOP on

do $$ declare
  v_p constant uuid := '00000000-0000-0000-0000-0000000000a2';
  v_zone text; pl jsonb; v_today date; v_ref text; v_tonight integer; v_tomorrow integer; v_rooms integer;
begin
  perform t_sys();
  select name into v_zone from pg_timezone_names where extract(hour from now() at time zone name) between 8 and 20 order by name limit 1;
  update properties set timezone = v_zone, digest_email = 'owner@hotel-a.test' where id = v_p;
  v_today := property_today(v_p);
  delete from digest_outbox where property_id = v_p;

  -- a stay covering today, tonight and tomorrow night, and a block that must not count
  v_ref := t150_ref(0, 5, 'g180-a');
  perform t_sys();
  v_tonight := (select count(distinct k.room_id) from room_inventory_claims k where k.property_id = v_p and k.claim_type = 'stay' and k.status = 'active' and k.start_date <= v_today and k.end_date > v_today);
  v_tomorrow := (select count(distinct k.room_id) from room_inventory_claims k where k.property_id = v_p and k.claim_type = 'stay' and k.status = 'active' and k.start_date <= v_today + 1 and k.end_date > v_today + 1);
  v_rooms := (select count(*) from rooms where property_id = v_p and operational_status = 'active');
  if v_tonight < 1 or v_tomorrow < 1 then raise exception 'FAIL setup: no stay found % %', v_tonight, v_tomorrow; end if;

  if queue_daily_digests() < 1 then raise exception 'FAIL nothing queued'; end if;
  select payload into pl from digest_outbox where property_id = v_p and report_date = v_today;
  if (pl ->> 'rooms')::int <> v_rooms then raise exception 'FAIL rooms: % vs %', pl, v_rooms; end if;
  if (pl ->> 'occupied_tonight')::int <> v_tonight then raise exception 'FAIL tonight: % vs %', pl, v_tonight; end if;
  if (pl ->> 'occupied_tomorrow')::int <> v_tomorrow then raise exception 'FAIL tomorrow: % vs %', pl, v_tomorrow; end if;
  if (pl ->> 'occupied_tonight')::int > (pl ->> 'rooms')::int then raise exception 'FAIL more occupied than rooms'; end if;

  delete from digest_outbox where property_id = v_p;
  raise notice 'PASS digest occupancy: rooms in service, rooms occupied tonight and tomorrow night, stays only';
end $$;

update properties set timezone = 'Africa/Lagos', digest_email = null where id = '00000000-0000-0000-0000-0000000000a2';
