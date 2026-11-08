-- A discount as a fixed naira amount (migration 062, apply_discount_amount). Reuses t_as / t_sys / t_expect / t_book (05).
-- Users: aa01 owner A, aa02 housekeeping A, aa04 front desk A. Ids: a1 tenant A, a2 property A, a3 room type. Offsets 1200 to 1260.
-- Limits are read with discount_cap_for, not assumed, because 60_discount_caps leaves hotel-specific limits behind.
\set ON_ERROR_STOP on

create table t63_ctx (label text primary key, val text not null);
create function t63_get(p_label text) returns text language sql stable as $$ select val from t63_ctx where label = p_label $$;
create function t63_amt(p_res uuid, p_amount bigint, p_reason text, p_key text) returns jsonb language sql as $$ select apply_discount_amount(p_res, p_amount, p_reason, p_key) $$;
create function t63_pct(p_res uuid, p_pct numeric, p_reason text, p_key text) returns jsonb language sql as $$ select apply_discount(p_res, p_pct, p_reason, p_key) $$;

-- 1. Who may, and the input
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; base bigint; cap numeric; most bigint;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1200, t + 1202, 'da-a'); res := (b ->> 'reservation_id')::uuid;
  perform t_sys(); insert into t63_ctx values ('a', res::text);
  select subtotal_minor + tax_minor into base from reservations where id = res;
  cap := discount_cap_for('00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2');
  if cap <= 0 or cap >= 100 then raise exception 'FAIL setup: front desk limit % is not between 0 and 100', cap; end if;
  most := floor(base * cap / 100)::bigint;
  perform t_as('00000000-0000-0000-0000-00000000aa02'); perform t_expect(format('select t63_amt(%L, 100, %L, %L)', res, 'x', 'da-hk'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01'); perform t_expect(format('select t63_amt(%L, 100, %L, %L)', res, 'x', 'da-b'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t63_amt(%L, -1, %L, %L)', res, 'x', 'da-i1'), 'POLICY_VIOLATION: amount');
  perform t_expect(format('select t63_amt(%L, null, %L, %L)', res, 'x', 'da-i2'), 'POLICY_VIOLATION: amount');
  perform t_expect(format('select t63_amt(%L, %s, %L, %L)', res, base + 1, 'x', 'da-i3'), 'POLICY_VIOLATION: amount');
  perform t_expect(format('select t63_amt(%L, 100, %L, %L)', res, '  ', 'da-i4'), 'POLICY_VIOLATION: reason');
  perform t_expect(format('select t63_amt(%L, %s, %L, %L)', res, most + 1, 'x', 'da-cap'), 'POLICY_VIOLATION: discount limit');
  perform t_sys();
  if (select discount_minor from reservations where id = res) <> 0 or exists (select 1 from audit_logs where action = 'reservation.discount_changed' and entity_id = res) then raise exception 'FAIL a refused discount changed something'; end if;
  raise notice 'PASS amount discount: permissions, input (not negative, not above the price, a reason) and the role limit as a share of the price';
end $$;

-- 2. Apply within the limit: the figures, the columns, replay, same value again, one audit row
do $$ declare
  res uuid := t63_get('a')::uuid; r reservations%rowtype; base bigint; cap numeric; most bigint; j jsonb;
begin
  select subtotal_minor + tax_minor into base from reservations where id = res;
  cap := discount_cap_for('00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2');
  most := floor(base * cap / 100)::bigint;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  j := t63_amt(res, most, 'goodwill', 'da-1');
  perform t_sys(); select * into r from reservations where id = res;
  if (j ->> 'changed') <> 'true' or r.discount_minor <> most or r.discount_amount_minor <> most or r.discount_percent is not null or r.total_minor <> base - most or r.discount_reason <> 'goodwill' then raise exception 'FAIL amount set: % %', j, r; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if t63_amt(res, most, 'goodwill', 'da-1') is distinct from j then raise exception 'FAIL replay differs'; end if;
  if (t63_amt(res, most, 'goodwill', 'da-1b') ->> 'changed') <> 'false' then raise exception 'FAIL same amount should change nothing'; end if;
  perform t_sys();
  if (select count(*) from audit_logs where action = 'reservation.discount_changed' and entity_id = res) <> 1 then raise exception 'FAIL expected one audit row'; end if;
  if not exists (select 1 from audit_logs where action = 'reservation.discount_changed' and entity_id = res and actor_user_id = '00000000-0000-0000-0000-00000000aa04' and metadata ->> 'kind' = 'amount' and (metadata ->> 'to_discount_minor')::bigint = most) then raise exception 'FAIL audit detail'; end if;
  raise notice 'PASS an amount within the limit sets the figures, is replay-safe, and a repeat changes nothing; audited with the actor';
end $$;

-- 3. One discount at a time: percent replaces an amount, an amount replaces a percent, and 0 of either kind removes either kind
do $$ declare
  res uuid := t63_get('a')::uuid; r reservations%rowtype; base bigint;
