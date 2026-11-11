-- Guest reviews (migration 104). Reuses t_as / t_sys / t_expect (05), t07_res (07). Hosts: book.hotel-a.test, hotel-b.test, draft.hotel-a.test.
-- Users: aa01 owner, aa04 front desk, bb01 owner of Hotel B. Date offsets 3200 and up.
\set ON_ERROR_STOP on

do $$ declare
  res uuid; res2 uuid; v_guest uuid; r jsonb; v_id uuid;
begin
  perform t_sys();
  delete from guest_reviews where property_id in ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b2');
  res := t07_res(3200, 2, 't104-book-1');
  select primary_guest_id into v_guest from reservations where id = res;
  update guests set full_name = 'Ada Ngozi Okafor' where id = v_guest;

  -- not stayed yet
  r := guest_review_state(res);
  if (r ->> 'can_review')::boolean is not false or r -> 'review' <> 'null'::jsonb then raise exception 'FAIL reviewable before the stay %', r; end if;
  perform t_expect(format('select submit_guest_review(%L, 5, ''Lovely'')', res), 'INVALID_STATE: not stayed');

  update reservations set reservation_status = 'checked_out' where id = res;
  if (guest_review_state(res) ->> 'can_review')::boolean is not true then raise exception 'FAIL not reviewable after check-out'; end if;
  perform t_expect(format('select submit_guest_review(%L, 0, ''x'')', res), 'POLICY_VIOLATION: rating');
  perform t_expect(format('select submit_guest_review(%L, 6, ''x'')', res), 'POLICY_VIOLATION: rating');
  perform t_expect(format('select submit_guest_review(%L, null, ''x'')', res), 'POLICY_VIOLATION: rating');
  perform t_expect(format('select submit_guest_review(%L, 5, %L)', res, repeat('x', 1001)), 'POLICY_VIOLATION: comment');
  perform t_expect(format('select submit_guest_review(%L, 5, ''x'')', gen_random_uuid()), 'NOT_FOUND');

  r := submit_guest_review(res, 5, '  Lovely stay  ');
  v_id := (r ->> 'review_id')::uuid;
  if (select author || '|' || comment || '|' || status || '|' || rating from guest_reviews where id = v_id) <> 'Ada O.|Lovely stay|pending|5' then
    raise exception 'FAIL stored review %', (select row_to_json(g) from guest_reviews g where id = v_id); end if;
  perform t_expect(format('select submit_guest_review(%L, 4, ''again'')', res), 'CONFLICT: reviewed');
  r := guest_review_state(res);
  if (r ->> 'can_review')::boolean is not false or r -> 'review' ->> 'status' <> 'pending' then raise exception 'FAIL state after review %', r; end if;
  raise notice 'PASS guest reviews: only after check-out, validated, once per booking, author is first name and last initial, starts pending';
end $$;

do $$ declare
  v_a constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_id uuid; r jsonb;
begin
  perform t_sys();
  select id into v_id from guest_reviews where property_id = v_a limit 1;

  -- public list shows nothing until approved
  if (guest_reviews_public('book.hotel-a.test') ->> 'count')::int <> 0 or jsonb_array_length(guest_reviews_public('book.hotel-a.test') -> 'reviews') <> 0 then raise exception 'FAIL a pending review is public'; end if;

  -- who may moderate
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select moderate_guest_review(%L, ''approved'')', v_id), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select moderate_guest_review(%L, ''approved'')', v_id), 'NOT_FOUND');
  perform t_expect(format('select moderate_guest_review(%L, ''approved'')', gen_random_uuid()), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select moderate_guest_review(%L, ''pending'')', v_id), 'POLICY_VIOLATION: decision');
  perform t_expect(format('select moderate_guest_review(%L, null)', v_id), 'POLICY_VIOLATION: decision');

  r := moderate_guest_review(v_id, 'approved');
  if (r ->> 'changed')::boolean is not true then raise exception 'FAIL approve %', r; end if;
  if (moderate_guest_review(v_id, 'approved') ->> 'changed')::boolean is not false then raise exception 'FAIL repeat should change nothing'; end if;
  perform t_sys();
  if (select count(*) from audit_logs where action = 'guest_review.moderated' and entity_id = v_id) <> 1 then raise exception 'FAIL audit once per change'; end if;
  r := guest_reviews_public('book.hotel-a.test');
  if (r ->> 'count')::int <> 1 or (r ->> 'average')::numeric <> 5.0 or r -> 'reviews' -> 0 ->> 'author' <> 'Ada O.' or r -> 'reviews' -> 0 ->> 'comment' <> 'Lovely stay' then raise exception 'FAIL public list %', r; end if;
  if (select count(*) from jsonb_object_keys(r -> 'reviews' -> 0)) <> 4 or r::text like '%00000000-0000-0000-0000-0000000000a%' or r::text like '%Okafor%' then raise exception 'FAIL keys, ids or full name leaked %', r; end if;
  -- scoped to the host
  if (guest_reviews_public('hotel-b.test') ->> 'count')::int <> 0 then raise exception 'FAIL other hotel sees the review'; end if;
  begin perform guest_reviews_public('draft.hotel-a.test'); raise exception 'FAIL unverified host'; exception when sqlstate 'P0001' then null; end;
  -- reject takes it down again
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform moderate_guest_review(v_id, 'rejected');
  perform t_sys();
  if (guest_reviews_public('book.hotel-a.test') ->> 'count')::int <> 0 then raise exception 'FAIL rejected review still public'; end if;
  raise notice 'PASS guest reviews: moderation permissions, audit, public only when approved, no ids or full name, scoped to the host';
end $$;

do $$ declare v_state text; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin insert into guest_reviews (tenant_id, property_id, reservation_id, rating, author) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', gen_random_uuid(), 5, 'x'); v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused'; end;
  if v_state <> 'refused' then raise exception 'FAIL direct insert allowed'; end if;
  begin perform submit_guest_review(gen_random_uuid(), 5, 'x'); v_state := 'allowed'; exception when insufficient_privilege then v_state := 'refused'; end;
  if v_state <> 'refused' then raise exception 'FAIL a signed-in user could submit a review directly'; end if;
  begin perform guest_reviews_public('book.hotel-a.test'); v_state := 'allowed'; exception when insufficient_privilege then v_state := 'refused'; end;
  if v_state <> 'refused' then raise exception 'FAIL a signed-in user could read the public list function'; end if;
  perform t_sys();
  begin set local role anon; perform moderate_guest_review(gen_random_uuid(), 'approved'); v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused'; end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could moderate'; end if;
  delete from guest_reviews where property_id = '00000000-0000-0000-0000-0000000000a2';
  raise notice 'PASS guest reviews: direct writes, guest functions for users, and anon moderation are refused';
end $$;
