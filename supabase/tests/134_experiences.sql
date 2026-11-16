-- Experiences (migration 134): place category and link, bookable experiences, guest requests, staff handling.
-- Reuses t_as / t_sys / t_expect / t_book (05). Hosts from 06. Users: aa01 owner A, aa04 front desk A, aa02 housekeeping A, bb01 owner of Hotel B.
-- Staff bookings use offsets 1300 and up from today.
\set ON_ERROR_STOP on

do $$ declare
  v_a constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_b constant uuid := '00000000-0000-0000-0000-0000000000b2';
  r jsonb; v_id uuid; v_exp uuid; v_exp2 uuid; v_res uuid; v_res2 uuid; v_req uuid; v_req2 uuid; v_res3 uuid; v_today date := property_today('00000000-0000-0000-0000-0000000000a2');
begin
  perform t_sys();
  delete from experience_requests where property_id in (v_a, v_b);
  delete from hotel_experiences where property_id in (v_a, v_b);
  delete from hotel_places where property_id in (v_a, v_b);

  -- places: category and link
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select save_hotel_place(%L, null, ''A'', '''', true, 0, ''museum'', null)', v_a), 'POLICY_VIOLATION: category');
  perform t_expect(format('select save_hotel_place(%L, null, ''A'', '''', true, 0, ''sights'', ''http://x.test'')', v_a), 'POLICY_VIOLATION: link');
  perform t_expect(format('select save_hotel_place(%L, null, ''A'', '''', true, 0, ''sights'', ''javascript:alert(1)'')', v_a), 'POLICY_VIOLATION: link');
  perform t_expect(format('select save_hotel_place(%L, null, ''A'', '''', true, 0, ''sights'', ''https://x.test/a b'')', v_a), 'POLICY_VIOLATION: link');
  perform t_expect(format('select save_hotel_place(%L, null, ''A'', '''', true, 0, ''sights'', %L)', v_a, 'https://x.test/' || repeat('a', 200)), 'POLICY_VIOLATION: link');
  perform save_hotel_place(v_a, null, 'Mapo Hall', 'Hall', true, 1, 'sights', ' https://example.test/mapo ');
  perform save_hotel_place(v_a, null, 'Cafe', 'Coffee', true, 2, 'dining', '');
  perform save_hotel_place(v_a, null, 'Plain', '', true, 3);
  perform t_sys();
  set local role service_role;
  r := guest_places('book.hotel-a.test');
  reset role;
  if r -> 'places' -> 0 ->> 'link' <> 'https://example.test/mapo' or r -> 'places' -> 0 ->> 'category' <> 'sights' then raise exception 'FAIL place link/category %', r; end if;
  if r -> 'places' -> 1 ->> 'link' is not null or r -> 'places' -> 2 ->> 'category' <> 'other' then raise exception 'FAIL place defaults %', r; end if;

  -- experiences: who may write, validation, limit
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select save_hotel_experience(%L, null, ''City tour'', '''', 500000, ''person'', true)', v_a), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select save_hotel_experience(%L, null, ''City tour'', '''', 500000, ''person'', true)', v_a), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select save_hotel_experience(%L, null, ''  '', '''', 500000, ''person'', true)', v_a), 'POLICY_VIOLATION: name');
  perform t_expect(format('select save_hotel_experience(%L, null, ''T'', %L, 500000, ''person'', true)', v_a, repeat('x', 201)), 'POLICY_VIOLATION: text');
  perform t_expect(format('select save_hotel_experience(%L, null, ''T'', '''', 0, ''person'', true)', v_a), 'POLICY_VIOLATION: price');
  perform t_expect(format('select save_hotel_experience(%L, null, ''T'', '''', 500000, ''group'', true)', v_a), 'POLICY_VIOLATION: unit');
  r := save_hotel_experience(v_a, null, ' City tour ', ' Half day ', 500000, 'person', true, 1);
  v_exp := (r ->> 'experience_id')::uuid;
  r := save_hotel_experience(v_a, null, 'Airport pickup', '', 800000, 'booking', true, 2);
  v_exp2 := (r ->> 'experience_id')::uuid;
  perform save_hotel_experience(v_a, null, 'Hidden', '', 100, 'person', false, 3);
  perform t_sys();
  if (select name || '|' || body from hotel_experiences where id = v_exp) <> 'City tour|Half day' then raise exception 'FAIL not trimmed'; end if;
  if (select count(*) from audit_logs where action = 'hotel_experience.saved') < 3 then raise exception 'FAIL audit'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select save_hotel_experience(%L, %L, ''X'', '''', 1, ''person'', true)', v_b, v_exp), 'NOT_FOUND');
  perform t_expect(format('select delete_hotel_experience(%L)', v_exp), 'NOT_FOUND');

  -- guest list: switched on only, nothing internal
  perform t_sys();
  set local role service_role;
  r := guest_experiences('book.hotel-a.test');
  reset role;
  if jsonb_array_length(r -> 'experiences') <> 2 or r::text ~* 'Hidden|tenant|property' then raise exception 'FAIL guest list %', r; end if;
  set local role service_role;
  if jsonb_array_length(guest_experiences('hotel-b.test') -> 'experiences') <> 0 then raise exception 'FAIL hotel B sees A'; end if;
  reset role;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin
    perform guest_experiences('book.hotel-a.test');
    raise exception 'FAIL a login ran a guest function';
  exception when insufficient_privilege then null;
  end;

  -- guest requests
  perform t_sys();
  v_res := (t_book('00000000-0000-0000-0000-0000000000a3', v_today + 1300, v_today + 1303, 'ex-a') ->> 'reservation_id')::uuid;
  v_res2 := (t_book('00000000-0000-0000-0000-0000000000a3', v_today + 1310, v_today + 1312, 'ex-b') ->> 'reservation_id')::uuid;
  update reservations set reservation_status = 'confirmed' where id in (v_res, v_res2) and reservation_status = 'pending';
  set local role service_role;
  perform t_expect(format('select guest_request_experience(%L, %L, 0, null, null)', v_res, v_exp), 'POLICY_VIOLATION: experience quantity');
  perform t_expect(format('select guest_request_experience(%L, %L, 21, null, null)', v_res, v_exp), 'POLICY_VIOLATION: experience quantity');
  perform t_expect(format('select guest_request_experience(%L, %L, 2, %L, null)', v_res, v_exp, v_today + 1303), 'POLICY_VIOLATION: experience date');
  perform t_expect(format('select guest_request_experience(%L, %L, 2, %L, null)', v_res, v_exp, v_today + 1299), 'POLICY_VIOLATION: experience date');
  perform t_expect(format('select guest_request_experience(%L, %L, 2, null, %L)', v_res, v_exp, repeat('x', 201)), 'POLICY_VIOLATION: experience note');
  perform t_expect(format('select guest_request_experience(%L, gen_random_uuid(), 2, null, null)', v_res), 'NOT_FOUND: experience');
  perform t_expect(format('select guest_request_experience(%L, (select id from hotel_experiences where name = ''Hidden''), 2, null, null)', v_res), 'NOT_FOUND: experience');
  r := guest_request_experience(v_res, v_exp, 2, (v_today + 1301), ' vegetarian ');
  v_req := (r ->> 'request_id')::uuid;
  r := guest_request_experience(v_res, v_exp2, 1, null, null);
  v_req2 := (r ->> 'request_id')::uuid;
  reset role;
  if (select unit_price_minor || '|' || name_at_request || '|' || note from experience_requests where id = v_req) <> '500000|City tour|vegetarian' then raise exception 'FAIL request row'; end if;
  -- a later price change does not alter the request
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform save_hotel_experience(v_a, v_exp, 'City tour', 'Half day', 900000, 'person', true, 1);
  perform t_sys();
  if (select unit_price_minor from experience_requests where id = v_req) <> 500000 then raise exception 'FAIL price snapshot'; end if;
  set local role service_role;
  r := guest_experience_requests(v_res);
  reset role;
  if jsonb_array_length(r -> 'requests') <> 2 or (r -> 'requests' -> 0 ->> 'total_minor')::bigint <> 1000000 or (r -> 'requests' -> 1 ->> 'total_minor')::bigint <> 800000 then raise exception 'FAIL guest requests %', r; end if;
  -- five open requests at most
  set local role service_role;
  perform guest_request_experience(v_res, v_exp, 1, null, null);
  perform guest_request_experience(v_res, v_exp, 1, null, null);
  perform guest_request_experience(v_res, v_exp, 1, null, null);
  perform t_expect(format('select guest_request_experience(%L, %L, 1, null, null)', v_res, v_exp), 'POLICY_VIOLATION: experience limit');
  reset role;
  -- a cancelled booking cannot ask
  update reservations set reservation_status = 'cancelled', cancelled_at = now() where id = v_res2;
  set local role service_role;
  perform t_expect(format('select guest_request_experience(%L, %L, 1, null, null)', v_res2, v_exp), 'INVALID_STATE');
  reset role;

  -- staff queue
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select experience_requests_open(%L)', v_a), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select experience_requests_open(%L)', v_a), 'NOT_FOUND');
  perform t_expect(format('select experience_request_set(%L, ''confirm'', ''k'')', v_req), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := experience_requests_open(v_a);
  if jsonb_array_length(r -> 'requests') <> 5 then raise exception 'FAIL open count %', r; end if;
  perform t_expect(format('select experience_request_set(%L, ''nope'', ''k'')', v_req), 'POLICY_VIOLATION: action');
  perform t_expect(format('select experience_request_set(%L, ''charge'', ''k'')', v_req), 'INVALID_STATE');   -- not confirmed yet
  if experience_request_set(v_req, 'confirm', 'k') ->> 'status' <> 'confirmed' then raise exception 'FAIL confirm'; end if;
  if experience_request_set(v_req, 'confirm', 'k') ->> 'status' <> 'confirmed' then raise exception 'FAIL confirm repeat'; end if;
  perform t_expect(format('select experience_request_set(%L, ''charge'', ''k'')', v_req), 'INVALID_STATE');   -- guest not in the house
  if experience_request_set(v_req2, 'decline', 'k') ->> 'status' <> 'declined' then raise exception 'FAIL decline'; end if;
  perform t_expect(format('select experience_request_set(%L, ''confirm'', ''k'')', v_req2), 'INVALID_STATE');
  perform t_sys();
  if (select count(*) from audit_logs where action in ('experience.confirmed', 'experience.declined')) < 2 then raise exception 'FAIL audit staff'; end if;

  -- the guest is in the house: the charge lands on the folio once
  v_res3 := (t_book('00000000-0000-0000-0000-0000000000a3', v_today, v_today + 2, 'ex-c') ->> 'reservation_id')::uuid;
  update reservations set reservation_status = 'confirmed' where id = v_res3;
  set local role service_role;
  v_req := (guest_request_experience(v_res3, v_exp, 2, null, null) ->> 'request_id')::uuid;
  reset role;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform experience_request_set(v_req, 'confirm', 'k');
  perform t_sys();
  update reservations set reservation_status = 'checked_in' where id = v_res3;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := experience_request_set(v_req, 'charge', 'k');
  if r ->> 'status' <> 'charged' then raise exception 'FAIL charge %', r; end if;
  if experience_request_set(v_req, 'charge', 'k2') ->> 'status' <> 'charged' then raise exception 'FAIL charge repeat'; end if;
  perform t_sys();
  if (select count(*) from folio_charges where reservation_id = v_res3) <> 1 then raise exception 'FAIL charge count'; end if;
  if (select quantity || '|' || unit_amount_minor || '|' || description from folio_charges where reservation_id = v_res3) <> '2|900000|Experience: City tour' then raise exception 'FAIL charge row'; end if;
  if (select folio_charge_id from experience_requests where id = v_req) is null then raise exception 'FAIL charge link'; end if;

  -- delete: used ones refuse, unused ones go
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select delete_hotel_experience(%L)', v_exp), 'INVALID_STATE: used');
  v_id := (save_hotel_experience(v_a, null, 'Temp', '', 100, 'person', true) ->> 'experience_id')::uuid;
  perform delete_hotel_experience(v_id);
  perform t_sys();
  if exists (select 1 from hotel_experiences where id = v_id) or not exists (select 1 from audit_logs where action = 'hotel_experience.deleted' and entity_id = v_id) then raise exception 'FAIL delete'; end if;
  raise notice 'PASS experiences: place category and link, experience setup, guest requests, queue, confirm, decline, charge once, price snapshot, limits';
end $$;
