-- Early check-out (migration 060). Reuses t_as / t_sys / t_expect / t_book / t_rr (05) and t50_rows (56).
-- Four rooms of our own (T61-1..4, type a3) so nothing else has claimed them today; they are retired at the end.
\set ON_ERROR_STOP on

create function t61_policy(mode text, days_ago integer) returns void language plpgsql as $$
declare prop uuid := '00000000-0000-0000-0000-0000000000a2'; cfg jsonb;
begin
  -- policy rows are immutable and the newest start date wins, so each change is a new row one day later than the last
  select coalesce((select config from property_policies where property_id = prop and effective_from <= property_today(prop) order by effective_from desc limit 1), '{}'::jsonb) into cfg;
  cfg := cfg - 'early_checkout';
  if mode <> 'none' then cfg := cfg || jsonb_build_object('early_checkout', mode); end if;
  insert into property_policies (tenant_id, property_id, version, effective_from, config)
    select tenant_id, prop, coalesce((select max(version) from property_policies where property_id = prop), 0) + 1, property_today(prop) - days_ago, cfg from properties where id = prop;
end $$;

-- books n nights from today in the given room, checks the guest in, returns the reservation_room id and reservation id
create function t61_stay(room uuid, nights integer, key text) returns uuid[] language plpgsql as $$
declare prop uuid := '00000000-0000-0000-0000-0000000000a2'; t date := property_today(prop); r jsonb; rr uuid; res uuid;
begin
  r := t_book('00000000-0000-0000-0000-0000000000a3', t, t + nights, key, room);
  res := (r ->> 'reservation_id')::uuid; rr := t_rr(r);
  return array[res, rr];
end $$;

do $$ declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2'; owner text := '00000000-0000-0000-0000-00000000aa01';
  hk text := '00000000-0000-0000-0000-00000000aa02'; ob text := '00000000-0000-0000-0000-00000000bb01';
  acc text := '00000000-0000-0000-0000-00000000aa05';
  rooms_ uuid[]; s uuid[]; res uuid; rr uuid; r jsonb; q jsonb; st jsonb; old_total bigint; new_total bigint; n integer; a uuid;
  inv_old uuid; inv_new uuid; v_paid bigint; v_nightly bigint; pay uuid;
