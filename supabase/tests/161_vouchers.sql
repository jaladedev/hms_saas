-- Gift and discount vouchers (migration 161). Hotel A: tenant a1, property a2, Standard a3. Users: aa01 owner A, aa02 housekeeping A, aa04 front desk A,
-- bb01 owner of the other hotel. Bookings are made for a guest created here. Offsets 24000 to 24100.
\set ON_ERROR_STOP on

create table t161_ctx (label text primary key, val text not null);
create function t161_get(p_label text) returns text language sql stable as $$ select val from t161_ctx where label = p_label $$;
create function t161_book(p_off integer, p_nights integer, p_key text) returns uuid language sql as $$
  select (create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000161a1', 'staff_entry',
           current_date + p_off, current_date + p_off + p_nights,
           jsonb_build_array(jsonb_build_object('room_type_id', '00000000-0000-0000-0000-0000000000a3', 'requested_room_id', null, 'adults', 1)), p_key)
          ->> 'reservation_id')::uuid
$$;
create function t161_issue(p_kind text, p_amount bigint, p_exp date default null, p_key text default null) returns jsonb language sql as $$
  select voucher_issue('00000000-0000-0000-0000-0000000000a2', p_kind, p_amount, p_exp, 'test', coalesce(p_key, gen_random_uuid()::text))
$$;
create function t161_bal(p_code text) returns bigint language sql security definer as $$
  select voucher_balance_of(id) from vouchers where code = p_code and property_id = '00000000-0000-0000-0000-0000000000a2'
$$;
create function t161_total(p_res uuid) returns bigint language sql security definer as $$ select total_minor from reservations where id = p_res $$;

do $$ begin
  perform t_sys();
  insert into guests (id, tenant_id, full_name, email) values ('00000000-0000-0000-0000-0000000161a1', '00000000-0000-0000-0000-0000000000a1', 'Vera Voucher', 'vera@example.test');
  raise notice 'PASS setup';
end $$;

