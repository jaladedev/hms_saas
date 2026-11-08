-- Early check-in (migration 061). Reuses t_as / t_sys / t_expect / t_book / t_rr (05) and t50_rows (56).
-- Rooms of our own (T62-1..6, type a3). Policy rows are immutable, so the test edits the one in force with triggers off
-- (session_replication_role = replica) and puts it back at the end.
\set ON_ERROR_STOP on

create function t62_days(d integer) returns void language plpgsql as $$
declare prop uuid := '00000000-0000-0000-0000-0000000000a2'; cfg jsonb; pid uuid;
begin
  set local session_replication_role = replica;
  select id, config into pid, cfg from property_policies where property_id = prop and effective_from <= property_today(prop) order by effective_from desc limit 1;
  if pid is null then raise exception 'FAIL test needs a policy row in force'; end if;
  cfg := cfg - 'early_checkin_days';
  if d > 0 then cfg := cfg || jsonb_build_object('early_checkin_days', d); end if;
  update property_policies set config = cfg where id = pid;
  set local session_replication_role = origin;
end $$;

create function t62_book(room uuid, from_today integer, nights integer, key text) returns uuid[] language plpgsql as $$
declare prop uuid := '00000000-0000-0000-0000-0000000000a2'; t date := property_today(prop); r jsonb;
begin
  r := t_book('00000000-0000-0000-0000-0000000000a3', t + from_today, t + from_today + nights, key, room);
  return array[(r ->> 'reservation_id')::uuid, t_rr(r)];
end $$;

do $$ declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2'; t date;
  owner text := '00000000-0000-0000-0000-00000000aa01'; hk text := '00000000-0000-0000-0000-00000000aa02'; ob text := '00000000-0000-0000-0000-00000000bb01';
  rooms_ uuid[]; s uuid[]; res uuid; rr uuid; r jsonb; q jsonb; old_total bigint; n integer; v_price bigint; inv_old uuid; inv_new uuid; v_levy bigint;
  s2 uuid[]; res2 uuid; rr2 uuid; room_after uuid;
