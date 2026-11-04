-- The channel and guest reports (migration 044). Reuses t_as / t_sys / t_expect (05).
-- Users: aa01 owner A, aa04 front desk A, aa05 accountant A, aa02 housekeeping A, bb01 owner B.
-- Every booking sits in 1600 to 1620 days ahead, which nothing else uses, so totals over that window are absolute.
\set ON_ERROR_STOP on

create function t40_book(p_guest uuid, p_source text, p_off int, p_nights int, p_key text) returns uuid language plpgsql as $$
declare r uuid; t date := property_today('00000000-0000-0000-0000-0000000000a2');
begin
  r := (create_reservation('00000000-0000-0000-0000-0000000000a2', p_guest, 'staff_entry', t + p_off, t + p_off + p_nights,
          jsonb_build_array(jsonb_build_object('room_type_id', '00000000-0000-0000-0000-0000000000a3', 'adults', 1)), p_key) ->> 'reservation_id')::uuid;
  update reservations set source = p_source where id = r;
  return r;
end $$;
create function t40_rev(p_res uuid) returns bigint language sql as $$
  select coalesce(sum(n.rate_minor), 0) from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = p_res
$$;
create function t40_ch(p_from date, p_to date) returns jsonb language sql as $$ select channel_report('00000000-0000-0000-0000-0000000000a2', p_from, p_to) $$;
create function t40_gu(p_from date, p_to date) returns jsonb language sql as $$ select guest_report('00000000-0000-0000-0000-0000000000a2', p_from, p_to) $$;
create function t40_row(j jsonb, src text, k text) returns bigint language sql immutable as $$
  select (e ->> k)::bigint from jsonb_array_elements(j -> 'rows') e where e ->> 'source' = src
$$;

