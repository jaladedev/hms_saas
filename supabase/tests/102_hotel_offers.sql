-- Hotel offers (migration 102). Reuses t_as / t_sys / t_expect (05). Hosts from 06: book.hotel-a.test, hotel-b.test, draft.hotel-a.test.
-- Users: aa01 owner, aa04 front desk, bb01 owner of Hotel B.
\set ON_ERROR_STOP on

do $$ declare
  v_a constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_b constant uuid := '00000000-0000-0000-0000-0000000000b2';
  r jsonb; v_id uuid; v_today date := property_today('00000000-0000-0000-0000-0000000000a2'); v_n integer;
begin
  perform t_sys();
  delete from hotel_offers where property_id in (v_a, v_b);

  -- who may write
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select save_hotel_offer(%L, null, ''Weekend'', '''', null, null, null, true)', v_a), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select save_hotel_offer(%L, null, ''Weekend'', '''', null, null, null, true)', v_a), 'NOT_FOUND');

  -- validation
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select save_hotel_offer(%L, null, ''   '', '''', null, null, null, true)', v_a), 'POLICY_VIOLATION: title');
  perform t_expect(format('select save_hotel_offer(%L, null, %L, '''', null, null, null, true)', v_a, repeat('x', 81)), 'POLICY_VIOLATION: title');
  perform t_expect(format('select save_hotel_offer(%L, null, ''A'', %L, null, null, null, true)', v_a, repeat('x', 301)), 'POLICY_VIOLATION: text');
  perform t_expect(format('select save_hotel_offer(%L, null, ''A'', '''', %L, null, null, true)', v_a, repeat('x', 25)), 'POLICY_VIOLATION: badge');
  perform t_expect(format('select save_hotel_offer(%L, null, ''A'', '''', null, %L, %L, true)', v_a, v_today + 5, v_today + 1), 'POLICY_VIOLATION: dates');

  -- create, edit, audit
  r := save_hotel_offer(v_a, null, '  Weekend escape ', 'Two nights, breakfast on us', ' 10% off ', null, null, true);
  v_id := (r ->> 'offer_id')::uuid;
  perform t_sys();
  if (select title || '|' || badge from hotel_offers where id = v_id) <> 'Weekend escape|10% off' then raise exception 'FAIL not trimmed'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform save_hotel_offer(v_a, v_id, 'Weekend escape', 'Updated text', null, null, null, true);
  perform t_sys();
  if (select body from hotel_offers where id = v_id) <> 'Updated text' or (select badge from hotel_offers where id = v_id) is not null then raise exception 'FAIL edit'; end if;
  if (select count(*) from audit_logs where action = 'hotel_offer.saved' and entity_id = v_id) <> 2 then raise exception 'FAIL audit'; end if;
  -- an offer of another hotel cannot be edited through this one
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select save_hotel_offer(%L, %L, ''X'', '''', null, null, null, true)', v_b, v_id), 'NOT_FOUND');
  perform t_expect(format('select delete_hotel_offer(%L)', v_id), 'NOT_FOUND');
  raise notice 'PASS hotel offers: permissions, validation, trimmed, edited, audited, other hotel refused';
end $$;

do $$ declare
  v_a constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb; v_today date := property_today('00000000-0000-0000-0000-0000000000a2'); v_id uuid; v_n integer;
begin
  perform t_sys();
  delete from hotel_offers where property_id = v_a;
  insert into hotel_offers (tenant_id, property_id, title, body, badge, valid_from, valid_to, is_active, sort_order) values
    ('00000000-0000-0000-0000-0000000000a1', v_a, 'Live', 'b', null, null, null, true, 2),
    ('00000000-0000-0000-0000-0000000000a1', v_a, 'Live dated', 'b', 'Sale', v_today - 1, v_today + 1, true, 1),
    ('00000000-0000-0000-0000-0000000000a1', v_a, 'Off', 'b', null, null, null, false, 0),
    ('00000000-0000-0000-0000-0000000000a1', v_a, 'Ended', 'b', null, v_today - 9, v_today - 1, true, 0),
    ('00000000-0000-0000-0000-0000000000a1', v_a, 'Future', 'b', null, v_today + 1, v_today + 9, true, 0);
  r := guest_offers('book.hotel-a.test');
  if jsonb_array_length(r -> 'offers') <> 2 or r -> 'offers' -> 0 ->> 'title' <> 'Live dated' or r -> 'offers' -> 1 ->> 'title' <> 'Live' then raise exception 'FAIL live offers %', r; end if;
  if (select count(*) from jsonb_object_keys(r -> 'offers' -> 0)) <> 4 or r::text like '%00000000-0000-0000-0000-0000000000a%' then raise exception 'FAIL keys or ids %', r; end if;
  -- scoped to the host
  if jsonb_array_length(guest_offers('hotel-b.test') -> 'offers') <> 0 then raise exception 'FAIL other hotel sees offers'; end if;
  begin perform guest_offers('draft.hotel-a.test'); raise exception 'FAIL unverified host'; exception when sqlstate 'P0001' then null; end;
  begin perform guest_offers('nowhere.test'); raise exception 'FAIL unknown host'; exception when sqlstate 'P0001' then null; end;
  -- at most 6, and the 12 limit
  delete from hotel_offers where property_id = v_a;
  insert into hotel_offers (tenant_id, property_id, title) select '00000000-0000-0000-0000-0000000000a1', v_a, 'O' || g from generate_series(1, 12) g;
  if jsonb_array_length(guest_offers('book.hotel-a.test') -> 'offers') <> 6 then raise exception 'FAIL more than 6 shown'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select save_hotel_offer(%L, null, ''One more'', '''', null, null, null, true)', v_a), 'POLICY_VIOLATION: limit');
  -- delete, audited
  perform t_sys();
  select id into v_id from hotel_offers where property_id = v_a limit 1;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform delete_hotel_offer(v_id);
  perform t_sys();
  if (select count(*) from hotel_offers where id = v_id) <> 0 or (select count(*) from audit_logs where action = 'hotel_offer.deleted' and entity_id = v_id) <> 1 then raise exception 'FAIL delete'; end if;
  delete from hotel_offers where property_id = v_a;
  raise notice 'PASS guest_offers: only live offers in their window, scoped to the host, no ids, six at most; limit and delete work';
end $$;

-- direct writes and the guest function are closed to signed-in users and anon
do $$ declare v_state text; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin insert into hotel_offers (tenant_id, property_id, title) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'x'); v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused'; end;
  if v_state <> 'refused' then raise exception 'FAIL direct insert allowed'; end if;
  begin perform guest_offers('book.hotel-a.test'); v_state := 'allowed'; exception when insufficient_privilege then v_state := 'refused'; end;
  if v_state <> 'refused' then raise exception 'FAIL owner could call guest_offers'; end if;
  perform t_sys();
  begin set local role anon; perform save_hotel_offer(gen_random_uuid(), null, 'x', '', null, null, null, true); v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused'; end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could save an offer'; end if;
  raise notice 'PASS hotel offers: direct writes, guest_offers for users, and anon are refused';
end $$;
