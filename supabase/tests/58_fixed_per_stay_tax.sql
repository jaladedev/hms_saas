-- A fixed tax charged once per stay (migration 057). Reuses t_as / t_sys / t_expect / t_book / t_rr (05).
-- Users: aa04 front desk A. Ids: a2 property A, a3 the STD room type, a5 guest A. Dates use offsets 58 to 67 for the quote and the edits (the guest quote has a booking window) and 900 to 970 for the rest.
\set ON_ERROR_STOP on

create table t58_ctx (label text primary key, val text not null);
create function t58_get(p_label text) returns text language sql stable as $$ select val from t58_ctx where label = p_label $$;
-- What a booking's nights hold: tax in all nights, the part of it that is the stay levy, the nightly part worked out afresh.
create function t58_nights(p_res uuid, out tax bigint, out levy bigint, out nightly bigint, out levy_nights int, out first_night date, out levy_night date)
language sql stable as $$
  select coalesce(sum(n.tax_minor), 0), coalesce(sum(n.stay_tax_minor), 0),
         coalesce(sum(calc_night_tax(r.property_id, n.night_date, n.rate_minor)), 0),
         count(*) filter (where n.stay_tax_minor > 0)::int, min(n.night_date), min(n.night_date) filter (where n.stay_tax_minor > 0)
    from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id join reservations r on r.id = x.reservation_id
   where x.reservation_id = p_res
$$;

-- 1. Before any such rule: nothing changes; the booking made now is the control for the edit test in section 5
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; n record;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 900, t + 903, 'fps-pre');
  res := (b ->> 'reservation_id')::uuid;
  perform t_sys();
  insert into t58_ctx values ('pre', res::text);
  select * into n from t58_nights(res);
  if n.levy <> 0 or n.levy_nights <> 0 or n.tax <> n.nightly then raise exception 'FAIL a booking with no stay rule carries a levy %', n; end if;
  if (select tax_minor from reservations where id = res) <> n.tax then raise exception 'FAIL reservation tax'; end if;
  raise notice 'PASS no stay rule: no levy, tax is the nightly tax only';
end $$;

-- 2. The rule: only the new basis is accepted; it cannot be marked for extras
do $$ begin
  begin
    insert into tax_rules (tenant_id, property_id, name, basis, rate_value, effective_from)
    select tenant_id, id, 'Bad basis', 'fixed_per_week', 100, '2020-01-01' from properties where id = '00000000-0000-0000-0000-0000000000a2';
    raise exception 'FAIL an unknown basis was accepted';
  exception when check_violation then null; end;
  insert into tax_rules (tenant_id, property_id, name, basis, rate_value, sequence, effective_from)
  select tenant_id, id, 'Destination fee', 'fixed_per_stay', 500000, 9, property_today(id) + 30 from properties where id = '00000000-0000-0000-0000-0000000000a2';
  begin
    update tax_rules set applies_to_charges = true where name = 'Destination fee';
    raise exception 'FAIL a stay levy was marked for extras';
  exception when check_violation then null; end;
  if calc_stay_tax('00000000-0000-0000-0000-0000000000a2', property_today('00000000-0000-0000-0000-0000000000a2') + 900) <> 500000 then raise exception 'FAIL calc_stay_tax'; end if;
  if calc_stay_tax('00000000-0000-0000-0000-0000000000a2', property_today('00000000-0000-0000-0000-0000000000a2') + 29) <> 0 then raise exception 'FAIL levy before its start date'; end if;
  raise notice 'PASS the new basis is accepted, an unknown one is not, the levy cannot be marked for extras, dates are honoured';
end $$;

-- 3. A booking pays the levy once, on its first night; nightly taxes are unchanged; the guest quote shows the same total
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; n record; q jsonb; qt jsonb;
begin
  perform t_sys();
  q := search_availability('book.hotel-a.test', t + 60, t + 63, 1, 0);
  select x into qt from jsonb_array_elements(q -> 'room_types') x where x ->> 'room_type_id' = '00000000-0000-0000-0000-0000000000a3';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 60, t + 63, 'fps-one');
  res := (b ->> 'reservation_id')::uuid;
  perform t_sys();
  insert into t58_ctx values ('one', res::text);
  select * into n from t58_nights(res);
  if n.levy <> 500000 or n.levy_nights <> 1 or n.levy_night <> t + 60 then raise exception 'FAIL levy not once on night 1 %', n; end if;
  if n.tax <> n.nightly + 500000 then raise exception 'FAIL tax is not nightly + levy %', n; end if;
  if (select tax_minor from reservations where id = res) <> n.tax or (select total_minor from reservations where id = res) <> (select subtotal_minor + tax_minor from reservations where id = res) then raise exception 'FAIL reservation totals'; end if;
  if (qt ->> 'tax_minor')::bigint <> n.tax then raise exception 'FAIL the guest quote tax % differs from the booking %', qt ->> 'tax_minor', n.tax; end if;
  raise notice 'PASS one booking: levy once on night 1, nightly tax unchanged, reservation totals and the guest quote agree';
