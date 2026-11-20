-- Loyalty points (migration 159). Hotel A: tenant a1, property a2, Standard a3. Users: aa01 owner A, aa02 housekeeping A, aa04 front desk A,
-- bb01 owner of the other hotel. Reuses t_as / t_sys / t_expect (05). Bookings are made for guests created here, with their own e-mail
-- addresses, because t_book uses one shared guest and giving that guest an e-mail would change what other tests see. Offsets 23000 to 23100.
\set ON_ERROR_STOP on

create table t159_ctx (label text primary key, val text not null);
create function t159_get(p_label text) returns text language sql stable as $$ select val from t159_ctx where label = p_label $$;
create function t159_book(p_guest uuid, p_off integer, p_nights integer, p_key text) returns uuid language sql as $$
  select (create_reservation('00000000-0000-0000-0000-0000000000a2', p_guest, 'staff_entry',
           current_date + p_off, current_date + p_off + p_nights,
           jsonb_build_array(jsonb_build_object('room_type_id', '00000000-0000-0000-0000-0000000000a3', 'requested_room_id', null, 'adults', 1)), p_key)
          ->> 'reservation_id')::uuid
$$;
create function t159_balance(p_email text) returns bigint language sql as $$
  select coalesce(sum(points), 0)::bigint from loyalty_ledger where tenant_id = '00000000-0000-0000-0000-0000000000a1' and member_key = lower(p_email)
$$;
create function t159_save(p_on boolean, p_earn integer, p_value integer, p_min integer) returns void language sql as $$
  select save_loyalty_settings('00000000-0000-0000-0000-0000000000a2', p_on, p_earn, p_value, p_min)
$$;

-- 0. Setup: two guests, one with an e-mail address in capitals and spaces to prove the key is normalised, one with none
do $$ begin
  perform t_sys();
  insert into guests (id, tenant_id, full_name, email) values
    ('00000000-0000-0000-0000-0000000159a1', '00000000-0000-0000-0000-0000000000a1', 'Ada Loyal', '  Ada.Loyal@Example.TEST '),
    ('00000000-0000-0000-0000-0000000159a2', '00000000-0000-0000-0000-0000000000a1', 'No Mail', null);
  raise notice 'PASS setup: two guests';
end $$;