-- 1. Who may read them, and the range rules
do $$ declare t date := property_today('00000000-0000-0000-0000-0000000000a2'); r jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t40_ch(%L,%L)', t, t), 'NOT_FOUND');
  perform t_expect(format('select t40_gu(%L,%L)', t, t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select t40_ch(%L,%L)', t, t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select t40_ch(%L,%L)', t, t), 'NOT_FOUND');
  perform t_expect(format('select t40_gu(%L,%L)', t, t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  r := t40_ch(t + 1600, t + 1600);
  if jsonb_array_length(r -> 'rows') <> 5 or r #>> '{rows,0,source}' <> 'website' or r #>> '{rows,4,source}' <> 'partner' or r ->> 'currency' <> 'NGN'
    then raise exception 'FAIL the five sources are always listed in order %', r; end if;
  perform t_expect(format('select t40_ch(%L,%L)', t, t - 1), 'POLICY_VIOLATION: range');
  perform t_expect(format('select t40_gu(%L,%L)', t, t + 92), 'POLICY_VIOLATION: range');
  perform t_expect(format('select channel_report(%L,null,%L)', '00000000-0000-0000-0000-0000000000a2', t), 'POLICY_VIOLATION: range');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t40_ch(t, t + 91); perform t40_gu(t, t + 91);
  perform t_sys();
  raise notice 'PASS access: accountant and owner may read; front desk, housekeeping and another hotel get NOT_FOUND; 1 to 92 days only';
end $$;

-- 2. Channels: bookings, nights, revenue by source; cancelled and no-show by arrival day; holds and cancelled sell nothing
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); g1 uuid := gen_random_uuid(); g2 uuid := gen_random_uuid(); g3 uuid := gen_random_uuid(); g4 uuid := gen_random_uuid();
  ra uuid; rb uuid; rc uuid; rd uuid; re uuid; rf uuid; rg uuid; rh uuid; r jsonb; web jsonb;
begin
  perform t_sys();
  insert into guests (id, tenant_id, full_name, country_code) select g1, tenant_id, 'T40 Ngozi', 'NG' from properties where id = '00000000-0000-0000-0000-0000000000a2';
  insert into guests (id, tenant_id, full_name, country_code) select g2, tenant_id, 'T40 Kofi', 'GH' from properties where id = '00000000-0000-0000-0000-0000000000a2';
  insert into guests (id, tenant_id, full_name) select g3, tenant_id, 'T40 Nobody' from properties where id = '00000000-0000-0000-0000-0000000000a2';
  insert into guests (id, tenant_id, full_name, country_code) select g4, tenant_id, 'T40 Returning', 'NG' from properties where id = '00000000-0000-0000-0000-0000000000a2';
  ra := t40_book(g1, 'phone', 1600, 2, 't40-a');
  rb := t40_book(g1, 'walk_in', 1605, 1, 't40-b');
  rc := t40_book(g2, 'partner', 1600, 3, 't40-c');
  rd := t40_book(g3, 'staff_entry', 1610, 1, 't40-d');
  re := t40_book(g3, 'phone', 1602, 1, 't40-e');
  rf := t40_book(g3, 'walk_in', 1603, 1, 't40-f');
  rg := t40_book(g4, 'phone', 1590, 1, 't40-g');       -- before the window: makes g4 a returning guest
  rh := t40_book(g4, 'walk_in', 1606, 1, 't40-h');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform cancel_reservation(re, 'test', 't40-cancel');
  perform t_sys();
  update reservations set reservation_status = 'no_show' where id = rf;
  -- an unpaid online hold sells nothing
  web := create_reservation('00000000-0000-0000-0000-0000000000a2', g3, 'website', t + 1615, t + 1616,
          jsonb_build_array(jsonb_build_object('room_type_id', '00000000-0000-0000-0000-0000000000a3', 'adults', 1)), 't40-web');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  r := t40_ch(t + 1600, t + 1620);
  if t40_row(r, 'phone', 'bookings') <> 1 or t40_row(r, 'phone', 'room_nights') <> 2 or t40_row(r, 'phone', 'room_revenue_minor') <> t40_rev(ra)
    then raise exception 'FAIL phone row (the cancelled phone booking and the one before the window must not count) %', r -> 'rows'; end if;
  if t40_row(r, 'phone', 'cancelled') <> 1 or t40_row(r, 'walk_in', 'no_shows') <> 1 or t40_row(r, 'walk_in', 'cancelled') <> 0
    then raise exception 'FAIL cancelled and no-show by arrival day %', r -> 'rows'; end if;
  if t40_row(r, 'walk_in', 'bookings') <> 2 or t40_row(r, 'walk_in', 'room_nights') <> 2 or t40_row(r, 'walk_in', 'room_revenue_minor') <> t40_rev(rb) + t40_rev(rh)
    then raise exception 'FAIL walk-in row (the no-show must not count) %', r -> 'rows'; end if;
  if t40_row(r, 'partner', 'bookings') <> 1 or t40_row(r, 'partner', 'room_nights') <> 3 or t40_row(r, 'partner', 'room_revenue_minor') <> t40_rev(rc)
    then raise exception 'FAIL partner row %', r -> 'rows'; end if;
  if t40_row(r, 'staff_entry', 'bookings') <> 1 or t40_row(r, 'website', 'bookings') <> 0 or t40_row(r, 'website', 'room_nights') <> 0
    then raise exception 'FAIL staff entry or the unpaid website hold counted %', r -> 'rows'; end if;
  if (r #>> '{totals,bookings}')::int <> 5 or (r #>> '{totals,room_nights}')::int <> 8
     or (r #>> '{totals,room_revenue_minor}')::bigint <> t40_rev(ra) + t40_rev(rb) + t40_rev(rc) + t40_rev(rd) + t40_rev(rh)
    then raise exception 'FAIL totals %', r -> 'totals'; end if;
  -- a booking is counted in the range by its nights: a window holding only its second night still counts it, with one night
  r := t40_ch(t + 1601, t + 1601);
  if t40_row(r, 'phone', 'bookings') <> 1 or t40_row(r, 'phone', 'room_nights') <> 1 or t40_row(r, 'partner', 'room_nights') <> 1
    then raise exception 'FAIL one-night window %', r -> 'rows'; end if;
  raise notice 'PASS channels: bookings, nights and revenue by source from the nights in range; cancelled and no-shows by arrival; holds, cancelled and no-shows sell nothing';
end $$;

-- 3. Guests: new and returning, countries, top guests, and names only for guest.view
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); r jsonb; top jsonb; ng record; prev bigint; e jsonb; hid uuid;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  r := t40_gu(t + 1600, t + 1620);
  if (r ->> 'guests_total')::int <> 4 or (r ->> 'guests_new')::int <> 3 or (r ->> 'guests_returning')::int <> 1 or (r ->> 'names_hidden')::boolean
    then raise exception 'FAIL guest counts %', r; end if;
  if r #>> '{countries,0,country}' <> 'NG' or (r #>> '{countries,0,guests}')::int <> 2 or (r #>> '{countries,0,room_nights}')::int <> 4
     or r #>> '{countries,1,country}' <> 'GH' or (r #>> '{countries,1,room_nights}')::int <> 3
     or r #>> '{countries,2,country}' <> 'unknown' or jsonb_array_length(r -> 'countries') <> 3
    then raise exception 'FAIL countries %', r -> 'countries'; end if;
  top := r -> 'top_guests';
  if jsonb_array_length(top) <> 4 then raise exception 'FAIL top guests %', top; end if;
  prev := null;
  for e in select * from jsonb_array_elements(top) loop
    if prev is not null and (e ->> 'room_revenue_minor')::bigint > prev then raise exception 'FAIL top guests not in revenue order %', top; end if;
    prev := (e ->> 'room_revenue_minor')::bigint;
  end loop;
  select * into ng from jsonb_to_record((select x from jsonb_array_elements(top) x where x ->> 'name' = 'T40 Ngozi')) as q(stays int, room_nights int, room_revenue_minor bigint);
  if ng.stays <> 2 or ng.room_nights <> 3 then raise exception 'FAIL Ngozi row %', top; end if;
  -- the other hotel's guest data never appears: the whole window is hotel A's only
  if (select count(*) from jsonb_array_elements(top) x where x ->> 'name' not like 'T40 %') <> 0 then raise exception 'FAIL foreign or old guest in the window'; end if;

  -- without guest.view the counts stay and the names go
  perform t_sys();
  select p.id into hid from permissions p where p.key = 'guest.view';
  delete from role_permissions where permission_id = hid and role_id = (select id from roles where key = 'accountant');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  r := t40_gu(t + 1600, t + 1620);
  perform t_sys();
  insert into role_permissions (role_id, permission_id) select id, hid from roles where key = 'accountant';
  if not (r ->> 'names_hidden')::boolean or jsonb_array_length(r -> 'top_guests') <> 0 or (r ->> 'guests_total')::int <> 4 or jsonb_array_length(r -> 'countries') <> 3
    then raise exception 'FAIL names must be hidden without guest.view, counts kept %', r; end if;
  if r::text like '%T40%' then raise exception 'FAIL a guest name leaked'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  if (t40_gu(t + 1600, t + 1620) ->> 'names_hidden')::boolean then raise exception 'FAIL guest.view was not restored'; end if;
  perform t_sys();
  raise notice 'PASS guests: new and returning, countries with unknown last, top guests by revenue, names only with guest.view';
end $$;

-- 3b. The shape mark_no_show leaves (037): status cancelled with no_show_at set. 044 once counted status 'no_show', which nothing sets,
-- so real no-shows never showed and were counted under cancelled. Offsets 1700 and up are used by nothing else.
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); g uuid := gen_random_uuid(); ns uuid; plain uuid; r jsonb;
begin
  perform t_sys();
  insert into guests (id, tenant_id, full_name) select g, tenant_id, 'T44 No-show' from properties where id = '00000000-0000-0000-0000-0000000000a2';
  ns := t40_book(g, 'phone', 1700, 1, 't44-ns');
  plain := t40_book(g, 'phone', 1701, 1, 't44-plain');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform cancel_reservation(ns, 'no-show', 't44-ns-c');
  perform cancel_reservation(plain, 'changed plans', 't44-plain-c');
  perform t_sys();
  update reservations set no_show_at = now() where id = ns;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  r := t40_ch(t + 1700, t + 1701);
  perform t_sys();
  if t40_row(r, 'phone', 'no_shows') <> 1 or t40_row(r, 'phone', 'cancelled') <> 1
    then raise exception 'FAIL one no-show and one plain cancellation expected, not counted twice %', r -> 'rows'; end if;
  if (r #>> '{totals,no_shows}')::int <> 1 or (r #>> '{totals,cancelled}')::int <> 1 or (r #>> '{totals,bookings}')::int <> 0
    then raise exception 'FAIL totals %', r -> 'totals'; end if;
  raise notice 'PASS no-shows as mark_no_show records them: counted once under no-shows, not under cancelled';
end $$;

-- 4. Closed to anon
do $$ begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('role', 'anon', true);
  begin
    perform channel_report('00000000-0000-0000-0000-0000000000a2', current_date, current_date);
    raise exception 'FAIL anon ran channel_report';
  exception when insufficient_privilege then null;
  end;
  begin
    perform guest_report('00000000-0000-0000-0000-0000000000a2', current_date, current_date);
    raise exception 'FAIL anon ran guest_report';
  exception when insufficient_privilege then null;
  end;
  perform set_config('role', 'postgres', true);
  raise notice 'PASS anon cannot run the channel or guest report';
end $$;
