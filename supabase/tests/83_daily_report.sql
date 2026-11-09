-- daily_report (migration 036). Reuses t_as / t_sys / t_expect (05). aa01 owner A, aa05 accountant A, aa04 front desk A,
-- aa02 housekeeping A, bb01 owner B. Property a2, room type a3, guest a5. Offset 1200 days: no other test books there.
\set ON_ERROR_STOP on

create table t36_ctx (label text primary key, val text not null);
create function t36_get(p_label text) returns text language sql stable as $$ select val from t36_ctx where label = p_label $$;
create function t36_cash(p_day date) returns bigint language sql stable as $$
  select cash_in_minor from daily_report('00000000-0000-0000-0000-0000000000a2', p_day, p_day)
$$;

-- 1. Who may read it, and bad ranges
do $$ declare t date := property_today('00000000-0000-0000-0000-0000000000a2'); u text; begin
  foreach u in array array['00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-00000000bb01'] loop
    perform t_as(u);
    perform t_expect(format('select * from daily_report(%L, %L, %L)', '00000000-0000-0000-0000-0000000000a2', t, t), 'NOT_FOUND');
  end loop;
  foreach u in array array['00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000aa05'] loop
    perform t_as(u);
    if (select count(*) from daily_report('00000000-0000-0000-0000-0000000000a2', t, t + 2)) <> 3 then raise exception 'FAIL % got the wrong number of days', u; end if;
  end loop;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select * from daily_report(%L, %L, %L)', '00000000-0000-0000-0000-0000000000a2', t + 1, t), 'POLICY_VIOLATION');
  perform t_expect(format('select * from daily_report(%L, %L, %L)', '00000000-0000-0000-0000-0000000000a2', t, t + 400), 'POLICY_VIOLATION');
  perform t_sys();
  raise notice 'PASS only report.view at the property reads the report; bad ranges are refused';
end $$;

-- 2. A paid stay shows up as nights, revenue and cash; extras and a folio payment too
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); h jsonb; res uuid; tot bigint; cash0 bigint;
  rate_sum bigint; tax_sum bigint; r record; avail bigint;
begin
  select count(*) into avail from rooms where property_id = '00000000-0000-0000-0000-0000000000a2' and operational_status = 'active';
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  cash0 := t36_cash(t);
  h := create_staff_hold('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'phone', t + 1200, t + 1202,
    jsonb_build_array(jsonb_build_object('room_type_id', '00000000-0000-0000-0000-0000000000a3', 'adults', 1)), 'dr-hold');
  res := (h ->> 'reservation_id')::uuid;
  perform t_sys();
  select total_minor into tot from reservations where id = res;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform record_manual_payment(res, tot, 'cash', null, null, 'dr-pay');
  perform t_sys();
  if (select reservation_status from reservations where id = res) <> 'confirmed' then raise exception 'FAIL the stay is not confirmed'; end if;
  select sum(n.rate_minor), sum(n.tax_minor) into rate_sum, tax_sum
    from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = res;

  perform t_as('00000000-0000-0000-0000-00000000aa05');
  for r in select * from daily_report('00000000-0000-0000-0000-0000000000a2', t + 1200, t + 1202) loop
    if r.day < t + 1202 and r.rooms_sold <> 1 then raise exception 'FAIL % sold % rooms', r.day, r.rooms_sold; end if;
    if r.day = t + 1202 and r.rooms_sold <> 0 then raise exception 'FAIL the departure day sold a room'; end if;
  end loop;
  if (select sum(room_revenue_minor) from daily_report('00000000-0000-0000-0000-0000000000a2', t + 1200, t + 1202)) <> rate_sum then raise exception 'FAIL room revenue'; end if;
  if (select sum(room_tax_minor) from daily_report('00000000-0000-0000-0000-0000000000a2', t + 1200, t + 1202)) <> tax_sum then raise exception 'FAIL room tax'; end if;
  if (select min(rooms_available) from daily_report('00000000-0000-0000-0000-0000000000a2', t + 1200, t + 1202))
     <> avail then raise exception 'FAIL rooms available'; end if;
  if t36_cash(t) - cash0 <> tot then raise exception 'FAIL cash today moved by %, expected %', t36_cash(t) - cash0, tot; end if;

  -- extras and a folio payment, written as the system: the folio functions need a checked-in stay, which this test does not need
  perform t_sys();
  insert into folio_charges (tenant_id, property_id, reservation_id, category, description, quantity, unit_amount_minor, tax_minor, total_minor, currency, charge_date)
  select tenant_id, property_id, id, 'minibar', 'water', 2, 100000, 15000, 215000, 'NGN', t + 1200 from reservations where id = res;
  insert into folio_charges (tenant_id, property_id, reservation_id, category, description, quantity, unit_amount_minor, tax_minor, total_minor, currency, charge_date, status, voided_at, void_reason)
  select tenant_id, property_id, id, 'laundry', 'voided', 1, 500000, 0, 500000, 'NGN', t + 1200, 'voided', now(), 'test' from reservations where id = res;
  insert into folio_payments (tenant_id, property_id, reservation_id, payment_method, internal_reference, amount_minor, currency)
  select tenant_id, property_id, id, 'cash', 'dr-folio-pay', 215000, 'NGN' from reservations where id = res;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  select * into r from daily_report('00000000-0000-0000-0000-0000000000a2', t + 1200, t + 1200);
  if r.extras_minor <> 200000 or r.extras_tax_minor <> 15000 then raise exception 'FAIL extras % / % (a voided charge must not count)', r.extras_minor, r.extras_tax_minor; end if;
  if t36_cash(t) - cash0 <> tot + 215000 then raise exception 'FAIL a folio payment is not in cash received'; end if;
  perform t_sys();
  insert into t36_ctx values ('res', res::text);
  raise notice 'PASS nights, room revenue, tax, extras (not voided) and cash (including folio payments) are reported';