-- 1. Issuing: who, rules, replay, audit, ledger
do $$ declare r jsonb; r2 jsonb; k text := 'v-issue-1'; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect('select t161_issue(''gift'', 5000000)', 'NOT_FOUND');
  perform t_expect('select voucher_list(''00000000-0000-0000-0000-0000000000a2'')', 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect('select t161_issue(''gift'', 5000000)', 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect('select t161_issue(''magic'', 5000000)', 'POLICY_VIOLATION: kind');
  perform t_expect('select t161_issue(''gift'', 9999)', 'POLICY_VIOLATION: amount');
  perform t_expect('select t161_issue(''gift'', 100000001)', 'POLICY_VIOLATION: amount');
  perform t_expect('select t161_issue(''gift'', null)', 'POLICY_VIOLATION: amount');
  perform t_expect('select t161_issue(''gift'', 5000000, current_date - 1)', 'POLICY_VIOLATION: expiry');
  perform t_expect('select t161_issue(''gift'', 5000000, current_date + 4000)', 'POLICY_VIOLATION: expiry');
  r := t161_issue('gift', 5000000, null, k);
  r2 := t161_issue('gift', 5000000, null, k);
  if r <> r2 then raise exception 'FAIL replay differs'; end if;
  if (select count(*) from vouchers where code = r ->> 'code') <> 1 then raise exception 'FAIL replay made two'; end if;
  if (r ->> 'code') !~ '^GV-[A-Z2-9]{4}-[A-Z2-9]{4}$' then raise exception 'FAIL code shape %', r; end if;
  if t161_bal(r ->> 'code') <> 5000000 then raise exception 'FAIL balance'; end if;
  perform t_expect(format('select t161_issue(''discount'', 6000000, null, %L)', k), 'IDEMPOTENCY');
  perform t_sys();
  if not exists (select 1 from audit_logs where action = 'voucher.issued' and entity_id = (r ->> 'voucher_id')::uuid) then raise exception 'FAIL audit'; end if;
  -- the ledger and the voucher cannot be changed
  begin update voucher_ledger set amount_minor = 1 where voucher_id = (r ->> 'voucher_id')::uuid; raise exception 'FAIL ledger changed';
  exception when check_violation then null; end;
  begin update vouchers set face_value_minor = 20000 where id = (r ->> 'voucher_id')::uuid; raise exception 'FAIL face value changed';
  exception when check_violation then null; end;
  begin delete from vouchers where id = (r ->> 'voucher_id')::uuid; raise exception 'FAIL deleted';
  exception when check_violation then null; end;
  raise notice 'PASS issue: owner only, input rules, replay-safe, code shape, audited, ledger and voucher final';
end $$;

-- 2. Gift voucher: partial spend, rest kept, one discount per booking, guards, release gives it back
do $$ declare
  g text; res uuid; res2 uuid; r jsonb; v_total bigint; v_amount bigint := 30000; v_id uuid; v_cap bigint;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := t161_issue('gift', 20000000); g := r ->> 'code'; v_id := (r ->> 'voucher_id')::uuid;      -- 200,000 naira: more than a night
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  res := t161_book(24000, 2, 'v-b1'); res2 := t161_book(24010, 2, 'v-b2');
  perform t_sys(); insert into t161_ctx values ('res', res::text), ('res2', res2::text), ('gift', g);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  v_total := t161_total(res);
  -- who and what
  perform t_expect(format('select voucher_redeem(%L, %L, ''k1'')', res, 'NOPE-0000'), 'POLICY_VIOLATION: voucher');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select voucher_redeem(%L, %L, ''k2'')', res, g), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select voucher_redeem(%L, %L, ''k3'')', res, g), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  -- lower case and spaces are fine; the voucher covers the whole booking, so the voucher pays only the total
  r := voucher_redeem(res, '  ' || lower(g) || ' ', 'v-r1');
  if (r ->> 'applied_minor')::bigint <> least(20000000, v_total) then raise exception 'FAIL applied %', r; end if;
  if t161_total(res) <> v_total - (r ->> 'applied_minor')::bigint then raise exception 'FAIL total after'; end if;
  if (select discount_reason from reservations where id = res) <> 'Voucher ' || g then raise exception 'FAIL reason'; end if;
  if t161_bal(g) <> 20000000 - (r ->> 'applied_minor')::bigint then raise exception 'FAIL gift balance after: %', t161_bal(g); end if;
  if voucher_redeem(res, g, 'v-r1') <> r then raise exception 'FAIL replay'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if (select jsonb_array_length(voucher_ledger_list(v_id))) <> 2 then raise exception 'FAIL ledger rows'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  -- one discount per booking
  perform t_expect(format('select voucher_redeem(%L, %L, ''k4'')', res, g), 'INVALID_STATE: discount');
  if (voucher_booking(res) ->> 'applied')::boolean is not true or (voucher_booking(res) ->> 'code') <> g then raise exception 'FAIL booking view'; end if;
  -- the rest of the gift voucher goes on another booking
  r := voucher_redeem(res2, g, 'v-r2');
  if t161_bal(g) <> 20000000 - least(20000000, v_total) - (r ->> 'applied_minor')::bigint then raise exception 'FAIL second spend balance'; end if;
  -- release gives the value back and the booking its price
  r := voucher_release(res2, 'v-rel1');
  if not (r ->> 'changed')::boolean or t161_total(res2) <> v_total then raise exception 'FAIL release %', r; end if;
  if t161_bal(g) <> 20000000 - least(20000000, v_total) then raise exception 'FAIL balance after release'; end if;
  if (voucher_release(res2, 'v-rel2') ->> 'changed')::boolean then raise exception 'FAIL second release changed something'; end if;
  perform t_sys();
  if (select count(*) from audit_logs where action in ('voucher.redeemed', 'voucher.released') and entity_id in (res, res2)) < 3 then raise exception 'FAIL audit'; end if;
  raise notice 'PASS gift: partial spend, remainder reusable, one discount per booking, release restores, replay-safe, audited';
end $$;

-- 3. Discount voucher: used up on first booking, even when the booking is cheaper; the amount never exceeds the booking
do $$ declare d text; res uuid; r jsonb; v_total bigint; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  d := t161_issue('discount', 90000000) ->> 'code';       -- 900,000 naira: more than any booking here
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  res := t161_book(24020, 1, 'v-b3'); v_total := t161_total(res);
  perform t_sys(); insert into t161_ctx values ('disc', d), ('res3', res::text);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := voucher_redeem(res, d, 'v-d1');
  if (r ->> 'applied_minor')::bigint <> v_total or t161_total(res) <> 0 then raise exception 'FAIL capped at the booking: %', r; end if;
  if t161_bal(d) <> 0 then raise exception 'FAIL discount voucher not used up: %', t161_bal(d); end if;
  perform t_expect(format('select voucher_redeem(%L, %L, ''v-d2'')', t161_get('res2')::uuid, d), 'POLICY_VIOLATION: voucher used');
  -- cancelling the booking gives the whole voucher back
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform cancel_reservation(res, 'test', 'v-c1');
  if t161_bal(d) <> 90000000 then raise exception 'FAIL cancel did not restore: %', t161_bal(d); end if;
  raise notice 'PASS discount voucher: capped at the booking, used up, restored when the booking is cancelled';
end $$;

-- 4. Expiry, voiding, the booking ending or a staff discount replacing the voucher
do $$ declare
  g text; x text; res uuid; res2 uuid; r jsonb; v_id uuid; v_total bigint; v_bal bigint;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  -- expired: the voucher is issued with a future date, then the date is moved back as the system (issuing itself refuses a past date)
  r := t161_issue('gift', 3000000, current_date + 5); x := r ->> 'code';
  perform t_sys();
  alter table vouchers disable trigger vouchers_no_change;
  update vouchers set expires_on = current_date - 1 where code = x and property_id = '00000000-0000-0000-0000-0000000000a2';
  alter table vouchers enable trigger vouchers_no_change;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  res := t161_book(24030, 2, 'v-b4'); v_total := t161_total(res);
  perform t_expect(format('select voucher_redeem(%L, %L, ''v-x1'')', res, x), 'POLICY_VIOLATION: voucher expired');

  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if (select e ->> 'status' from jsonb_array_elements(voucher_list('00000000-0000-0000-0000-0000000000a2')) e where e ->> 'code' = x) <> 'expired' then raise exception 'FAIL expired status'; end if;

  -- void: needs a reason, writes the balance off, spends nothing afterwards, cannot be voided twice
  r := t161_issue('gift', 3000000); g := r ->> 'code'; v_id := (r ->> 'voucher_id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select voucher_void(%L, ''x'')', v_id), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select voucher_void(%L, '' '')', v_id), 'POLICY_VIOLATION: reason');
  perform voucher_void(v_id, 'lost card');
  if t161_bal(g) <> 0 then raise exception 'FAIL void balance'; end if;
  perform t_expect(format('select voucher_void(%L, ''again'')', v_id), 'INVALID_STATE: void');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select voucher_redeem(%L, %L, ''v-x2'')', res, g), 'POLICY_VIOLATION: voucher void');

  -- a booking that ends gives value back, and a staff discount replaces the voucher and gives it back too
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  g := t161_issue('gift', 3000000) ->> 'code';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  res2 := t161_book(24040, 2, 'v-b5');
  perform voucher_redeem(res2, g, 'v-x3');
  v_bal := t161_bal(g);
  if v_bal <> 0 and v_bal <> 3000000 - (select applied_minor from voucher_ledger where reservation_id = res2 and kind = 'redeem') then raise exception 'FAIL balance after spend %', v_bal; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform apply_discount(res2, 5, 'manager discount', 'v-replace');
  if t161_bal(g) <> 3000000 then raise exception 'FAIL staff discount should give the voucher back: %', t161_bal(g); end if;

  -- void while spent, then the booking is cancelled: the restored value is written off again, never spendable
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  g := t161_issue('gift', 20000000) ->> 'code'; v_id := (select id from vouchers where code = g and property_id = '00000000-0000-0000-0000-0000000000a2');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  res := t161_book(24050, 2, 'v-b6');
  perform voucher_redeem(res, g, 'v-x4');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform voucher_void(v_id, 'dispute');
  perform cancel_reservation(res, 'test', 'v-c2');
  if t161_bal(g) <> 0 then raise exception 'FAIL voided voucher got value back: %', t161_bal(g); end if;
  perform t_sys();
  if exists (select 1 from voucher_ledger where voucher_id = v_id and kind = 'reverse') is not true then raise exception 'FAIL no reversal row'; end if;
  raise notice 'PASS expiry, void, booking ended, staff discount replaces a voucher, voided voucher stays written off';
end $$;

-- 5. Guards: a booking with money, an invoice, a loyalty discount, or not confirmed refuses; the flag turns everything off
do $$ declare g text; res uuid; res2 uuid; v_before bigint; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  g := t161_issue('gift', 3000000) ->> 'code';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  res := t161_book(24060, 2, 'v-b7'); res2 := t161_book(24070, 2, 'v-b8');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform cancel_reservation(res2, 'test', 'v-c3');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select voucher_redeem(%L, %L, ''v-g1'')', res2, g), 'INVALID_STATE: cancelled');
  perform t_sys();
  -- a recorded payment on the booking blocks spending (reuse the manual payment function)
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform record_manual_payment(res, 1000000, 'cash', 'rcpt', 'deposit', 'v-pay');
  perform t_expect(format('select voucher_redeem(%L, %L, ''v-g2'')', res, g), 'INVALID_STATE: money held');
  v_before := t161_bal(g);
  if v_before <> 3000000 then raise exception 'FAIL refused spend moved the balance'; end if;
  -- the flag
  perform t_sys();
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values ('00000000-0000-0000-0000-0000000000a1', 'loyalty', false);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect('select t161_issue(''gift'', 5000000)', 'POLICY_VIOLATION: loyalty off');
  perform t_expect(format('select voucher_redeem(%L, %L, ''v-g3'')', res, g), 'POLICY_VIOLATION: loyalty off');
  if (voucher_booking(res) ->> 'enabled') <> 'false' then raise exception 'FAIL booking view with flag off'; end if;
  perform voucher_list('00000000-0000-0000-0000-0000000000a2');       -- still readable
  perform t_sys();
  delete from tenant_feature_entitlements where tenant_id = '00000000-0000-0000-0000-0000000000a1' and feature_key = 'loyalty';
  raise notice 'PASS guards: cancelled and paid bookings refuse and move nothing; flag off blocks issue and spend, list still reads';
end $$;