begin
  select subtotal_minor + tax_minor into base from reservations where id = res;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t63_pct(res, 20, 'manager', 'da-2');
  perform t_sys(); select * into r from reservations where id = res;
  if r.discount_percent <> 20 or r.discount_amount_minor is not null or r.discount_minor <> round(base * 0.2)::bigint or r.total_minor <> base - r.discount_minor then raise exception 'FAIL percent replaces amount: %', r; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t63_amt(res, 777700, 'fixed instead', 'da-3');
  perform t_sys(); select * into r from reservations where id = res;
  if r.discount_percent is not null or r.discount_amount_minor <> 777700 or r.discount_minor <> 777700 or r.total_minor <> base - 777700 then raise exception 'FAIL amount replaces percent: %', r; end if;
  -- percent 0 on an amount discount removes it (it must not say "already in place")
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if (t63_pct(res, 0, 'removed', 'da-4') ->> 'changed') <> 'true' then raise exception 'FAIL percent 0 should remove an amount discount'; end if;
  perform t_sys(); select * into r from reservations where id = res;
  if r.discount_minor <> 0 or r.discount_percent is not null or r.discount_amount_minor is not null or r.discount_reason is not null or r.total_minor <> base then raise exception 'FAIL removal: %', r; end if;
  -- amount 0 on a percent discount removes it; amount 0 with no discount changes nothing
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t63_pct(res, 5, 'again', 'da-5');
  if (t63_amt(res, 0, 'removed', 'da-6') ->> 'changed') <> 'true' then raise exception 'FAIL amount 0 should remove a percent discount'; end if;
  if (t63_amt(res, 0, 'removed', 'da-7') ->> 'changed') <> 'false' then raise exception 'FAIL amount 0 with nothing to remove'; end if;
  perform t_sys(); select * into r from reservations where id = res;
  if r.discount_minor <> 0 or r.total_minor <> base then raise exception 'FAIL final state %', r; end if;
  raise notice 'PASS one discount at a time: kinds replace each other and 0 removes either kind';
end $$;

-- 4. The owner may give the whole price; the invoice carries an amount discount; the table refuses a discount of both kinds
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; base bigint; inv jsonb; i invoices%rowtype; ok boolean := false;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1210, t + 1213, 'da-free'); res := (b ->> 'reservation_id')::uuid;
  perform t_sys(); select subtotal_minor + tax_minor into base from reservations where id = res;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t63_amt(res, base, 'comp', 'da-f1');
  inv := issue_invoice(res, 'da-f-inv');
  perform t_sys();
  select * into i from invoices where id = (inv ->> 'invoice_id')::uuid;
  if i.total_minor <> 0 or i.discount_minor <> base then raise exception 'FAIL invoice for a free stay %', i; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select t63_amt(%L, 1000, %L, %L)', res, 'x', 'da-f2'), 'INVALID_STATE: invoice');
  perform t_sys();
  begin
    update reservations set discount_percent = 5, discount_amount_minor = 5, discount_minor = 5 where id = res;
    raise exception 'FAIL a discount of both kinds was stored';
  exception when check_violation then ok := true; end;
  raise notice 'PASS the owner may give the whole price, the invoice carries it, a live invoice blocks a change, both kinds at once is refused by the table';
end $$;

-- 5. Money and status block it, the same as a percent discount; dates cannot be edited under an amount discount
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1220, t + 1222, 'da-pay'); res := (b ->> 'reservation_id')::uuid;
  perform record_manual_payment(res, 100000, 'cash', null, null, 'da-pay-p');
  perform t_expect(format('select t63_amt(%L, 1000, %L, %L)', res, 'x', 'da-pay-d'), 'INVALID_STATE: money held');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1230, t + 1232, 'da-edit'); res := (b ->> 'reservation_id')::uuid;
  perform t63_amt(res, 1000, 'x', 'da-edit-d');
  perform t_expect(format('select update_reservation_stay(%L, %L, %L, null, %L, %L)', res, t + 1230, t + 1233, 'x', 'da-edit-u'), 'POLICY_VIOLATION: discount');
  perform t_sys();
  raise notice 'PASS money held blocks an amount discount; dates cannot be edited under one';
end $$;

-- 6. Early check-out and early check-in (060, 061) keep a fixed amount: it stays, capped at the new price
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; rr uuid; base bigint; nightly bigint; x record; a bigint := 100000;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1240, t + 1243, 'da-early'); res := (b ->> 'reservation_id')::uuid; rr := t_rr(b);
  perform t_sys(); select subtotal_minor + tax_minor into base from reservations where id = res; nightly := base / 3;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t63_amt(res, a, 'promo', 'da-early-d');
  perform t_sys();
  -- credit the last two nights: the amount stays while it is below the remaining price
  select * into x from early_checkout_new_totals(res, rr, t + 1241, 'credit');
  if x.discount <> a or x.total <> x.subtotal + x.tax - a then raise exception 'FAIL checkout keeps the amount %', x; end if;
  -- a remaining price smaller than the amount caps it
  update reservations set discount_amount_minor = base, discount_minor = base, total_minor = 0 where id = res;
  select * into x from early_checkout_new_totals(res, rr, t + 1241, 'credit');
  if x.discount <> x.subtotal + x.tax or x.total <> 0 then raise exception 'FAIL checkout caps the amount %', x; end if;
  -- check-in: the earlier nights raise the price, the amount is unchanged
  update reservations set discount_amount_minor = a, discount_minor = a, total_minor = base - a where id = res;
  select * into x from early_checkin_new_totals(res, rr, t + 1240);
  if x.discount <> a then raise exception 'FAIL checkin keeps the amount %', x; end if;
  raise notice 'PASS early check-out and check-in keep a fixed discount, capped at the remaining price';
end $$;