-- 1. Settings: off by default, who may save, the input rules, the audit row, another hotel refused
do $$ declare s jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  s := loyalty_settings_get('00000000-0000-0000-0000-0000000000a2');
  if (s ->> 'enabled') <> 'false' or (s ->> 'earn_per_100') <> '1' or (s ->> 'point_value_minor') <> '100' or (s ->> 'min_redeem') <> '100' or (s ->> 'flag_on') <> 'true' then
    raise exception 'FAIL defaults %', s;
  end if;
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect('select loyalty_settings_get(''00000000-0000-0000-0000-0000000000a2'')', 'NOT_FOUND');
  perform t_expect('select t159_save(true, 1, 100, 100)', 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform loyalty_settings_get('00000000-0000-0000-0000-0000000000a2');            -- front desk may read (discount.apply)
  perform t_expect('select t159_save(true, 1, 100, 100)', 'NOT_FOUND');            -- but not change
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect('select t159_save(true, 1, 100, 100)', 'NOT_FOUND');
  perform t_expect('select loyalty_settings_get(''00000000-0000-0000-0000-0000000000a2'')', 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect('select t159_save(null, 1, 100, 100)', 'POLICY_VIOLATION: enabled');
  perform t_expect('select t159_save(true, 0, 100, 100)', 'POLICY_VIOLATION: earn');
  perform t_expect('select t159_save(true, 51, 100, 100)', 'POLICY_VIOLATION: earn');
  perform t_expect('select t159_save(true, 1, 9, 100)', 'POLICY_VIOLATION: value');
  perform t_expect('select t159_save(true, 1, 10001, 100)', 'POLICY_VIOLATION: value');
  perform t_expect('select t159_save(true, 1, 100, 0)', 'POLICY_VIOLATION: minimum');
  perform t_expect('select t159_save(true, 1, 100, 10001)', 'POLICY_VIOLATION: minimum');
  perform t159_save(true, 1, 100, 100);
  s := loyalty_settings_get('00000000-0000-0000-0000-0000000000a2');
  if (s ->> 'enabled') <> 'true' then raise exception 'FAIL not saved %', s; end if;
  perform t_sys();
  if (select count(*) from audit_logs where action = 'loyalty.settings_saved' and entity_id = '00000000-0000-0000-0000-0000000000a2') <> 1 then raise exception 'FAIL audit'; end if;
  raise notice 'PASS settings: off by default, owner saves, front desk reads only, input rules, other hotel refused, audited';
end $$;

-- 2. Earning at check-out: room price after discount only, one row per booking, no email or settings off earns nothing
do $$ declare
  g1 uuid := '00000000-0000-0000-0000-0000000159a1'; g2 uuid := '00000000-0000-0000-0000-0000000159a2'; res uuid; res2 uuid; res3 uuid; res4 uuid; v_base bigint; v_exp bigint; v_pts integer;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  res := t159_book(g1, 23000, 2, 'l-e1'); res2 := t159_book(g2, 23010, 2, 'l-e2'); res3 := t159_book(g1, 23020, 2, 'l-e3'); res4 := t159_book(g1, 23030, 2, 'l-e4');
  perform t_sys(); insert into t159_ctx values ('earn', res::text), ('noemail', res2::text), ('disabled', res3::text), ('cancel', res4::text);

  -- a booking that is not finished earns nothing, and a discount comes off the base
  if exists (select 1 from loyalty_ledger where reservation_id = res) then raise exception 'FAIL earned before check-out'; end if;
  select subtotal_minor into v_base from reservations where id = res;
  v_exp := (v_base / 10000) * 1;
  update reservations set reservation_status = 'checked_out' where id = res;
  select points into v_pts from loyalty_ledger where reservation_id = res and kind = 'earn';
  if v_pts is distinct from v_exp::integer or v_pts <= 0 then raise exception 'FAIL earned % expected % (room price %)', v_pts, v_exp, v_base; end if;
  if (select member_key from loyalty_ledger where reservation_id = res and kind = 'earn') <> 'ada.loyal@example.test' then raise exception 'FAIL key not normalised'; end if;
  insert into t159_ctx values ('earned', v_pts::text);

  -- the same status again, or a no-op update, adds nothing
  update reservations set reservation_status = 'checked_out' where id = res;
  update reservations set updated_at = now() where id = res;
  if (select count(*) from loyalty_ledger where reservation_id = res) <> 1 then raise exception 'FAIL earned twice'; end if;

  -- no e-mail: no account, nothing written
  update reservations set reservation_status = 'checked_out' where id = res2;
  if exists (select 1 from loyalty_ledger where reservation_id = res2) then raise exception 'FAIL a guest with no e-mail earned'; end if;

  -- settings off: nothing
  perform t_as('00000000-0000-0000-0000-00000000aa01'); perform t159_save(false, 1, 100, 100); perform t_sys();
  update reservations set reservation_status = 'checked_out' where id = res3;
  if exists (select 1 from loyalty_ledger where reservation_id = res3) then raise exception 'FAIL earned with the programme off'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01'); perform t159_save(true, 1, 100, 100); perform t_sys();

  -- a booking that ends without a stay never earns
  update reservations set reservation_status = 'cancelled' where id = res4;
  if exists (select 1 from loyalty_ledger where reservation_id = res4 and kind = 'earn') then raise exception 'FAIL a cancelled booking earned'; end if;
  raise notice 'PASS earning: room price only, once per booking, key normalised, nothing without e-mail, with the programme off, or for a cancelled booking';
end $$;

-- 3. The earn rate and a discount: the discount comes off the base, so points paid for earn less
do $$ declare g1 uuid := '00000000-0000-0000-0000-0000000159a1'; res uuid; v_sub bigint; v_disc bigint; v_pts integer; v_before bigint; begin
  perform t_as('00000000-0000-0000-0000-00000000aa01'); perform t159_save(true, 2, 100, 100);
  perform t_as('00000000-0000-0000-0000-00000000aa04'); res := t159_book(g1, 23040, 2, 'l-r1');
  perform t_as('00000000-0000-0000-0000-00000000aa01'); perform apply_discount_amount(res, 1000000, 'test', 'l-r1-d');
  perform t_sys();
  select subtotal_minor, discount_minor into v_sub, v_disc from reservations where id = res;
  v_before := t159_balance('ada.loyal@example.test');
  update reservations set reservation_status = 'checked_out' where id = res;
  select points into v_pts from loyalty_ledger where reservation_id = res and kind = 'earn';
  if v_pts is distinct from (((v_sub - v_disc) / 10000) * 2)::integer then raise exception 'FAIL earned % expected %', v_pts, ((v_sub - v_disc) / 10000) * 2; end if;
  if t159_balance('ada.loyal@example.test') <> v_before + v_pts then raise exception 'FAIL balance'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01'); perform t159_save(true, 1, 100, 100); perform t_sys();
  raise notice 'PASS earn rate setting applies, and a discounted booking earns on the room price after the discount';
end $$;

-- 4. Manual adjustments and the ledger: who, input, never below zero, append-only, the list
do $$ declare e text := 'Ada.Loyal@Example.TEST'; b0 bigint; j jsonb; begin
  perform t_sys(); b0 := t159_balance(e);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select loyalty_adjust(%L, %L, 100, %L)', '00000000-0000-0000-0000-0000000000a2', e, 'x'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select loyalty_adjust(%L, %L, 100, %L)', '00000000-0000-0000-0000-0000000000a2', e, 'x'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select loyalty_adjust(%L, %L, 100, %L)', '00000000-0000-0000-0000-0000000000a2', 'nope', 'x'), 'POLICY_VIOLATION: email');
  perform t_expect(format('select loyalty_adjust(%L, %L, 0, %L)', '00000000-0000-0000-0000-0000000000a2', e, 'x'), 'POLICY_VIOLATION: points');
  perform t_expect(format('select loyalty_adjust(%L, %L, 100001, %L)', '00000000-0000-0000-0000-0000000000a2', e, 'x'), 'POLICY_VIOLATION: points');
  perform t_expect(format('select loyalty_adjust(%L, %L, 100, %L)', '00000000-0000-0000-0000-0000000000a2', e, '  '), 'POLICY_VIOLATION: reason');
  perform t_expect(format('select loyalty_adjust(%L, %L, %s, %L)', '00000000-0000-0000-0000-0000000000a2', e, -(b0 + 1), 'x'), 'POLICY_VIOLATION: balance');
  j := loyalty_adjust('00000000-0000-0000-0000-0000000000a2', e, 1000, 'welcome gift');
  if (j ->> 'balance')::bigint <> b0 + 1000 then raise exception 'FAIL balance %', j; end if;
  j := loyalty_adjust('00000000-0000-0000-0000-0000000000a2', e, -50, 'correction');
  if (j ->> 'balance')::bigint <> b0 + 950 then raise exception 'FAIL balance after minus %', j; end if;
  -- the ledger list: owner only, optional e-mail filter, newest first, the running balance
  j := loyalty_ledger_list('00000000-0000-0000-0000-0000000000a2', e, 50);
  if jsonb_array_length(j) < 3 or (j -> 0 ->> 'kind') <> 'adjust' or (j -> 0 ->> 'points') <> '-50' or (j -> 0 ->> 'balance')::bigint <> b0 + 950 or (j -> 0 ->> 'email') <> 'ada.loyal@example.test' then
    raise exception 'FAIL ledger list %', j;
  end if;
  if jsonb_array_length(loyalty_ledger_list('00000000-0000-0000-0000-0000000000a2', 'nobody@example.test', 50)) <> 0 then raise exception 'FAIL filter'; end if;
  perform t_expect(format('select loyalty_ledger_list(%L, %L, 5)', '00000000-0000-0000-0000-0000000000a2', 'bad'), 'POLICY_VIOLATION: email');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect('select loyalty_ledger_list(''00000000-0000-0000-0000-0000000000a2'', null, 5)', 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect('select loyalty_ledger_list(''00000000-0000-0000-0000-0000000000a2'', null, 5)', 'NOT_FOUND');
  perform t_sys();
  if (select count(*) from audit_logs where action = 'loyalty.adjusted' and metadata ->> 'email' = 'ada.loyal@example.test') <> 2 then raise exception 'FAIL audit rows'; end if;
  begin update loyalty_ledger set points = points + 1 where member_key = 'ada.loyal@example.test'; raise exception 'FAIL update allowed';
  exception when sqlstate '23514' then null; end;
  begin delete from loyalty_ledger where member_key = 'ada.loyal@example.test'; raise exception 'FAIL delete allowed';
  exception when sqlstate '23514' then null; end;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin insert into loyalty_ledger (tenant_id, property_id, member_key, kind, points, reason) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2', 'x@y.z', 'adjust', 5, 'direct');
    raise exception 'FAIL direct insert allowed'; exception when insufficient_privilege then null; end;
  perform t_sys();
  raise notice 'PASS adjustments: owner only, input rules, never below zero, audited; the ledger is append-only and not writable directly; the list';
end $$;

-- 5. Redeeming: refusals first, then the figures, replay, and the audit row
do $$ declare
  g1 uuid := '00000000-0000-0000-0000-0000000159a1'; g2 uuid := '00000000-0000-0000-0000-0000000159a2'; res uuid; resn uuid; resc uuid; resd uuid;
  b0 bigint; j jsonb; r reservations%rowtype; price bigint;
begin
  perform t_sys(); b0 := t159_balance('ada.loyal@example.test');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  res := t159_book(g1, 23050, 2, 'l-d1'); resn := t159_book(g2, 23060, 2, 'l-d2'); resc := t159_book(g1, 23070, 2, 'l-d3'); resd := t159_book(g1, 23080, 2, 'l-d4');
  perform t_sys(); insert into t159_ctx values ('redeem', res::text), ('noemail2', resn::text), ('cancel2', resc::text), ('other', resd::text);
  select subtotal_minor + tax_minor into price from reservations where id = res;

  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select loyalty_redeem(%L, 100, %L)', res, 'l-x1'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select loyalty_redeem(%L, 100, %L)', res, 'l-x2'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select loyalty_redeem(%L, 99, %L)', res, 'l-x3'), 'POLICY_VIOLATION: points');            -- below the minimum of 100
  perform t_expect(format('select loyalty_redeem(%L, null, %L)', res, 'l-x4'), 'POLICY_VIOLATION: points');
  perform t_expect(format('select loyalty_redeem(%L, %s, %L)', res, b0 + 1, 'l-x5'), 'POLICY_VIOLATION: balance');
  perform t_expect(format('select loyalty_redeem(%L, 100, %L)', resn, 'l-x6'), 'POLICY_VIOLATION: no email');
  -- a booking that has been cancelled cannot take points
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform cancel_reservation(resc, 'test', 'l-c-x');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select loyalty_redeem(%L, 100, %L)', resc, 'l-x7'), 'INVALID_STATE: cancelled');
  -- one discount per booking: a staff discount already there
  perform t_as('00000000-0000-0000-0000-00000000aa01'); perform apply_discount(resd, 5, 'goodwill', 'l-d4-d');
  perform t_expect(format('select loyalty_redeem(%L, 100, %L)', resd, 'l-x8'), 'INVALID_STATE: discount');
  -- more than the booking costs: a point worth the most it can be, and enough points
  perform t159_save(true, 1, 10000, 1);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select loyalty_redeem(%L, %s, %L)', res, price / 10000 + 1, 'l-x9'), 'POLICY_VIOLATION: amount');
  perform t_as('00000000-0000-0000-0000-00000000aa01'); perform t159_save(true, 1, 100, 100); perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_sys();
  if exists (select 1 from loyalty_ledger where kind = 'redeem') or (select discount_minor from reservations where id = res) <> 0 then raise exception 'FAIL a refused redemption left something behind'; end if;

  -- the redemption
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  j := loyalty_redeem(res, 200, 'l-ok');
  perform t_sys(); select * into r from reservations where id = res;
  if (j ->> 'changed') <> 'true' or r.discount_minor <> 20000 or r.discount_amount_minor <> 20000 or r.discount_percent is not null or r.discount_reason <> 'Loyalty points'
     or r.total_minor <> r.subtotal_minor + r.tax_minor - 20000 or (j ->> 'balance')::bigint <> b0 - 200 then
    raise exception 'FAIL redemption figures % / %', j, r.discount_minor;
  end if;
  if not exists (select 1 from loyalty_ledger where reservation_id = res and kind = 'redeem' and points = -200 and value_minor = 20000 and actor_user_id = '00000000-0000-0000-0000-00000000aa04') then raise exception 'FAIL ledger row'; end if;
  if t159_balance('ada.loyal@example.test') <> b0 - 200 then raise exception 'FAIL balance'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if loyalty_redeem(res, 200, 'l-ok') is distinct from j then raise exception 'FAIL replay differs'; end if;
  perform t_expect(format('select loyalty_redeem(%L, 100, %L)', res, 'l-again'), 'INVALID_STATE: discount');
  perform t_sys();
  if (select count(*) from loyalty_ledger where reservation_id = res and kind = 'redeem') <> 1 then raise exception 'FAIL redeemed twice'; end if;
  if not exists (select 1 from audit_logs where action = 'loyalty.redeemed' and entity_id = res and (metadata ->> 'points')::int = 200 and actor_user_id = '00000000-0000-0000-0000-00000000aa04') then raise exception 'FAIL audit'; end if;
  raise notice 'PASS redeeming: permissions, minimum, balance, no email, cancelled, existing discount and price limit refused; the redemption sets the discount, ledger row and audit, replay-safe, once';
end $$;

-- 6. The booking view for staff, and the guest's balance (service role only)
do $$ declare res uuid := t159_get('redeem')::uuid; j jsonb; b bigint; begin
  perform t_sys(); b := t159_balance('ada.loyal@example.test');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  j := loyalty_booking(res);
  if (j ->> 'enabled') <> 'true' or (j ->> 'has_email') <> 'true' or (j ->> 'balance')::bigint <> b or (j ->> 'redeemed_points') <> '200' or (j ->> 'redeemed_minor') <> '20000' or (j ->> 'min_redeem') <> '100' then
    raise exception 'FAIL booking view %', j;
  end if;
  j := loyalty_booking(t159_get('noemail2')::uuid);
  if (j ->> 'has_email') <> 'false' or (j ->> 'balance') <> '0' then raise exception 'FAIL no-email view %', j; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa02'); perform t_expect(format('select loyalty_booking(%L)', res), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01'); perform t_expect(format('select loyalty_booking(%L)', res), 'NOT_FOUND');
  -- the guest's balance: refused to anyone signed in, answered for the service role
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  begin perform guest_loyalty_balance(res); raise exception 'FAIL a signed-in user read the guest balance'; exception when insufficient_privilege then null; end;
  perform t_sys();
  j := guest_loyalty_balance(res);
  if (j ->> 'enabled') <> 'true' or (j ->> 'balance')::bigint <> b or (j ->> 'point_value_minor') <> '100' then raise exception 'FAIL guest balance %', j; end if;
  if (guest_loyalty_balance(t159_get('noemail2')::uuid) ->> 'enabled') <> 'false' then raise exception 'FAIL no email should show no balance'; end if;
  if (guest_loyalty_balance(gen_random_uuid()) ->> 'enabled') <> 'false' then raise exception 'FAIL unknown booking'; end if;
  raise notice 'PASS booking view for staff with permission; guest balance for the service role only, nothing for a guest with no e-mail';
end $$;

-- 7. Giving points back: release by staff, a staff discount that replaces the redemption, a booking that ends
do $$ declare
  res uuid := t159_get('redeem')::uuid; g1 uuid := '00000000-0000-0000-0000-0000000159a1'; b0 bigint; j jsonb; r reservations%rowtype; res2 uuid; res3 uuid;
begin
  perform t_sys(); b0 := t159_balance('ada.loyal@example.test');
  -- release
  perform t_as('00000000-0000-0000-0000-00000000aa02'); perform t_expect(format('select loyalty_release(%L, %L)', res, 'l-rel-x'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  j := loyalty_release(res, 'l-rel');
  perform t_sys(); select * into r from reservations where id = res;
  if (j ->> 'changed') <> 'true' or r.discount_minor <> 0 or r.discount_reason is not null or r.discount_amount_minor is not null or r.total_minor <> r.subtotal_minor + r.tax_minor then raise exception 'FAIL release figures % %', j, r.discount_minor; end if;
  if t159_balance('ada.loyal@example.test') <> b0 + 200 then raise exception 'FAIL points not returned'; end if;
  if (select count(*) from loyalty_ledger where reservation_id = res and kind = 'reverse' and points = 200 and reason = 'Discount changed') <> 1 then raise exception 'FAIL reverse row'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if loyalty_release(res, 'l-rel') is distinct from j then raise exception 'FAIL release replay'; end if;
  if (loyalty_release(res, 'l-rel-2') ->> 'changed') <> 'false' then raise exception 'FAIL nothing to release should change nothing'; end if;
  perform t_sys();
  if t159_balance('ada.loyal@example.test') <> b0 + 200 then raise exception 'FAIL released twice'; end if;
  if not exists (select 1 from audit_logs where action = 'loyalty.released' and entity_id = res) then raise exception 'FAIL audit'; end if;

  -- redeem again, then a staff discount replaces it: the points come back and nothing is lost
  perform t_as('00000000-0000-0000-0000-00000000aa04'); perform loyalty_redeem(res, 300, 'l-again-2');
  perform t_sys(); b0 := t159_balance('ada.loyal@example.test');
  perform t_as('00000000-0000-0000-0000-00000000aa01'); perform apply_discount(res, 5, 'manager discount', 'l-replace');
  perform t_sys();
  if t159_balance('ada.loyal@example.test') <> b0 + 300 then raise exception 'FAIL points not returned when a staff discount replaced the redemption'; end if;
  if (select count(*) from loyalty_ledger where reservation_id = res and kind = 'reverse') <> 2 then raise exception 'FAIL reverse rows'; end if;
  -- remove that discount, redeem for a different booking and cancel it: the points come back with the reason 'Booking ended'
  perform t_as('00000000-0000-0000-0000-00000000aa04'); res2 := t159_book(g1, 23090, 2, 'l-end1');
  perform loyalty_redeem(res2, 150, 'l-end1-r');
  perform t_sys(); b0 := t159_balance('ada.loyal@example.test');
  perform t_as('00000000-0000-0000-0000-00000000aa01'); perform cancel_reservation(res2, 'test', 'l-end1-c'); perform t_sys();
  if t159_balance('ada.loyal@example.test') <> b0 + 150 or not exists (select 1 from loyalty_ledger where reservation_id = res2 and kind = 'reverse' and reason = 'Booking ended') then
    raise exception 'FAIL points not returned when the booking was cancelled';
  end if;
  -- a second pass over the same ended booking does not return them twice
  update reservations set reservation_status = 'no_show' where id = res2 and reservation_status = 'cancelled';
  if t159_balance('ada.loyal@example.test') <> b0 + 150 then raise exception 'FAIL returned twice'; end if;
  raise notice 'PASS giving back: release, a replacing staff discount and a cancelled booking each return the points exactly once, with a reason';
end $$;

-- 8. The flag: off for the group, saving, redeeming, adjusting and earning refuse; the guest balance goes quiet; back on, all works
do $$ declare g1 uuid := '00000000-0000-0000-0000-0000000159a1'; res uuid; b0 bigint; begin
  perform t_sys();
  insert into tenant_feature_entitlements (tenant_id, feature_key, enabled) values ('00000000-0000-0000-0000-0000000000a1', 'loyalty', false);
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect('select t159_save(true, 1, 100, 100)', 'POLICY_VIOLATION: loyalty off');
  perform t_expect(format('select loyalty_adjust(%L, %L, 10, %L)', '00000000-0000-0000-0000-0000000000a2', 'ada.loyal@example.test', 'x'), 'POLICY_VIOLATION: loyalty off');
  perform t_expect(format('select loyalty_redeem(%L, 100, %L)', t159_get('redeem'), 'l-flag'), 'POLICY_VIOLATION: loyalty off');
  if (loyalty_settings_get('00000000-0000-0000-0000-0000000000a2') ->> 'flag_on') <> 'false' then raise exception 'FAIL flag state'; end if;
  if (loyalty_booking(t159_get('redeem')::uuid) ->> 'enabled') <> 'false' then raise exception 'FAIL booking view with the flag off'; end if;
  perform t_sys();
  if (guest_loyalty_balance(t159_get('redeem')::uuid) ->> 'enabled') <> 'false' then raise exception 'FAIL guest balance with the flag off'; end if;
  b0 := t159_balance('ada.loyal@example.test');
  perform t_as('00000000-0000-0000-0000-00000000aa04'); res := t159_book(g1, 23095, 2, 'l-flag-b'); perform t_sys();
  update reservations set reservation_status = 'checked_out' where id = res;
  if t159_balance('ada.loyal@example.test') <> b0 then raise exception 'FAIL earned with the flag off'; end if;
  delete from tenant_feature_entitlements where tenant_id = '00000000-0000-0000-0000-0000000000a1' and feature_key = 'loyalty';
  perform t_as('00000000-0000-0000-0000-00000000aa01'); perform t159_save(true, 1, 100, 100); perform t_sys();
  raise notice 'PASS the loyalty flag switches saving, spending, adjusting, earning and the guest balance off for the group, and back on';
end $$;

-- 9. The flag is listed with the plan flags, and the pro plan has it
do $$ begin
  perform t_sys();
  if not (plan_enforced_flags() @> array['loyalty']) then raise exception 'FAIL loyalty is not an enforced flag'; end if;
  if not exists (select 1 from plans where code = 'pro' and 'loyalty' = any (features)) then raise exception 'FAIL the pro plan lacks loyalty'; end if;
  raise notice 'PASS loyalty is an enforced plan flag and part of the pro plan';
end $$;