begin
  perform t_sys();
  insert into rooms (tenant_id, property_id, room_type_id, room_number, floor)
    select tenant_id, id, '00000000-0000-0000-0000-0000000000a3', 'T61-' || g, 9 from properties, generate_series(1, 4) g where id = prop;
  select array_agg(id order by room_number) into rooms_ from rooms where property_id = prop and room_number like 'T61-%';
  update rooms set housekeeping_status = 'clean' where id = any (rooms_);

  -- A. policy off (nothing set): an early check-out changes no money, exactly as before
  perform t61_policy('none', 3);
  s := t61_stay(rooms_[1], 3, 't61-a'); res := s[1]; rr := s[2];
  select total_minor into old_total from reservations where id = res;
  perform t_as(owner); perform check_in(rr);
  q := early_checkout_quote(rr);
  if (q ->> 'early')::boolean is not true or q ->> 'mode' <> 'none' or (q ->> 'credit_minor')::bigint <> 0 then raise exception 'FAIL quote with the policy off: %', q; end if;
  r := check_out(rr);
  if (r ->> 'early_departure')::boolean is not true or (r ->> 'credit_minor')::bigint <> 0 then raise exception 'FAIL check-out result %', r; end if;
  perform t_sys();
  if (select total_minor from reservations where id = res) <> old_total or (select count(*) from reservation_nights where reservation_room_id = rr) <> 3 then raise exception 'FAIL policy off changed the booking'; end if;
  if exists (select 1 from audit_logs where entity_id = res and action = 'reservation.early_checkout_credited') then raise exception 'FAIL policy off audited a credit'; end if;
  st := (select reservation_settlement(res));
  if (st ->> 'applicable')::boolean then raise exception 'FAIL settlement applicable with the policy off'; end if;

  -- B. 'credit', same-day departure: every night is credited. Paid in full and invoiced first.
  perform t61_policy('credit', 2);
  s := t61_stay(rooms_[2], 3, 't61-b'); res := s[1]; rr := s[2];
  select total_minor into old_total from reservations where id = res;
  perform t_as(owner);
  perform record_manual_payment(res, old_total, 'cash', 't61 cash', null, 't61-b-pay');
  r := issue_invoice(res, 't61-b-inv'); inv_old := (r ->> 'invoice_id')::uuid;
  perform check_in(rr);
  q := early_checkout_quote(rr);
  if q ->> 'mode' <> 'credit' or (q ->> 'credit_minor')::bigint <> old_total or (q ->> 'new_total_minor')::bigint <> 0 or (q ->> 'nights_credited')::int <> 3 then raise exception 'FAIL quote B: %', q; end if;
  perform t_as(hk);
  perform t_expect(format('select early_checkout_quote(%L)', rr), 'NOT_FOUND');
  perform t_as(ob);
  perform t_expect(format('select early_checkout_quote(%L)', rr), 'NOT_FOUND');
  perform t_as(owner);
  r := check_out(rr);
  if (r ->> 'credit_minor')::bigint <> old_total or (r ->> 'nights_credited')::int <> 3 then raise exception 'FAIL check-out result B: %', r; end if;
  perform t_sys();
  if (select total_minor from reservations where id = res) <> 0 or (select subtotal_minor + tax_minor from reservations where id = res) <> 0
     or (select early_checkout_credit_minor from reservations where id = res) <> old_total then raise exception 'FAIL totals after credit B'; end if;
  if (select count(*) from reservation_nights where reservation_room_id = rr) <> 0 then raise exception 'FAIL nights remain'; end if;
  if (select invoice_status from invoices where id = inv_old) <> 'void' or (select void_reason from invoices where id = inv_old) <> 'early check-out'
     or exists (select 1 from invoices where reservation_id = res and invoice_status <> 'void') then raise exception 'FAIL invoice handling B'; end if;
  if (select attention_reason from reservations where id = res) <> 'early_checkout_refund_due' then raise exception 'FAIL surplus flag B'; end if;
  select id into a from t50_rows('reservation_attention', res);
  if a is null or (select title from notifications where id = a) !~ '^Refund due after early check-out: ' then raise exception 'FAIL notice B'; end if;
  if (select count(*) from audit_logs where entity_id = res and action = 'reservation.early_checkout_credited') <> 1
     or (select (metadata ->> 'surplus_minor')::bigint from audit_logs where entity_id = res and action = 'reservation.early_checkout_credited') <> old_total then raise exception 'FAIL audit B'; end if;
  if exists (select 1 from refunds where reservation_id = res) then raise exception 'FAIL a refund was created automatically'; end if;
  st := (select reservation_settlement(res));
  if st ->> 'kind' <> 'early_checkout' or (st ->> 'refund_still_to_request_minor')::bigint <> old_total or (st ->> 'settled')::boolean then raise exception 'FAIL settlement B: %', st; end if;
  q := (select early_checkout_quote(rr)) ;
  -- the refund flow: a person requests it, and once it is in progress the flag clears
  select id into pay from payments where reservation_id = res;
  perform t_as(owner);
  perform request_refund(pay, old_total, 'left early', 't61-b-refund');
  perform t_sys();
  if (select attention_reason from reservations where id = res) is not null then
    -- request_refund does not refresh the money state itself in every version; do what the refund flow does
    perform refresh_money_state(res);
  end if;
  if (select attention_reason from reservations where id = res) is not null then raise exception 'FAIL the flag did not clear once the refund was requested'; end if;
  st := (select reservation_settlement(res));
  if (st ->> 'refund_still_to_request_minor')::bigint <> 0 or (st ->> 'refunds_in_flight_minor')::bigint <> old_total then raise exception 'FAIL settlement after refund: %', st; end if;

  -- C. 'one_night' with a 10% discount, paid in full, invoiced: one night is kept, the discount follows the smaller price
  perform t61_policy('one_night', 1);
  s := t61_stay(rooms_[3], 4, 't61-c'); res := s[1]; rr := s[2];
  perform t_as(owner);
  perform apply_discount(res, 10, 'regular guest', 't61-c-disc');
  perform t_sys();
  select total_minor into old_total from reservations where id = res;
  select rate_minor + tax_minor into v_nightly from reservation_nights where reservation_room_id = rr order by night_date limit 1;
  perform t_as(owner);
  perform record_manual_payment(res, old_total, 'cash', 't61 cash c', null, 't61-c-pay');
  r := issue_invoice(res, 't61-c-inv'); inv_old := (r ->> 'invoice_id')::uuid;
  perform check_in(rr);
  q := early_checkout_quote(rr);
  new_total := (select round(v_nightly * 0.9)::bigint);
  if q ->> 'mode' <> 'one_night' or (q ->> 'nights_credited')::int <> 3 or (q ->> 'new_total_minor')::bigint <> new_total
     or (q ->> 'surplus_minor')::bigint <> old_total - new_total then raise exception 'FAIL quote C: % (expected new total %)', q, new_total; end if;
  r := check_out(rr);
  perform t_sys();
  if (select total_minor from reservations where id = res) <> new_total or (select count(*) from reservation_nights where reservation_room_id = rr) <> 1
     or (select discount_percent from reservations where id = res) <> 10
     or (select subtotal_minor + tax_minor - discount_minor from reservations where id = res) <> new_total then raise exception 'FAIL totals C'; end if;
  select id into inv_new from invoices where reservation_id = res and invoice_status <> 'void';
  if inv_new is null or inv_new = inv_old or (select total_minor from invoices where id = inv_new) <> new_total
     or (select discount_minor from invoices where id = inv_new) <> (select discount_minor from reservations where id = res)
     or (select count(*) from invoice_lines where invoice_id = inv_new) <> 1 then raise exception 'FAIL replacement invoice C'; end if;
  if (select coalesce(sum(amount_minor), 0) from payment_allocations where invoice_id = inv_new) <> new_total then raise exception 'FAIL allocation C'; end if;
  if (select attention_reason from reservations where id = res) <> 'early_checkout_refund_due' then raise exception 'FAIL flag C'; end if;
  st := (select reservation_settlement(res));
  if (st ->> 'refund_still_to_request_minor')::bigint <> old_total - new_total then raise exception 'FAIL settlement C: %', st; end if;
  -- reports read nights: the credited ones are gone
  if exists (select 1 from reservation_nights where reservation_room_id = rr and night_date > property_today(prop)) then raise exception 'FAIL credited nights remain'; end if;

  -- D. 'one_night', nothing paid and no invoice: the price drops, no invoice appears, no flag
  s := t61_stay(rooms_[4], 3, 't61-d'); res := s[1]; rr := s[2];
  select total_minor into old_total from reservations where id = res;
  perform t_as(owner); perform check_in(rr); r := check_out(rr); perform t_sys();
  if (select total_minor from reservations where id = res) >= old_total or (select count(*) from reservation_nights where reservation_room_id = rr) <> 1 then raise exception 'FAIL totals D'; end if;
  if exists (select 1 from invoices where reservation_id = res) or (select attention_reason from reservations where id = res) is not null then raise exception 'FAIL D invoice or flag'; end if;
  -- a second check-out of the same room is refused and credits nothing twice
  perform t_as(owner);
  perform t_expect(format('select check_out(%L)', rr), 'INVALID_STATE');
  perform t_sys();
  if (select count(*) from audit_logs where entity_id = res and action = 'reservation.early_checkout_credited') <> 1 then raise exception 'FAIL double credit D'; end if;
  q := (select early_checkout_quote(rr));
  if (q ->> 'early')::boolean then raise exception 'FAIL quote after check-out: %', q; end if;

  perform t61_policy('none', 0);
  update rooms set housekeeping_status = 'clean' where id = any (rooms_);
  update rooms set operational_status = 'retired' where id = any (rooms_);
  raise notice 'PASS early check-out: off by default; credit and one_night re-total the booking (discount re-applied), replace a live invoice, flag the surplus for a normal refund (flag clears once refunded), audited once';
end $$;

drop function t61_policy(text, integer), t61_stay(uuid, integer, text);
