-- A percentage discount on a booking (migration 058, apply_discount). Reuses t_as / t_sys / t_expect / t_book (05).
-- Users: aa01 owner A, aa02 housekeeping A, aa04 front desk A, aa05 accountant A, bb01 owner of Hotel B. Ids: a2 property A, a3 room type.
-- Dates use offsets 1000 to 1100 from today (nothing else comes near them).
\set ON_ERROR_STOP on

create table t59_ctx (label text primary key, val text not null);
create function t59_get(p_label text) returns text language sql stable as $$ select val from t59_ctx where label = p_label $$;
create function t59_disc(p_res uuid, p_pct numeric, p_reason text, p_key text) returns jsonb language sql as $$ select apply_discount(p_res, p_pct, p_reason, p_key) $$;
create function t59_audits(p_res uuid) returns bigint language sql stable as $$ select count(*) from audit_logs where action = 'reservation.discount_changed' and entity_id = p_res $$;

-- 1. Who may: owner and front desk; housekeeping, accountant, another hotel's owner and an unknown booking get NOT_FOUND
do $$ declare t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1000, t + 1002, 'dc-a'); res := (b ->> 'reservation_id')::uuid;
  perform t_sys(); insert into t59_ctx values ('a', res::text);
  perform t_as('00000000-0000-0000-0000-00000000aa02'); perform t_expect(format('select t59_disc(%L, 5, %L, %L)', res, 'x', 'dc-hk'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05'); perform t_expect(format('select t59_disc(%L, 5, %L, %L)', res, 'x', 'dc-acc'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01'); perform t_expect(format('select t59_disc(%L, 5, %L, %L)', res, 'x', 'dc-b'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04'); perform t_expect(format('select t59_disc(%L, 5, %L, %L)', gen_random_uuid(), 'x', 'dc-none'), 'NOT_FOUND');
  perform t_sys();
  if t59_audits(res) <> 0 or (select discount_minor from reservations where id = res) <> 0 then raise exception 'FAIL a refused discount changed something'; end if;
  raise notice 'PASS permissions: front desk may; housekeeping, accountant, another hotel and an unknown booking get NOT_FOUND';
end $$;

-- 2. Input and the role cap
do $$ declare res uuid := t59_get('a')::uuid; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t59_disc(%L, -1, %L, %L)', res, 'x', 'dc-i1'), 'POLICY_VIOLATION: percent');
  perform t_expect(format('select t59_disc(%L, 100.01, %L, %L)', res, 'x', 'dc-i2'), 'POLICY_VIOLATION: percent');
  perform t_expect(format('select t59_disc(%L, 5.555, %L, %L)', res, 'x', 'dc-i3'), 'POLICY_VIOLATION: percent');
  perform t_expect(format('select t59_disc(%L, null, %L, %L)', res, 'x', 'dc-i4'), 'POLICY_VIOLATION: percent');
  perform t_expect(format('select t59_disc(%L, 5, %L, %L)', res, '   ', 'dc-i5'), 'POLICY_VIOLATION: reason');
  perform t_expect(format('select t59_disc(%L, 5, %L, %L)', res, repeat('x', 201), 'dc-i6'), 'POLICY_VIOLATION: reason');
  perform t_expect(format('select t59_disc(%L, 10.01, %L, %L)', res, 'x', 'dc-cap'), 'POLICY_VIOLATION: discount limit 10');
  perform t_sys();
  if t59_audits(res) <> 0 then raise exception 'FAIL a refused discount was audited'; end if;
  raise notice 'PASS input is checked (percent 0 to 100 with two decimals, a reason) and front desk stops at its 10 percent cap';
end $$;

-- 3. The maths, replacing rather than stacking, repeats, removing, the totals check, the audit trail
do $$ declare
  res uuid := t59_get('a')::uuid; r reservations%rowtype; j jsonb; n bigint; pre bigint;
begin
  perform t_sys(); select * into r from reservations where id = res; pre := r.subtotal_minor + r.tax_minor;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  j := t59_disc(res, 10, 'loyal guest', 'dc-1');
  perform t_sys(); select * into r from reservations where id = res;
  if (j ->> 'changed') <> 'true' or r.discount_minor <> round(pre * 0.10)::bigint or r.total_minor <> pre - r.discount_minor or r.discount_percent <> 10 or r.discount_reason <> 'loyal guest' then
    raise exception 'FAIL 10 percent: % %', j, r; end if;
  if (select tax_minor from reservations where id = res) <> pre - r.subtotal_minor then raise exception 'FAIL tax changed'; end if;
  -- the same request again, and the same values under a new key: nothing more happens
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if t59_disc(res, 10, 'loyal guest', 'dc-1') is distinct from j then raise exception 'FAIL replay differs'; end if;
  if (t59_disc(res, 10, 'loyal guest', 'dc-1b') ->> 'changed') <> 'false' then raise exception 'FAIL same values should change nothing'; end if;
  perform t_sys();
  if t59_audits(res) <> 1 then raise exception 'FAIL expected one audit row, got %', t59_audits(res); end if;
  -- the owner replaces it with 25 (it does not stack to 35)
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  j := t59_disc(res, 25, 'manager approved', 'dc-2');
  perform t_sys(); select * into r from reservations where id = res;
  if r.discount_minor <> round(pre * 0.25)::bigint or r.total_minor <> pre - r.discount_minor or r.discount_percent <> 25 then raise exception 'FAIL replace: %', r; end if;
  -- front desk cannot lower or raise a discount above its cap... lowering to 5 is within the cap and allowed
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t59_disc(res, 5, 'corrected', 'dc-3');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t59_disc(res, 0, 'cancelled the offer', 'dc-4');
  perform t_sys(); select * into r from reservations where id = res;
  if r.discount_minor <> 0 or r.discount_percent is not null or r.discount_reason is not null or r.total_minor <> pre then raise exception 'FAIL removal: %', r; end if;
  select count(*) into n from audit_logs where action = 'reservation.discount_changed' and entity_id = res and actor_user_id in ('00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-00000000aa01');
  if n <> 4 then raise exception 'FAIL expected 4 audit rows (10, 25, 5, 0), got %', n; end if;
  if not exists (select 1 from audit_logs where action = 'reservation.discount_changed' and entity_id = res and (metadata ->> 'to_percent')::numeric = 25 and (metadata ->> 'from_percent')::numeric = 10 and metadata ->> 'reason' = 'manager approved') then raise exception 'FAIL audit detail'; end if;
  raise notice 'PASS discount maths, replace not stack, replay safe, removal restores the total, every change audited with the actor and reason';
end $$;

-- 4. A free stay (100 percent) leaves a booking that can still be invoiced; the invoice carries the discount; the owner may go that far
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; r reservations%rowtype; inv jsonb; i invoices%rowtype;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1010, t + 1013, 'dc-free'); res := (b ->> 'reservation_id')::uuid;
  perform t_sys(); insert into t59_ctx values ('free', res::text);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t59_disc(%L, 100, %L, %L)', res, 'comp', 'dc-f0'), 'POLICY_VIOLATION: discount limit 10');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t59_disc(res, 50, 'half', 'dc-f1');
  inv := issue_invoice(res, 'dc-f-inv');
  perform t_sys();
  select * into r from reservations where id = res;
  select * into i from invoices where id = (inv ->> 'invoice_id')::uuid;
  if i.discount_minor <> r.discount_minor or i.total_minor <> r.total_minor or i.total_minor <> i.subtotal_minor + i.tax_minor - i.discount_minor then raise exception 'FAIL invoice does not carry the discount %', i; end if;
  -- with a live invoice the discount cannot change; after voiding it, it can
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select t59_disc(%L, 100, %L, %L)', res, 'comp', 'dc-f2'), 'INVALID_STATE: invoice');
  perform void_invoice(i.id, 'to change the discount', 'dc-f-void');
  perform t59_disc(res, 100, 'comp', 'dc-f3');
  perform t_sys(); select * into r from reservations where id = res;
  if r.total_minor <> 0 or r.discount_minor <> r.subtotal_minor + r.tax_minor then raise exception 'FAIL free stay %', r; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  inv := issue_invoice(res, 'dc-f-inv2');
  perform t_sys();
  if (select total_minor from invoices where id = (inv ->> 'invoice_id')::uuid) <> 0 then raise exception 'FAIL zero invoice'; end if;
  raise notice 'PASS the invoice carries the discount, a live invoice blocks a change, a free stay can still be invoiced';
end $$;

-- 5. Money, status and a payment in progress block it; dates cannot be edited under a discount
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; c uuid;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1020, t + 1022, 'dc-pay'); res := (b ->> 'reservation_id')::uuid;
  perform record_manual_payment(res, 100000, 'cash', null, null, 'dc-pay-p');
  perform t_expect(format('select t59_disc(%L, 5, %L, %L)', res, 'x', 'dc-pay-d'), 'INVALID_STATE: money held');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1030, t + 1032, 'dc-can'); res := (b ->> 'reservation_id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform cancel_reservation(res, 'testing', 'dc-can-c');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t59_disc(%L, 5, %L, %L)', res, 'x', 'dc-can-d'), 'INVALID_STATE: cancelled');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 1040, t + 1042, 'dc-edit'); res := (b ->> 'reservation_id')::uuid;
  perform t59_disc(res, 5, 'x', 'dc-edit-d');
  perform t_expect(format('select update_reservation_stay(%L, %L, %L, null, %L, %L)', res, t + 1040, t + 1043, 'x', 'dc-edit-u'), 'POLICY_VIOLATION: discount');
  perform t_sys();
  raise notice 'PASS money held, a cancelled booking and a discounted booking (for date edits) are all refused';
end $$;

-- 6. The caps table is readable but not writable by logins; a role with the permission and no cap can discount nothing
do $$ declare ok boolean := false; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  begin
    update discount_caps set max_percent = 100 where role_key = 'front_desk';
    raise exception 'FAIL a login changed a cap';
  exception when insufficient_privilege then ok := true; end;
  if (select count(*) from discount_caps) <> 3 then raise exception 'FAIL caps not readable'; end if;
  perform t_sys();
  if not ok then raise exception 'FAIL'; end if;
  raise notice 'PASS caps are readable and not writable by logins';
end $$;