end $$;

-- 4. Two rooms pay it twice (per room); a one-night stay pays it on that night
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; n record;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'staff_entry', t + 930, t + 932,
         jsonb_build_array(jsonb_build_object('room_type_id', '00000000-0000-0000-0000-0000000000a3', 'adults', 1),
                           jsonb_build_object('room_type_id', '00000000-0000-0000-0000-0000000000a3', 'adults', 1)), 'fps-two');
  res := (b ->> 'reservation_id')::uuid;
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 940, t + 941, 'fps-night');
  perform t_sys();
  select * into n from t58_nights(res);
  if n.levy <> 1000000 or n.levy_nights <> 2 then raise exception 'FAIL two rooms should pay twice %', n; end if;
  select * into n from t58_nights((b ->> 'reservation_id')::uuid);
  if n.levy <> 500000 or n.levy_night <> t + 940 then raise exception 'FAIL a one-night stay %', n; end if;
  raise notice 'PASS two rooms pay the levy twice; a one-night stay pays it on that night';
end $$;

-- 5. Changing dates moves the levy already charged; it never doubles or vanishes; the earlier booking gets none
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); res uuid := t58_get('one')::uuid; pre uuid := t58_get('pre')::uuid; n record;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform update_reservation_stay(res, t + 58, t + 62, null, 'earlier', 'fps-e1');          -- arrive earlier, leave earlier
  perform t_sys();
  select * into n from t58_nights(res);
  if n.levy <> 500000 or n.levy_nights <> 1 or n.levy_night <> t + 58 or n.first_night <> t + 58 then raise exception 'FAIL levy after arriving earlier %', n; end if;
  if (select tax_minor from reservations where id = res) <> n.tax then raise exception 'FAIL reservation tax after the edit'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform update_reservation_stay(res, t + 61, t + 64, null, 'later', 'fps-e2');             -- arrive later than before (the old first nights fall away)
  perform t_sys();
  select * into n from t58_nights(res);
  if n.levy <> 500000 or n.levy_nights <> 1 or n.levy_night <> t + 61 then raise exception 'FAIL levy after arriving later %', n; end if;
  if (select tax_minor from reservations where id = res) <> n.tax then raise exception 'FAIL reservation tax after the second edit'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform update_reservation_stay(res, t + 61, t + 65, null, 'longer', 'fps-e3');            -- same arrival, one more night: levy stays put
  perform t_sys();
  select * into n from t58_nights(res);
  if n.levy <> 500000 or n.levy_nights <> 1 or n.levy_night <> t + 61 or n.tax <> n.nightly + 500000 then raise exception 'FAIL levy after extending %', n; end if;

  -- the booking made before the rule existed was never charged it and an edit does not start charging it
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform update_reservation_stay(pre, t + 901, t + 904, null, 'shift', 'fps-pre1');
  perform t_sys();
  select * into n from t58_nights(pre);
  if n.levy <> 0 or n.tax <> n.nightly then raise exception 'FAIL a booking made before the rule picked up a levy %', n; end if;
  raise notice 'PASS date edits move the levy with the stay (earlier, later, longer) and never double or drop it; older bookings get none';
end $$;

-- 6. A rule that is off or has ended charges nothing on a new booking
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; n record;
begin
  update tax_rules set status = 'inactive' where name = 'Destination fee';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 950, t + 952, 'fps-off');
  perform t_sys();
  select * into n from t58_nights((b ->> 'reservation_id')::uuid);
  if n.levy <> 0 or n.tax <> n.nightly then raise exception 'FAIL an inactive rule charged %', n; end if;
  update tax_rules set status = 'active', effective_to = property_today('00000000-0000-0000-0000-0000000000a2') + 960 where name = 'Destination fee';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 965, t + 967, 'fps-ended');
  perform t_sys();
  select * into n from t58_nights((b ->> 'reservation_id')::uuid);
  if n.levy <> 0 then raise exception 'FAIL an ended rule charged %', n; end if;
  delete from tax_rules where name = 'Destination fee';
  raise notice 'PASS an inactive or ended stay rule charges nothing';
end $$;
