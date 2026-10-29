-- search_availability and payment_start_context (migration 014). Reuses t06_hold / t06_expect_err (06)
-- and t08_online (08). The search window is today + 250 for 2 nights, untouched by earlier files.
-- Ids: a3 STD type (5 rooms, max 2 adults), a4 SOLO type (1 room), b2 Hotel B's property.
\set ON_ERROR_STOP on

create function t11_search(p_host text default 'book.hotel-a.test', p_off integer default 250, p_nights integer default 2,
                           p_adults integer default 2, p_children integer default 0) returns jsonb language sql as $$
  select search_availability(p_host, current_date + p_off, current_date + p_off + p_nights, p_adults, p_children)
$$;
create function t11_type(p_result jsonb, p_type uuid) returns jsonb language sql immutable as $$
  select e from jsonb_array_elements(p_result -> 'room_types') e where (e ->> 'room_type_id')::uuid = p_type
$$;

-- 1. Shape, availability counts, and price parity with what create_hold will charge
do $$ declare r jsonb; std jsonb; h jsonb; begin
  r := t11_search();
  std := t11_type(r, '00000000-0000-0000-0000-0000000000a3');
  if std is null or (std ->> 'rooms_available')::int <> 5 or jsonb_array_length(std -> 'nights') <> 2 then raise exception 'FAIL std entry %', std; end if;
  if t11_type(r, '00000000-0000-0000-0000-0000000000a4') is null then raise exception 'FAIL solo missing'; end if;
  if r ->> 'currency' <> 'NGN' or (r ->> 'nights')::int <> 2 or r ->> 'property_name' is null then raise exception 'FAIL header %', r; end if;
  if (std ->> 'total_minor')::bigint <> (std ->> 'subtotal_minor')::bigint + (std ->> 'tax_minor')::bigint then raise exception 'FAIL totals %', std; end if;
  -- the quote equals what a hold on the same stay is charged
  h := t06_hold(p_off => 250, p_nights => 2, p_guest => '{"full_name":"Quote Guest","email":"quote@example.com"}'::jsonb);
  if (h ->> 'total_minor')::bigint <> (std ->> 'total_minor')::bigint or (h ->> 'tax_minor')::bigint <> (std ->> 'tax_minor')::bigint
    then raise exception 'FAIL quote differs from hold: % vs %', std, h; end if;
  -- and the hold now counts against availability
  std := t11_type(t11_search(), '00000000-0000-0000-0000-0000000000a3');
  if (std ->> 'rooms_available')::int <> 4 then raise exception 'FAIL availability after hold %', std; end if;
  raise notice 'PASS availability search: shape, counts, and quotes equal what create_hold charges';
end $$;

-- 2. Expired holds do not block; stays and blocks do
do $$ declare std jsonb; v_room uuid; begin
  update room_inventory_claims set hold_expires_at = now() - interval '1 minute'
   where claim_type = 'hold' and status = 'active' and start_date = current_date + 250;
  std := t11_type(t11_search(), '00000000-0000-0000-0000-0000000000a3');
  if (std ->> 'rooms_available')::int <> 5 then raise exception 'FAIL expired hold still blocks %', std; end if;

  select id into v_room from rooms where room_type_id = '00000000-0000-0000-0000-0000000000a4' limit 1;
  perform claim_room('00000000-0000-0000-0000-0000000000a2', null, v_room, current_date + 251, current_date + 252, 'block', null, null, 'maintenance');
  if t11_type(t11_search(), '00000000-0000-0000-0000-0000000000a4') is not null then raise exception 'FAIL blocked room type still offered'; end if;
  if t11_type(t11_search(p_off => 252), '00000000-0000-0000-0000-0000000000a4') is null then raise exception 'FAIL block spilled past its dates'; end if;
  raise notice 'PASS expired holds free the room; blocks remove the room type for the blocked nights only';
end $$;