end $$;

-- 3. A cancelled stay stops counting as sold nights
do $$ declare t date := property_today('00000000-0000-0000-0000-0000000000a2'); begin
  update reservations set reservation_status = 'cancelled' where id = t36_get('res')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  if (select sum(rooms_sold) from daily_report('00000000-0000-0000-0000-0000000000a2', t + 1200, t + 1202)) <> 0 then raise exception 'FAIL a cancelled stay still counts as sold'; end if;
  perform t_sys();
  raise notice 'PASS a cancelled stay is not sold nights';
end $$;

-- 4. Money in and out. Ported from the old jsonb test (35_daily_report.sql). Desk, POS, bank, online and folio payments all
-- land in cash_in_minor; a reversed payment does not; a paid-out refund moves refunds_paid_minor by exactly the amount.
-- Today's money is shared with earlier fixtures, so this compares before and after. Offsets 1300 and 1310 are used by nothing else.
create function t36_refunds(p_day date) returns bigint language sql stable as $$
  select refunds_paid_minor from daily_report('00000000-0000-0000-0000-0000000000a2', p_day, p_day)
$$;
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); res uuid; res2 uuid; total bigint; fee bigint;
  c0 bigint; c1 bigint; r0 bigint; r1 bigint; f refunds%rowtype;
