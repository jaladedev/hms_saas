-- Promo codes (migration 131). Hotel A: tenant a1, property a2, Standard a3. Owner aa01, front desk aa04, other hotel's owner bb01.
\set ON_ERROR_STOP on

create function t131_hold(p_email text, p_code text default null, p_off integer default 20, p_nights integer default 2, p_key text default null) returns jsonb
language sql as $$
  select create_hold('book.hotel-a.test', current_date + p_off, current_date + p_off + p_nights,
                     '[{"room_type_id":"00000000-0000-0000-0000-0000000000a3","adults":1}]'::jsonb,
                     jsonb_build_object('full_name', 'Promo Guest', 'email', p_email), coalesce(p_key, gen_random_uuid()::text), p_code);
$$;
create function t131_save(p_code text, p_kind text default 'percent', p_value numeric default 10, p_from date default null, p_to date default null,
                          p_min integer default 1, p_max integer default null, p_active boolean default true, p_promo uuid default null) returns jsonb
language sql as $$
  select save_promo_code('00000000-0000-0000-0000-0000000000a2', p_promo, p_code, p_kind, p_value, p_from, p_to, p_min, p_max, p_active);
$$;

-- 1. who may make codes, and what is accepted
do $$ declare v_p constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb; v_id uuid; v_state text; l jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect('select t131_save(''SPRING10'')', 'NOT_FOUND');
  perform t_expect(format('select promo_code_list(%L)', v_p), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect('select t131_save(''SPRING10'')', 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := t131_save(' spring10 ');
  v_id := (r ->> 'promo_id')::uuid;
  if r ->> 'code' <> 'SPRING10' then raise exception 'FAIL code not capitalised: %', r; end if;
  perform t_expect('select t131_save(''SPRING10'')', 'POLICY_VIOLATION: duplicate');
  perform t_expect('select t131_save(''ab'')', 'POLICY_VIOLATION: code');
  perform t_expect('select t131_save(''has space'')', 'POLICY_VIOLATION: code');
  perform t_expect('select t131_save(''BADKIND'', ''free'')', 'POLICY_VIOLATION: kind');
  perform t_expect('select t131_save(''PCT0'', ''percent'', 0)', 'POLICY_VIOLATION: value');
  perform t_expect('select t131_save(''PCT95'', ''percent'', 95)', 'POLICY_VIOLATION: value');
  perform t_expect('select t131_save(''PCT3D'', ''percent'', 5.555)', 'POLICY_VIOLATION: value');
  perform t_expect('select t131_save(''AMTFRAC'', ''amount'', 100.5)', 'POLICY_VIOLATION: value');
  perform t_expect('select t131_save(''DATES'', ''percent'', 5, current_date + 5, current_date + 1)', 'POLICY_VIOLATION: dates');
  perform t_expect('select t131_save(''MINN'', ''percent'', 5, null, null, 0)', 'POLICY_VIOLATION: min nights');
  perform t_expect('select t131_save(''MAXU'', ''percent'', 5, null, null, 1, 0)', 'POLICY_VIOLATION: max uses');
  r := t131_save('ignored', 'percent', 15, null, null, 2, 5, true, v_id);   -- an edit keeps the code
  if r ->> 'code' <> 'SPRING10' then raise exception 'FAIL edit changed the code: %', r; end if;
  l := promo_code_list('00000000-0000-0000-0000-0000000000a2');
  if jsonb_array_length(l) <> 1 or (l -> 0 ->> 'percent')::numeric <> 15 or (l -> 0 ->> 'min_nights')::int <> 2 or (l -> 0 ->> 'remaining')::int <> 5 then raise exception 'FAIL list %', l; end if;
  perform t_expect(format('select save_promo_code(%L, %L, ''X1X'', ''percent'', 5, null, null, 1, null, true)', v_p, gen_random_uuid()), 'NOT_FOUND');
  perform t_sys();
  if not exists (select 1 from audit_logs where entity_id = v_id and action = 'promo_code.saved') then raise exception 'FAIL not audited'; end if;
  begin
    set local role anon;
    perform t131_save('ANONCODE');
    v_state := 'allowed';
  exception when insufficient_privilege then v_state := 'refused';
  end;
  reset role;
  if v_state <> 'refused' then raise exception 'FAIL anon could save a promo code'; end if;
  begin set local role authenticated; perform 1 from promo_codes; reset role; exception when others then reset role; end;
  raise notice 'PASS promo codes: only property.configure makes them, input checked, edits keep the code, audited, anon refused';
end $$;

-- 2. a percentage code takes its share off subtotal + tax; the booking carries the discount
do $$ declare
  a jsonb; b jsonb; v_base bigint; v_d bigint; v_res uuid; r reservations%rowtype; st jsonb; n_before integer; n_after integer; v_id uuid;
begin
  perform t_sys();
  v_id := (select id from promo_codes where code = 'SPRING10');
  update promo_codes set percent = 10, min_nights = 1, max_uses = null where id = v_id;
  a := t131_hold('p-a@example.test');
  v_base := (a ->> 'subtotal_minor')::bigint + (a ->> 'tax_minor')::bigint;
  if (a ->> 'discount_minor')::bigint <> 0 or (a ->> 'promo_code') is not null then raise exception 'FAIL discount without a code: %', a; end if;
  b := t131_hold('p-b@example.test', ' spring10 ', 20);   -- the same nights as the hold above: test 04's Test VAT rule starts on 2027-01-01, so a price can differ between dates either side of it
  v_d := round(v_base * 10 / 100.0)::bigint;
  if (b ->> 'discount_minor')::bigint <> v_d or (b ->> 'total_minor')::bigint <> v_base - v_d or b ->> 'promo_code' <> 'SPRING10' then
    raise exception 'FAIL discount % expected %, response %', b ->> 'discount_minor', v_d, b; end if;
  v_res := (b ->> 'reservation_id')::uuid;
  select * into r from reservations where id = v_res;
  if r.discount_minor <> v_d or r.discount_percent <> 10 or r.discount_amount_minor is not null or r.total_minor <> v_base - v_d
     or r.discount_reason <> 'Promo SPRING10' or r.promo_code_id <> v_id then raise exception 'FAIL reservation fields: %', to_jsonb(r); end if;
  st := guest_booking_status(v_res);
  if (st ->> 'discount_minor')::bigint <> v_d or st ->> 'discount_reason' <> 'Promo SPRING10' or (st ->> 'total_minor')::bigint <> v_base - v_d then raise exception 'FAIL booking status %', st; end if;

  select count(*) into n_before from reservations;
  perform t_expect('select t131_hold(''p-c@example.test'', ''NOPE123'', 60)', 'POLICY_VIOLATION: promo');
  perform t_expect('select t131_hold(''p-c@example.test'', ''bad code!'', 60)', 'POLICY_VIOLATION: promo');
  select count(*) into n_after from reservations;
  if n_after <> n_before then raise exception 'FAIL a bad code left a booking behind'; end if;
  raise notice 'PASS promo codes: percentage off subtotal plus tax, shown on the booking, a wrong code leaves nothing behind';
end $$;

-- 3. a fixed amount, capped at 90 percent; the percent cap on percentage codes too
do $$ declare a jsonb; b jsonb; v_base bigint; begin
  perform t_sys();
  a := t131_hold('p-d@example.test', null, 80);
  v_base := (a ->> 'subtotal_minor')::bigint + (a ->> 'tax_minor')::bigint;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t131_save('FLAT500', 'amount', 50000);
  perform t131_save('HUGE', 'amount', 90000000000);
  perform t_sys();
  b := t131_hold('p-e@example.test', 'flat500', 100);
  if (b ->> 'discount_minor')::bigint <> 50000 or (select discount_amount_minor from reservations where id = (b ->> 'reservation_id')::uuid) <> 50000
     or (select discount_percent from reservations where id = (b ->> 'reservation_id')::uuid) is not null then raise exception 'FAIL amount code %', b; end if;
  b := t131_hold('p-f@example.test', 'HUGE', 80);    -- the same nights as the base hold, for the same reason
  if (b ->> 'discount_minor')::bigint <> (v_base * 90 / 100) or (b ->> 'total_minor')::bigint <= 0 then raise exception 'FAIL 90 percent cap %', b; end if;
  raise notice 'PASS promo codes: fixed amounts work and no booking is ever more than 90 percent off';
end $$;

-- 4. the rules: inactive, window, minimum nights, uses, the discounts flag
do $$ declare v_id uuid; r jsonb; v_first jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_id := (t131_save('RULES', 'percent', 10, null, null, 3, 1) ->> 'promo_id')::uuid;
  perform t_sys();
  perform t_expect('select t131_hold(''r-a@example.test'', ''RULES'', 140, 2)', 'POLICY_VIOLATION: promo');          -- 2 nights, needs 3
  v_first := t131_hold('r-b@example.test', 'RULES', 140, 3);
  if (v_first ->> 'discount_minor')::bigint <= 0 then raise exception 'FAIL 3 nights should work'; end if;
  perform t_expect('select t131_hold(''r-c@example.test'', ''RULES'', 150, 3)', 'POLICY_VIOLATION: promo');          -- the only use is taken
  update reservations set reservation_status = 'expired' where id = (v_first ->> 'reservation_id')::uuid;
  r := t131_hold('r-d@example.test', 'RULES', 150, 3);                                                              -- an expired booking gives its use back
  if (r ->> 'discount_minor')::bigint <= 0 then raise exception 'FAIL use not given back'; end if;

  update promo_codes set max_uses = null, is_active = false where id = v_id;
  perform t_expect('select t131_hold(''r-e@example.test'', ''RULES'', 160, 3)', 'POLICY_VIOLATION: promo');
  update promo_codes set is_active = true, valid_from = property_today('00000000-0000-0000-0000-0000000000a2') + 1 where id = v_id;
  perform t_expect('select t131_hold(''r-e@example.test'', ''RULES'', 160, 3)', 'POLICY_VIOLATION: promo');          -- not yet
  update promo_codes set valid_from = null, valid_to = property_today('00000000-0000-0000-0000-0000000000a2') - 1 where id = v_id;
  perform t_expect('select t131_hold(''r-e@example.test'', ''RULES'', 160, 3)', 'POLICY_VIOLATION: promo');          -- ended
  update promo_codes set valid_to = property_today('00000000-0000-0000-0000-0000000000a2') where id = v_id;
  r := t131_hold('r-e@example.test', 'RULES', 160, 3);                                                              -- the last day counts
  if (r ->> 'discount_minor')::bigint <= 0 then raise exception 'FAIL last day of the window'; end if;

  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values ('00000000-0000-0000-0000-0000000000a1', 'discounts', false);
  perform t_expect('select t131_hold(''r-f@example.test'', ''RULES'', 170, 3)', 'POLICY_VIOLATION: promo');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect('select t131_save(''NEWONE'')', 'POLICY_VIOLATION: discounts off');
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = '00000000-0000-0000-0000-0000000000a1' and feature_key = 'discounts';
  raise notice 'PASS promo codes: inactive, not yet, ended, too few nights, used up and the flag off are all refused; an expired booking gives its use back';
end $$;

-- 5. delete only an unused code; the same key and code replays the same hold
do $$ declare v_unused uuid; v_used uuid; k text := gen_random_uuid()::text; a jsonb; b jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  v_unused := (t131_save('UNUSED1') ->> 'promo_id')::uuid;
  v_used := (select id from promo_codes where code = 'SPRING10');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select delete_promo_code(%L)', v_unused), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select delete_promo_code(%L)', v_used), 'INVALID_STATE: used');
  perform delete_promo_code(v_unused);
  perform t_sys();
  if exists (select 1 from promo_codes where id = v_unused) then raise exception 'FAIL not deleted'; end if;
  if not exists (select 1 from audit_logs where entity_id = v_unused and action = 'promo_code.deleted') then raise exception 'FAIL delete not audited'; end if;
  a := t131_hold('k-a@example.test', 'SPRING10', 180, 2, k);
  b := t131_hold('k-a@example.test', 'SPRING10', 180, 2, k);
  if a is distinct from b then raise exception 'FAIL replay differs: % %', a, b; end if;
  raise notice 'PASS promo codes: unused codes can be deleted, used ones cannot, a retried hold returns the same discount';
end $$;

drop function t131_hold(text, text, integer, integer, text);
drop function t131_save(text, text, numeric, date, date, integer, integer, boolean, uuid);
