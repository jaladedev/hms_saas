-- Photos on places and experiences, and the email when staff answer an experience request (migration 136).
-- Users: aa01 owner A, aa04 front desk A, bb01 owner B. Staff bookings use offsets 1400 and up from today.
\set ON_ERROR_STOP on

do $$ declare
  v_a constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t constant uuid := '00000000-0000-0000-0000-0000000000a1';
  v_today date := property_today('00000000-0000-0000-0000-0000000000a2');
  v_place uuid; v_exp uuid; v_res uuid; v_req uuid; v_req2 uuid; r jsonb; v_u text := '0123abcd-0123-4abc-8abc-0123456789ab';
  v_ok text; v_ok2 text; v_guest uuid; n integer;
begin
  perform t_sys();
  delete from experience_requests where property_id = v_a;
  delete from hotel_experiences where property_id = v_a;
  delete from hotel_places where property_id = v_a;
  delete from room_photo_cleanup;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_place := (save_hotel_place(v_a, null, 'Hall', '', true, 0, 'sights', null) ->> 'place_id')::uuid;
  v_exp := (save_hotel_experience(v_a, null, 'Tour', '', 100000, 'person', true) ->> 'experience_id')::uuid;
  v_ok := v_t || '/' || v_a || '/places/' || v_u || '.jpg';
  v_ok2 := v_t || '/' || v_a || '/experiences/' || v_u || '.webp';

  -- who may set a photo, and which paths are allowed
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select set_place_photo(%L, %L)', v_place, v_ok), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select set_place_photo(%L, %L)', v_place, v_ok), 'NOT_FOUND');
  perform t_expect(format('select set_experience_photo(%L, %L)', v_exp, v_ok2), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin
    perform set_place_photo(v_place, v_t || '/' || v_a || '/logo/' || v_u || '.jpg');
    raise exception 'FAIL wrong folder accepted';
  exception when check_violation then null; end;
  begin
    perform set_place_photo(v_place, '00000000-0000-0000-0000-0000000000b1/00000000-0000-0000-0000-0000000000b2/places/' || v_u || '.jpg');
    raise exception 'FAIL other hotel accepted';
  exception when check_violation then null; end;
  begin
    perform set_experience_photo(v_exp, v_ok);   -- a place path on an experience
    raise exception 'FAIL place path on experience';
  exception when check_violation then null; end;
  perform set_place_photo(v_place, v_ok);
  perform set_experience_photo(v_exp, v_ok2);
  perform t_sys();
  if (select photo_path from hotel_places where id = v_place) <> v_ok then raise exception 'FAIL place photo'; end if;
  if (select count(*) from audit_logs where action in ('hotel_place.photo', 'hotel_experience.photo')) < 2 then raise exception 'FAIL photo audit'; end if;
  set local role service_role;
  r := guest_places('book.hotel-a.test');
  if r -> 'places' -> 0 ->> 'photo' <> v_ok then raise exception 'FAIL guest place photo %', r; end if;
  r := guest_experiences('book.hotel-a.test');
  if r -> 'experiences' -> 0 ->> 'photo' <> v_ok2 then raise exception 'FAIL guest experience photo %', r; end if;
  reset role;

  -- replacing and removing queue the old file; deleting the row queues the current one
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_place_photo(v_place, v_t || '/' || v_a || '/places/11111111-1111-4111-8111-111111111111.png');
  perform t_sys();
  if not exists (select 1 from room_photo_cleanup where path = v_ok) then raise exception 'FAIL replaced file not queued'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform set_place_photo(v_place, '');
  perform t_sys();
  if (select photo_path from hotel_places where id = v_place) is not null then raise exception 'FAIL photo not removed'; end if;
  if not exists (select 1 from room_photo_cleanup where path like '%11111111-1111-4111-8111-111111111111.png') then raise exception 'FAIL removed file not queued'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform delete_hotel_experience(v_exp);   -- unused, so it can go; its photo is queued
  perform t_sys();
  if not exists (select 1 from room_photo_cleanup where path = v_ok2) then raise exception 'FAIL deleted row file not queued'; end if;

  -- emails to the guest
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_exp := (save_hotel_experience(v_a, null, 'Dinner', '', 250000, 'booking', true) ->> 'experience_id')::uuid;
  perform t_sys();
  v_res := (t_book('00000000-0000-0000-0000-0000000000a3', v_today + 1400, v_today + 1402, 'ph-a') ->> 'reservation_id')::uuid;
  update reservations set reservation_status = 'confirmed' where id = v_res;
  select primary_guest_id into v_guest from reservations where id = v_res;
  update guests set email = 'guest-136@example.test' where id = v_guest;
  set local role service_role;
  v_req := (guest_request_experience(v_res, v_exp, 1, null, null) ->> 'request_id')::uuid;
  v_req2 := (guest_request_experience(v_res, v_exp, 2, null, null) ->> 'request_id')::uuid;
  reset role;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform experience_request_set(v_req, 'confirm', 'k');
  perform experience_request_set(v_req, 'confirm', 'k');          -- a repeat sends nothing more
  perform experience_request_set(v_req2, 'decline', 'k');
  perform t_sys();
  select count(*) into n from email_outbox where kind = 'experience_answered' and reservation_id = v_res;
  if n <> 2 then raise exception 'FAIL expected 2 answer emails, got %', n; end if;
  if (select payload ->> 'answer' from email_outbox where kind = 'experience_answered' and dedupe_key = 'exp:' || v_req || ':confirm') <> 'confirmed' then raise exception 'FAIL confirm payload'; end if;
  if (select (payload ->> 'total_minor')::bigint from email_outbox where kind = 'experience_answered' and dedupe_key = 'exp:' || v_req2 || ':decline') <> 250000 then raise exception 'FAIL total'; end if;
  if (select to_email from email_outbox where kind = 'experience_answered' and dedupe_key = 'exp:' || v_req || ':confirm') <> 'guest-136@example.test' then raise exception 'FAIL recipient'; end if;
  -- no guest email: nothing queued, and the answer still works
  update guests set email = null where id = v_guest;
  set local role service_role;
  v_req := (guest_request_experience(v_res, v_exp, 1, null, null) ->> 'request_id')::uuid;
  reset role;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform experience_request_set(v_req, 'decline', 'k');
  perform t_sys();
  select count(*) into n from email_outbox where kind = 'experience_answered' and reservation_id = v_res;
  if n <> 2 then raise exception 'FAIL email without address'; end if;
  raise notice 'PASS experience photos and emails: path checks, permissions, cleanup queue, guest photo, answer emails once, none without an address';
end $$;