begin
  perform t_sys();
  res := t07_res(1300, 2, 'dr-b1'); res2 := t07_res(1310, 2, 'dr-b2');
  update reservations set policy_snapshot = policy_snapshot || '{"cancellation_rules":[{"within_hours":100000,"charge":{"type":"percent","value":30}}]}'::jsonb where id = res2;
  select total_minor into total from reservations where id = res2;
  fee := round(total * 0.30)::bigint;

  perform t_as('00000000-0000-0000-0000-00000000aa05'); c0 := t36_cash(t); r0 := t36_refunds(t);
  perform t_sys();
  perform record_manual_payment(res, 100000, 'cash', 'c1', null, 'dr-cash');
  perform record_manual_payment(res, 50000, 'pos', 'p1', null, 'dr-pos');
  perform record_manual_payment(res2, total, 'bank_transfer', 'b1', null, 'dr-bank');
  insert into folio_payments (tenant_id, property_id, reservation_id, payment_method, internal_reference, amount_minor, currency)
    select tenant_id, property_id, id, 'cash', 'DR-FP-1', 7000, currency from reservations where id = res;
  insert into payments (tenant_id, property_id, reservation_id, payment_provider, payment_method, internal_reference, amount_minor, currency)
    select tenant_id, property_id, id, 'paystack', 'card', 'DR-ON-1', 25000, currency from reservations where id = res;
  -- a reversed payment is not counted
  insert into payments (tenant_id, property_id, reservation_id, payment_method, internal_reference, amount_minor, currency, payment_status)
    select tenant_id, property_id, id, 'cash', 'DR-RV-1', 99999, currency, 'reversed' from reservations where id = res;

  perform t_as('00000000-0000-0000-0000-00000000aa05'); c1 := t36_cash(t); r1 := t36_refunds(t);
  if c1 - c0 <> 100000 + 7000 + 50000 + total + 25000 then
    raise exception 'FAIL cash in moved by %, expected % (desk, pos, bank, online and folio; reversed ignored)',
      c1 - c0, 100000 + 7000 + 50000 + total + 25000;
  end if;
  if r1 <> r0 then raise exception 'FAIL refunds moved before any payout'; end if;

  -- cancel booking 2 (30 percent charge); approve and pay out the rest. The requester (owner) cannot approve their own request.
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform cancel_reservation(res2, 'guest cancelled', 'dr-cancel');
  perform t_sys();
  select * into f from refunds where reservation_id = res2;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform approve_refund(f.id, true, null, 'dr-approve');
  perform record_manual_refund(f.id, 'slip', 'dr-payout');
  perform t_as('00000000-0000-0000-0000-00000000aa05'); c0 := c1; r0 := r1; c1 := t36_cash(t); r1 := t36_refunds(t);
  if r1 - r0 <> total - fee then
    raise exception 'FAIL refunds paid moved by %, expected %', r1 - r0, total - fee;
  end if;
  if c1 <> c0 then raise exception 'FAIL a refund changed cash in'; end if;
  perform t_sys();
  raise notice 'PASS money: desk, pos, bank, online and folio payments are cash in, a reversed payment is not, a paid-out refund shows on today exactly';
end $$;

-- 5. Room revenue follows the night. A booking cancelled through cancel_reservation and a pending online hold add nothing.
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); res uuid := (select id from reservations where arrival_date = property_today('00000000-0000-0000-0000-0000000000a2') + 1300 limit 1);
  rate bigint; tax bigint; r record; web jsonb; wres uuid;
begin
  perform t_sys();
  select sum(n.rate_minor), sum(n.tax_minor) into rate, tax
    from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = res;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  select sum(room_revenue_minor) as rev, sum(room_tax_minor) as tx, sum(rooms_sold) as sold into r from daily_report('00000000-0000-0000-0000-0000000000a2', t + 1300, t + 1301);
  if r.rev <> rate or r.tx <> tax or r.sold <> 2 then raise exception 'FAIL room revenue % / % / % vs % / %', r.rev, r.tx, r.sold, rate, tax; end if;
  if (select sum(room_revenue_minor) from daily_report('00000000-0000-0000-0000-0000000000a2', t + 1302, t + 1303)) <> 0 then raise exception 'FAIL nights after the stay counted'; end if;
  if (select sum(room_revenue_minor) from daily_report('00000000-0000-0000-0000-0000000000a2', t + 1310, t + 1311)) <> 0 then raise exception 'FAIL a cancelled booking earned room revenue'; end if;

  -- a pending online hold earns nothing until it is paid
  perform t_sys();
  web := create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'website', t + 1320, t + 1322,
          jsonb_build_array(jsonb_build_object('room_type_id', '00000000-0000-0000-0000-0000000000a3', 'adults', 1)), 'dr-web');
  wres := (web ->> 'reservation_id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  if (select sum(room_revenue_minor) from daily_report('00000000-0000-0000-0000-0000000000a2', t + 1320, t + 1321)) <> 0 then raise exception 'FAIL a pending hold earned room revenue'; end if;
  perform t_sys();
  perform record_manual_payment(wres, (select total_minor from reservations where id = wres), 'cash', 'w1', null, 'dr-webpay');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  if (select sum(room_revenue_minor) from daily_report('00000000-0000-0000-0000-0000000000a2', t + 1320, t + 1321)) <= 0 then raise exception 'FAIL a paid booking earned nothing'; end if;
  perform t_sys();
  raise notice 'PASS revenue: paid nights count on their own days; a cancelled booking and a pending hold add nothing';
end $$;
