-- The daily money and revenue report (migration 036). Reuses t_as / t_sys / t_expect (05) and t07_res (07).
-- Users: aa01 owner A, aa04 front desk A, aa05 accountant A, aa02 housekeeping A, bb01 owner B.
-- Today's money is shared with earlier fixtures, so money checks compare before and after; room nights use offsets 1300 to 1320, which nothing else uses.
\set ON_ERROR_STOP on

create function t35_rep(p_from date, p_to date) returns jsonb language sql as $$
  select daily_report('00000000-0000-0000-0000-0000000000a2', p_from, p_to)
$$;
create function t35_n(j jsonb, k text) returns bigint language sql immutable as $$ select (j #>> array['totals', k])::bigint $$;

-- 1. Who may read it, and the range rules
do $$ declare t date := property_today('00000000-0000-0000-0000-0000000000a2'); r jsonb; begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t35_rep(%L,%L)', t, t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select t35_rep(%L,%L)', t, t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select t35_rep(%L,%L)', t, t), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  r := t35_rep(t, t);
  if jsonb_array_length(r -> 'days') <> 1 or r ->> 'currency' <> 'NGN' then raise exception 'FAIL one-day report %', r; end if;
  perform t_expect(format('select t35_rep(%L,%L)', t, t - 1), 'POLICY_VIOLATION: range');
  perform t_expect(format('select t35_rep(%L,%L)', t, t + 92), 'POLICY_VIOLATION: range');
  perform t_expect(format('select daily_report(%L,null,%L)', '00000000-0000-0000-0000-0000000000a2', t), 'POLICY_VIOLATION: range');
  if jsonb_array_length(t35_rep(t, t + 91) -> 'days') <> 92 then raise exception 'FAIL 92 days'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t35_rep(t, t);
  perform t_sys();
  raise notice 'PASS access: accountant and owner may read; front desk, housekeeping and another hotel get NOT_FOUND; 1 to 92 days only';
end $$;

-- 2. Money received and refunded move the right days and channels by exactly the amount
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; res2 uuid; total bigint; fee bigint;
  before jsonb; after jsonb; f refunds%rowtype; v_fp uuid := gen_random_uuid();
begin
  perform t_sys();
  res := t07_res(1300, 2, 't35-b1'); res2 := t07_res(1310, 2, 't35-b2');
  update reservations set policy_snapshot = policy_snapshot || '{"cancellation_rules":[{"within_hours":100000,"charge":{"type":"percent","value":30}}]}'::jsonb where id = res2;
  select total_minor into total from reservations where id = res2;
  fee := round(total * 0.30)::bigint;

  perform t_as('00000000-0000-0000-0000-00000000aa05'); before := t35_rep(t, t);
  perform t_sys();
  perform record_manual_payment(res, 100000, 'cash', 'c1', null, 't35-cash');
  perform record_manual_payment(res, 50000, 'pos', 'p1', null, 't35-pos');
  perform record_manual_payment(res2, total, 'bank_transfer', 'b1', null, 't35-bank');
  insert into folio_payments (tenant_id, property_id, reservation_id, payment_method, internal_reference, amount_minor, currency)
    select tenant_id, property_id, id, 'cash', 'T35-FP-1', 7000, currency from reservations where id = res;
  insert into payments (tenant_id, property_id, reservation_id, payment_provider, payment_method, internal_reference, amount_minor, currency)
    select tenant_id, property_id, id, 'paystack', 'card', 'T35-ON-1', 25000, currency from reservations where id = res;
  -- a reversed payment is not counted
  insert into payments (tenant_id, property_id, reservation_id, payment_method, internal_reference, amount_minor, currency, payment_status)
    select tenant_id, property_id, id, 'cash', 'T35-RV-1', 99999, currency, 'reversed' from reservations where id = res;

  perform t_as('00000000-0000-0000-0000-00000000aa05'); after := t35_rep(t, t);
  if t35_n(after, 'cash_minor') - t35_n(before, 'cash_minor') <> 107000 then raise exception 'FAIL cash delta (desk plus folio, reversed ignored)'; end if;
  if t35_n(after, 'pos_minor') - t35_n(before, 'pos_minor') <> 50000 then raise exception 'FAIL pos delta'; end if;
  if t35_n(after, 'bank_transfer_minor') - t35_n(before, 'bank_transfer_minor') <> total then raise exception 'FAIL bank delta'; end if;
  if t35_n(after, 'online_minor') - t35_n(before, 'online_minor') <> 25000 then raise exception 'FAIL online delta'; end if;
  if t35_n(after, 'received_minor') - t35_n(before, 'received_minor') <> 107000 + 50000 + total + 25000 then raise exception 'FAIL received delta'; end if;
  if (after #>> '{days,0,received_minor}')::bigint <> t35_n(after, 'received_minor') then raise exception 'FAIL day does not equal total for a one-day range'; end if;

  -- cancel booking 2 (30 percent charge), approve and pay out the refund of the rest
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform cancel_reservation(res2, 'guest cancelled', 't35-cancel');
  perform t_sys();
  select * into f from refunds where reservation_id = res2;
  perform t_as('00000000-0000-0000-0000-00000000aa05');      -- the requester (owner) cannot approve their own request
  perform approve_refund(f.id, true, null, 't35-approve');
  perform record_manual_refund(f.id, 'slip', 't35-payout');
  perform t_as('00000000-0000-0000-0000-00000000aa05'); before := after; after := t35_rep(t, t);
  if t35_n(after, 'refunded_minor') - t35_n(before, 'refunded_minor') <> total - fee then raise exception 'FAIL refunded delta %', t35_n(after, 'refunded_minor') - t35_n(before, 'refunded_minor'); end if;
  if t35_n(after, 'cancellation_charges_minor') - t35_n(before, 'cancellation_charges_minor') <> fee then raise exception 'FAIL cancellation charge delta'; end if;
  if t35_n(after, 'net_minor') <> t35_n(after, 'received_minor') - t35_n(after, 'refunded_minor') then raise exception 'FAIL net'; end if;
  raise notice 'PASS money: desk, folio, online and reversed payments land in the right channels; a paid-out refund and a cancellation charge show on today exactly';
end $$;

-- 3. Room revenue and extras follow the night and the charge date, and cancelled, pending and expired bookings add nothing
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); res uuid := (select id from reservations where arrival_date = property_today('00000000-0000-0000-0000-0000000000a2') + 1300 limit 1);
  rate bigint; tax bigint; r jsonb; web jsonb; wres uuid; 
begin
  perform t_sys();
  select sum(n.rate_minor), sum(n.tax_minor) into rate, tax from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = res;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  r := t35_rep(t + 1300, t + 1301);
  if t35_n(r, 'room_revenue_minor') <> rate or t35_n(r, 'room_tax_minor') <> tax then raise exception 'FAIL room revenue % vs % / %', r -> 'totals', rate, tax; end if;
  if (r #>> '{days,0,date}') <> (t + 1300)::text or (r #>> '{days,1,date}') <> (t + 1301)::text then raise exception 'FAIL day order'; end if;
  if t35_n(t35_rep(t + 1302, t + 1303), 'room_revenue_minor') <> 0 then raise exception 'FAIL nights after the stay counted'; end if;
  -- the cancelled booking at 1310 earns no room revenue, and the other hotel's data is not in this report
  if t35_n(t35_rep(t + 1310, t + 1311), 'room_revenue_minor') <> 0 then raise exception 'FAIL a cancelled booking earned room revenue'; end if;

  -- a pending online hold earns nothing until it is paid
  perform t_sys();
  web := create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'website', t + 1320, t + 1322,
          jsonb_build_array(jsonb_build_object('room_type_id', '00000000-0000-0000-0000-0000000000a3', 'adults', 1)), 't35-web');
  wres := (web ->> 'reservation_id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  if t35_n(t35_rep(t + 1320, t + 1321), 'room_revenue_minor') <> 0 then raise exception 'FAIL a pending hold earned room revenue'; end if;
  perform t_sys();
  perform record_manual_payment(wres, (select total_minor from reservations where id = wres), 'cash', 'w1', null, 't35-webpay');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  if t35_n(t35_rep(t + 1320, t + 1321), 'room_revenue_minor') <= 0 then raise exception 'FAIL a confirmed booking earned nothing'; end if;

  -- extras by charge date: posted counts, voided does not
  perform t_sys();
  insert into folio_charges (tenant_id, property_id, reservation_id, category, description, quantity, unit_amount_minor, tax_minor, total_minor, currency, charge_date)
    select tenant_id, property_id, id, 'minibar', 'Water', 2, 1000, 150, 2150, currency, t + 1300 from reservations where id = res;
  insert into folio_charges (tenant_id, property_id, reservation_id, category, description, quantity, unit_amount_minor, tax_minor, total_minor, currency, charge_date, status, voided_at, void_reason)
    select tenant_id, property_id, id, 'minibar', 'Voided', 1, 9000, 0, 9000, currency, t + 1300, 'voided', now(), 'mistake' from reservations where id = res;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  r := t35_rep(t + 1300, t + 1300);
  if t35_n(r, 'extras_minor') <> 2000 or t35_n(r, 'extras_tax_minor') <> 150 then raise exception 'FAIL extras %', r -> 'totals'; end if;
  raise notice 'PASS revenue: nights count on their own days for confirmed bookings only; a cancelled booking and a pending hold add nothing; posted extras count, voided do not';
end $$;