begin
  perform t_sys();
  t := property_today(prop);
  insert into rooms (tenant_id, property_id, room_type_id, room_number, floor)
    select tenant_id, id, '00000000-0000-0000-0000-0000000000a3', 'T62-' || g, 9 from properties, generate_series(1, 6) g where id = prop;
  select array_agg(id order by room_number) into rooms_ from rooms where property_id = prop and room_number like 'T62-%';
  update rooms set housekeeping_status = 'clean' where id = any (rooms_);

  -- A. off by default: refused, and the quote says why; plain check_in is still refused
  perform t62_days(0);
  s := t62_book(rooms_[1], 2, 2, 't62-a'); res := s[1]; rr := s[2];
  perform t_as(owner);
  q := early_checkin_quote(rr);
  if (q ->> 'allowed')::boolean or q ->> 'why_not' <> 'off' then raise exception 'FAIL quote with the policy off: %', q; end if;
  perform t_expect(format('select early_check_in(%L, %L)', rr, 'guest arrived early'), 'POLICY_VIOLATION: EARLY_CHECKIN_NOT_SUPPORTED');
  perform t_expect(format('select check_in(%L)', rr), 'POLICY_VIOLATION: EARLY_CHECKIN_NOT_SUPPORTED');
  perform t_sys();

  -- B. on, up to 3 days: two nights early, no money yet
  perform t62_days(3);
  perform t_as(owner);
  q := early_checkin_quote(rr);
  select rate_minor + tax_minor into v_price from reservation_nights where reservation_room_id = rr order by night_date limit 1;
  select total_minor into old_total from reservations where id = res;
  if not (q ->> 'allowed')::boolean or (q ->> 'days_early')::int <> 2 or (q ->> 'nights_added')::int <> 2 or (q ->> 'max_days')::int <> 3
     or (q ->> 'added_minor')::bigint <= 0 then raise exception 'FAIL quote B: %', q; end if;
  perform t_expect(format('select early_check_in(%L, %L)', rr, '   '), 'POLICY_VIOLATION: reason');
  perform t_as(hk);
  perform t_expect(format('select early_check_in(%L, %L)', rr, 'x'), 'NOT_FOUND');
  perform t_expect(format('select early_checkin_quote(%L)', rr), 'NOT_FOUND');
  perform t_as(ob);
  perform t_expect(format('select early_check_in(%L, %L)', rr, 'x'), 'NOT_FOUND');
  perform t_as(owner);
  r := early_check_in(rr, 'guest landed early, room is ready');
  if r ->> 'status' <> 'checked_in' or (r ->> 'nights_added')::int <> 2 or (r ->> 'added_minor')::bigint <> (q ->> 'added_minor')::bigint then raise exception 'FAIL result B: %', r; end if;
  perform t_sys();
  if (select arrival_date from reservations where id = res) <> t or (select reservation_status from reservations where id = res) <> 'checked_in'
     or (select room_status from reservation_rooms where id = rr) <> 'checked_in' then raise exception 'FAIL state B'; end if;
  if (select count(*) from reservation_nights where reservation_room_id = rr) <> 4 or (select min(night_date) from reservation_nights where reservation_room_id = rr) <> t
     or (select max(night_date) from reservation_nights where reservation_room_id = rr) <> t + 3 then raise exception 'FAIL nights B'; end if;
  if (select total_minor from reservations where id = res) <> old_total + (q ->> 'added_minor')::bigint
     or (select subtotal_minor + tax_minor - discount_minor from reservations where id = res) <> (select total_minor from reservations where id = res) then raise exception 'FAIL totals B'; end if;
  if (select count(*) from room_inventory_claims where reservation_room_id = rr and status = 'active' and claim_type = 'stay') <> 1
     or (select start_date from room_inventory_claims where reservation_room_id = rr and status = 'active' and claim_type = 'stay') <> t then raise exception 'FAIL claim B'; end if;
  if (select count(*) from audit_logs where entity_id = res and action = 'reservation.early_checked_in') <> 1
     or (select metadata ->> 'reason' from audit_logs where entity_id = res and action = 'reservation.early_checked_in') <> 'guest landed early, room is ready' then raise exception 'FAIL audit B'; end if;
  perform t_as(owner);
  perform t_expect(format('select early_check_in(%L, %L)', rr, 'again'), 'INVALID_STATE');
  perform t_sys();

  -- C. too early: arrival in 4 days, policy allows 3
  s := t62_book(rooms_[2], 4, 1, 't62-c'); rr := s[2];
  perform t_as(owner);
  q := early_checkin_quote(rr);
  if (q ->> 'allowed')::boolean or q ->> 'why_not' <> 'too_early' then raise exception 'FAIL quote C: %', q; end if;
  perform t_expect(format('select early_check_in(%L, %L)', rr, 'x'), 'POLICY_VIOLATION: EARLY_CHECKIN_TOO_EARLY');
  perform t_sys();
  -- arriving today or already in house is not "early"
  s := t62_book(rooms_[2], 0, 1, 't62-c2'); rr := s[2];
  perform t_as(owner);
  q := early_checkin_quote(rr);
  if q ->> 'why_not' <> 'not_early' then raise exception 'FAIL quote not early: %', q; end if;
  perform t_sys();

  -- D. a 10% discount, paid in part, invoiced: the discount follows the larger price, the invoice is replaced, the money stays allocated
  s := t62_book(rooms_[3], 1, 2, 't62-d'); res := s[1]; rr := s[2];
  perform t_as(owner);
  perform apply_discount(res, 10, 'regular guest', 't62-d-disc');
  perform t_sys();
  select total_minor into old_total from reservations where id = res;
  perform t_as(owner);
  perform record_manual_payment(res, 1000, 'cash', 't62 cash', null, 't62-d-pay');
  r := issue_invoice(res, 't62-d-inv'); inv_old := (r ->> 'invoice_id')::uuid;
  q := early_checkin_quote(rr);
  r := early_check_in(rr, 'early arrival');
  perform t_sys();
  select total_minor into n from reservations where id = res;
  if (select total_minor from reservations where id = res) <> (q ->> 'new_total_minor')::bigint or (select total_minor from reservations where id = res) <= old_total
     or (select discount_percent from reservations where id = res) <> 10
     or (select discount_minor from reservations where id = res) <> round((select subtotal_minor + tax_minor from reservations where id = res) * 0.10) then raise exception 'FAIL totals D'; end if;
  select id into inv_new from invoices where reservation_id = res and invoice_status <> 'void';
  if (select invoice_status from invoices where id = inv_old) <> 'void' or (select void_reason from invoices where id = inv_old) <> 'early check-in'
     or inv_new is null or inv_new = inv_old or (select total_minor from invoices where id = inv_new) <> (select total_minor from reservations where id = res)
     or (select count(*) from invoice_lines where invoice_id = inv_new) <> 3 then raise exception 'FAIL invoice D'; end if;
  if (select coalesce(sum(amount_minor), 0) from payment_allocations where invoice_id = inv_new) <> 1000 then raise exception 'FAIL allocation D'; end if;
  if (select payment_status from reservations where id = res) <> 'partially_paid' or (select attention_reason from reservations where id = res) is not null then raise exception 'FAIL status D'; end if;

  -- E. the room is taken tonight: the stay moves to another free room of the type
  s2 := t62_book(rooms_[4], 0, 1, 't62-e1');      -- sits in room 4 tonight
  s := t62_book(rooms_[4], 1, 1, 't62-e2'); res := s[1]; rr := s[2];   -- arrives tomorrow in room 4
  perform t_as(owner);
  r := early_check_in(rr, 'early arrival, other room');
  perform t_sys();
  select room_id into room_after from room_inventory_claims where reservation_room_id = rr and status = 'active' and claim_type = 'stay';
  if room_after = rooms_[4] or room_after is null or (r ->> 'room_id')::uuid <> room_after
     or not (select (metadata ->> 'room_changed')::boolean from audit_logs where entity_id = res and action = 'reservation.early_checked_in') then raise exception 'FAIL room move E'; end if;

  -- F. a per-stay levy moves to the new first night, once
  insert into tax_rules (tenant_id, property_id, name, basis, rate_value, sequence, effective_from)
    select tenant_id, id, 'T62 levy', 'fixed_per_stay', 300000, 9, t - 1 from properties where id = prop;
  s := t62_book(rooms_[6], 2, 1, 't62-f'); res := s[1]; rr := s[2];
  select sum(stay_tax_minor) into v_levy from reservation_nights where reservation_room_id = rr;
  if v_levy <> 300000 then raise exception 'FAIL fixture: levy %', v_levy; end if;
  perform t_as(owner);
  perform early_check_in(rr, 'early arrival');
  perform t_sys();
  if (select sum(stay_tax_minor) from reservation_nights where reservation_room_id = rr) <> 300000
     or (select stay_tax_minor from reservation_nights where reservation_room_id = rr and night_date = t) <> 300000
     or (select count(*) from reservation_nights where reservation_room_id = rr and stay_tax_minor > 0) <> 1 then raise exception 'FAIL levy move'; end if;
  update tax_rules set status = 'inactive' where name = 'T62 levy';

  perform t62_days(0);
  update rooms set operational_status = 'retired' where id = any (rooms_);
  raise notice 'PASS early check-in: off by default; on, a reason is required and the stay is extended back (room, nights, levy, discount, invoice) and checked in; too early, not early and other hotels refused; a taken room moves the stay';
end $$;

drop function t62_days(integer), t62_book(uuid, integer, integer, text);