-- 3. Filters: party size, public flag, active status
do $$ declare r jsonb; begin
  r := t11_search(p_adults => 3);
  if t11_type(r, '00000000-0000-0000-0000-0000000000a3') is not null then raise exception 'FAIL party larger than the room type offered'; end if;
  update room_types set is_public = false where id = '00000000-0000-0000-0000-0000000000a3';
  if t11_type(t11_search(), '00000000-0000-0000-0000-0000000000a3') is not null then raise exception 'FAIL non-public type offered'; end if;
  update room_types set is_public = true, status = 'inactive' where id = '00000000-0000-0000-0000-0000000000a3';
  if t11_type(t11_search(), '00000000-0000-0000-0000-0000000000a3') is not null then raise exception 'FAIL inactive type offered'; end if;
  update room_types set status = 'active' where id = '00000000-0000-0000-0000-0000000000a3';
  raise notice 'PASS search honours party size, public flag and active status';
end $$;

-- 4. Validation and tenant isolation
do $$ declare r jsonb; e jsonb; begin
  perform t06_expect_err($q$select t11_search(p_off => -1)$q$, 'POLICY_VIOLATION: arrival in the past%');
  perform t06_expect_err($q$select t11_search(p_nights => 31)$q$, 'POLICY_VIOLATION: stay too long%');
  perform t06_expect_err($q$select t11_search(p_nights => 0)$q$, 'POLICY_VIOLATION: departure must follow arrival%');
  perform t06_expect_err($q$select t11_search(p_off => 400)$q$, 'POLICY_VIOLATION: arrival too far ahead%');
  perform t06_expect_err($q$select t11_search(p_adults => 0)$q$, 'POLICY_VIOLATION: party size%');
  perform t06_expect_err($q$select t11_search(p_host => 'nobody.example')$q$, 'NOT_FOUND: host%');
  perform t06_expect_err($q$select t11_search(p_host => 'draft.hotel-a.test')$q$, 'NOT_FOUND: host%');
  if jsonb_typeof(t11_search(p_off => 0, p_nights => 1) -> 'room_types') <> 'array' then raise exception 'FAIL same-day arrival'; end if;
  r := t11_search(p_host => 'hotel-b.test', p_adults => 1);
  for e in select * from jsonb_array_elements(r -> 'room_types') loop
    if not exists (select 1 from room_types where id = (e ->> 'room_type_id')::uuid and property_id = '00000000-0000-0000-0000-0000000000b2')
      then raise exception 'FAIL Hotel B host returned another property''s room type %', e; end if;
  end loop;
  raise notice 'PASS search validation and host isolation';
end $$;

-- 5. Payment start context
do $$ declare v_res uuid; c jsonb; acc uuid; begin
  v_res := t08_online('ctx1', 254, p_attempt => false);
  c := payment_start_context(v_res);
  if c ->> 'guest_email' <> 'ctx1@example.com' or c ->> 'secret_reference' <> 'vault://hotel-a/paystack-test'
     or (c ->> 'booking_reference') not like 'BK-%' or c::text like '%sk_%' then raise exception 'FAIL context %', c; end if;
  select id into acc from payment_provider_accounts where tenant_id = '00000000-0000-0000-0000-0000000000a1';
  update payment_provider_accounts set status = 'disabled' where id = acc;
  perform t06_expect_err(format('select payment_start_context(%L)', v_res), 'INVALID_STATE: no payment provider configured%');
  update payment_provider_accounts set status = 'active' where id = acc;
  perform t06_expect_err(format('select payment_start_context(%L)', gen_random_uuid()), 'NOT_FOUND%');
  raise notice 'PASS payment start context: account pointer and guest email, no secrets';
end $$;

-- 6. Closed to everyone but service_role
begin;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000aa01';
do $$ begin
  begin perform search_availability('book.hotel-a.test', current_date + 10, current_date + 12, 2, 0); raise exception 'FAIL authenticated search';
  exception when insufficient_privilege then null; end;
  begin perform payment_start_context(gen_random_uuid()); raise exception 'FAIL authenticated payment_start_context';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
do $$ begin raise notice 'PASS guest booking lookups are closed to authenticated callers'; end $$;
