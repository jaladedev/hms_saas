-- Moving a guest to a different room type (migration 083, change_room_type). Reuses t_as / t_sys / t_expect / t_book / t_rr (05).
-- Users: aa01 owner A, aa02 housekeeping A, aa04 front desk A. Ids: a2 property A, a3 STD (5 rooms, 25,000.00 a night base),
-- a4 SOLO (1 room, 90,000.00 a night base). Dates use offsets 1800 to 1990 from today, and 0 to 8 for the guest in the house.
\set ON_ERROR_STOP on

create function t85_fp(p_res uuid) returns text language sql stable as $$
  select concat_ws('|', r.total_minor, r.payment_status, r.attention_reason,
                   (select string_agg(x.room_type_id::text, ',' order by x.id) from reservation_rooms x where x.reservation_id = r.id),
                   (select count(*) from invoices where reservation_id = r.id),
                   (select string_agg(concat(c.room_id, c.start_date, c.end_date, c.status), ',' order by c.id) from room_inventory_claims c where c.reservation_room_id in (select id from reservation_rooms where reservation_id = r.id)),
                   (select string_agg(n.rate_minor::text, ',' order by n.night_date) from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = r.id))
    from reservations r where r.id = p_res
$$;
create function t85_chg(p_rr uuid, p_type uuid, p_eff date, p_key text) returns jsonb language sql as $$
  select change_room_type(p_rr, p_type, p_eff, 'guest asked', p_key) $$;
-- the booking totals what its nights total, and every night is priced in the type it falls in
create function t85_sound(p_res uuid) returns boolean language sql stable as $$
  select r.subtotal_minor = (select coalesce(sum(n.rate_minor), 0) from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = r.id)
     and r.tax_minor = (select coalesce(sum(n.tax_minor), 0) from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = r.id)
     and r.total_minor = r.subtotal_minor + r.tax_minor
    from reservations r where r.id = p_res
$$;
-- the claims for the stay cover every night exactly once
create function t85_covered(p_rr uuid, p_arr date, p_dep date) returns boolean language sql stable as $$
  select (select count(*) from generate_series(p_arr, p_dep - 1, interval '1 day') d
           where (select count(*) from room_inventory_claims c where c.reservation_room_id = p_rr and c.status = 'active' and c.claim_type in ('stay', 'hold')
                    and c.start_date <= d::date and c.end_date > d::date) = 1) = p_dep - p_arr
     and not exists (select 1 from room_inventory_claims c where c.reservation_room_id = p_rr and c.status = 'active' and c.claim_type in ('stay', 'hold')
                      and (c.start_date < p_arr or c.end_date > p_dep))
$$;

-- 1. Upgrade from the first night, nothing paid: every night takes the SOLO price; claim and booking move; audit
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); std uuid := '00000000-0000-0000-0000-0000000000a3'; solo uuid := '00000000-0000-0000-0000-0000000000a4';
  b jsonb; res uuid; rr uuid; r jsonb; old_total bigint;
begin
  b := t_book(std, t + 1800, t + 1803, 'ct-1-b'); res := (b ->> 'reservation_id')::uuid; rr := t_rr(b); old_total := (select total_minor from reservations where id = res);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := t85_chg(rr, solo, t + 1800, 'ct-1-k');
  perform t_sys();
  if (select room_type_id from reservation_rooms where id = rr) <> solo then raise exception 'FAIL the booking kept its type'; end if;
  if (select count(*) from reservation_nights where reservation_room_id = rr and rate_minor = 9000000) <> 3 then raise exception 'FAIL nights not at the SOLO rate'; end if;
  if (select total_minor from reservations where id = res) <= old_total or not t85_sound(res) then raise exception 'FAIL totals'; end if;
  if (select r2.room_type_id from rooms r2 join room_inventory_claims c on c.room_id = r2.id where c.reservation_room_id = rr and c.status = 'active') <> solo then raise exception 'FAIL claim not in a SOLO room'; end if;
  if not t85_covered(rr, t + 1800, t + 1803) then raise exception 'FAIL claims do not cover the stay once'; end if;
  if (select count(*) from invoices where reservation_id = res) <> 0 then raise exception 'FAIL an invoice appeared'; end if;
  if (r ->> 'nights_repriced')::int <> 3 or (r ->> 'new_total_minor')::bigint <> (select total_minor from reservations where id = res) then raise exception 'FAIL answer %', r; end if;
  if (select count(*) from audit_logs where action = 'reservation.room_type_changed' and entity_id = res) <> 1 then raise exception 'FAIL audit'; end if;
  -- a replay changes nothing and answers the same
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if t85_chg(rr, solo, t + 1800, 'ct-1-k') <> r then raise exception 'FAIL replay differs'; end if;
  perform t_sys();
  if (select count(*) from audit_logs where action = 'reservation.room_type_changed' and entity_id = res) <> 1 then raise exception 'FAIL replay audited again'; end if;
  raise notice 'PASS an unpaid booking upgraded from the first night: every night re-priced, claim and type moved, audited, replay safe';
end $$;

-- 2. Mid-stay: nights before the effective date keep their price, nights from it take the new type's
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); std uuid := '00000000-0000-0000-0000-0000000000a3'; solo uuid := '00000000-0000-0000-0000-0000000000a4';
  b jsonb; res uuid; rr uuid;
begin
  b := t_book(std, t + 1810, t + 1814, 'ct-2-b'); res := (b ->> 'reservation_id')::uuid; rr := t_rr(b);
  perform t_as('00000000-0000-0000-0000-00000000aa04'); perform t85_chg(rr, solo, t + 1812, 'ct-2-k'); perform t_sys();
  if (select string_agg(rate_minor::text, ',' order by night_date) from reservation_nights where reservation_room_id = rr) <> '2500000,2500000,9000000,9000000' then
    raise exception 'FAIL nights: %', (select string_agg(rate_minor::text, ',' order by night_date) from reservation_nights where reservation_room_id = rr); end if;
  if not t85_sound(res) or not t85_covered(rr, t + 1810, t + 1814) then raise exception 'FAIL totals or claims'; end if;
  if (select count(*) from room_inventory_claims where reservation_room_id = rr and status = 'active') <> 2 then raise exception 'FAIL expected two active claims'; end if;
  raise notice 'PASS a mid-stay change keeps the early nights at their price and re-prices the rest; claims split cleanly';
end $$;

-- 3. Paid in full and invoiced, SOLO to STD: invoice replaced, a refund flagged and none made
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); std uuid := '00000000-0000-0000-0000-0000000000a3'; solo uuid := '00000000-0000-0000-0000-0000000000a4';
  b jsonb; res uuid; rr uuid; old_total bigint; old_inv uuid; r jsonb;
begin
  b := t_book(solo, t + 1820, t + 1822, 'ct-3-b'); res := (b ->> 'reservation_id')::uuid; rr := t_rr(b); old_total := (select total_minor from reservations where id = res);
  perform t_as('00000000-0000-0000-0000-00000000aa04'); perform record_manual_payment(res, old_total, 'cash', null, null, 'ct-3-p');
  perform t_as('00000000-0000-0000-0000-00000000aa01'); perform issue_invoice(res, 'ct-3-i');
  perform t_sys(); old_inv := (select id from invoices where reservation_id = res and invoice_status <> 'void');
  perform t_as('00000000-0000-0000-0000-00000000aa04'); r := t85_chg(rr, std, t + 1820, 'ct-3-k'); perform t_sys();
  if (select invoice_status from invoices where id = old_inv) <> 'void' or (select count(*) from invoices where reservation_id = res and invoice_status <> 'void') <> 1 then raise exception 'FAIL invoice not replaced'; end if;
  if (select total_minor from invoices where reservation_id = res and invoice_status <> 'void') <> (select total_minor from reservations where id = res) then raise exception 'FAIL invoice total'; end if;
  if (select attention_reason from reservations where id = res) is distinct from 'stay_change_refund_due' then raise exception 'FAIL not flagged'; end if;
  if (r ->> 'surplus_minor')::bigint <> old_total - (select total_minor from reservations where id = res) then raise exception 'FAIL surplus %', r; end if;
  if (select count(*) from refunds where reservation_id = res) <> 0 then raise exception 'FAIL a refund was made'; end if;
  raise notice 'PASS a paid, invoiced SOLO booking moved down to STD: invoice replaced, surplus flagged, no refund made';
end $$;

-- 4. Paid in full, STD to SOLO: a balance is due, the status drops to part paid, no flag
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); std uuid := '00000000-0000-0000-0000-0000000000a3'; solo uuid := '00000000-0000-0000-0000-0000000000a4';
  b jsonb; res uuid; rr uuid;
begin
  b := t_book(std, t + 1830, t + 1832, 'ct-4-b'); res := (b ->> 'reservation_id')::uuid; rr := t_rr(b);
  perform t_as('00000000-0000-0000-0000-00000000aa04'); perform record_manual_payment(res, (select total_minor from reservations where id = res), 'cash', null, null, 'ct-4-p');
  perform t85_chg(rr, solo, t + 1830, 'ct-4-k'); perform t_sys();
  if (select payment_status from reservations where id = res) <> 'partially_paid' or (select attention_reason from reservations where id = res) is not null then raise exception 'FAIL status or flag'; end if;
  raise notice 'PASS an upgrade of a paid booking leaves a balance due and no flag';
end $$;

-- 5. A guest in the house, from a later night: the room left behind is dirty, the guest stays checked in
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); std uuid := '00000000-0000-0000-0000-0000000000a3'; solo uuid := '00000000-0000-0000-0000-0000000000a4';
  b jsonb; res uuid; rr uuid; old_room uuid;
begin
  -- earlier tests leave every STD room claimed around today. This is the last test of the run, so it frees one room's
  -- claims for the window (test data only) to be able to check a guest in today.
  perform t_sys();
  update room_inventory_claims set status = 'released'
   where status = 'active' and room_id = (select id from rooms where property_id = '00000000-0000-0000-0000-0000000000a2' and room_type_id = std order by room_number limit 1)
     and start_date < t + 9 and end_date > t - 1;
  update rooms set housekeeping_status = 'clean' where property_id = '00000000-0000-0000-0000-0000000000a2' and room_type_id = std;
  b := t_book(std, t, t + 8, 'ct-5-b'); res := (b ->> 'reservation_id')::uuid; rr := t_rr(b);
  perform t_as('00000000-0000-0000-0000-00000000aa04'); perform check_in(rr, 'arrived early, room not ready'); 
  select room_id into old_room from room_inventory_claims where reservation_room_id = rr and status = 'active';
  perform t_expect(format('select t85_chg(%L,%L,%L,%L)', rr, solo, t - 1, 'ct-5-past'), 'POLICY_VIOLATION: effective date');
  perform t85_chg(rr, solo, t + 4, 'ct-5-k'); perform t_sys();
  if (select reservation_status from reservations where id = res) <> 'checked_in' or (select room_status from reservation_rooms where id = rr) <> 'checked_in' then raise exception 'FAIL guest not still in the house'; end if;
  if (select housekeeping_status from rooms where id = old_room) <> 'dirty' then raise exception 'FAIL the old room was not marked dirty'; end if;
  if not t85_covered(rr, t, t + 8) or not t85_sound(res) then raise exception 'FAIL claims or totals'; end if;
  raise notice 'PASS a guest in the house moved up from a later night: still checked in, old room dirty, nights and claims right';
end $$;

-- 6. Refusals change nothing
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); std uuid := '00000000-0000-0000-0000-0000000000a3'; solo uuid := '00000000-0000-0000-0000-0000000000a4';
  b jsonb; res uuid; rr uuid; fp text; v_att uuid := gen_random_uuid(); res2 uuid;
begin
  -- the only SOLO room is taken on those nights
  b := t_book(solo, t + 1900, t + 1903, 'ct-6-solo');
  b := t_book(std, t + 1901, t + 1903, 'ct-6-b'); res := (b ->> 'reservation_id')::uuid; rr := t_rr(b); fp := t85_fp(res);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t85_chg(%L,%L,%L,%L)', rr, solo, t + 1901, 'ct-6-1'), 'ROOM_UNAVAILABLE');
  perform t_expect(format('select t85_chg(%L,%L,%L,%L)', rr, std, t + 1901, 'ct-6-2'), 'POLICY_VIOLATION: same room type');
  perform t_expect(format('select t85_chg(%L,%L,%L,%L)', rr, solo, t + 1900, 'ct-6-3'), 'POLICY_VIOLATION: effective date');
  perform t_expect(format('select t85_chg(%L,%L,%L,%L)', rr, solo, t + 1903, 'ct-6-4'), 'POLICY_VIOLATION: effective date');
  perform t_expect(format('select change_room_type(%L,%L,%L,%L,%L)', rr, solo, t + 1901, '  ', 'ct-6-5'), 'POLICY_VIOLATION: reason');
  perform t_expect(format('select t85_chg(%L,%L,%L,%L)', rr, gen_random_uuid(), t + 1901, 'ct-6-6'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select t85_chg(%L,%L,%L,%L)', rr, solo, t + 1905, 'ct-6-7'), 'NOT_FOUND');
  perform t_sys();
  if t85_fp(res) <> fp then raise exception 'FAIL a refused change altered the booking'; end if;

  -- discount, and a payment in flight
  b := t_book(std, t + 1920, t + 1922, 'ct-6-d'); res2 := (b ->> 'reservation_id')::uuid; rr := t_rr(b);
  perform t_as('00000000-0000-0000-0000-00000000aa01'); perform apply_discount(res2, 5, 'regular guest', 'ct-6-disc'); perform t_sys(); fp := t85_fp(res2);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t85_chg(%L,%L,%L,%L)', rr, solo, t + 1920, 'ct-6-8'), 'POLICY_VIOLATION: discount');
  perform t_sys(); if t85_fp(res2) <> fp then raise exception 'FAIL a discounted booking changed'; end if;

  b := t_book(std, t + 1940, t + 1942, 'ct-6-f'); res2 := (b ->> 'reservation_id')::uuid; rr := t_rr(b);
  insert into payment_attempts (id, tenant_id, property_id, reservation_id, provider, reference, amount_minor, currency, status)
  select v_att, tenant_id, property_id, id, 'paystack', 'ct-6-ref', 100000, currency, 'initiated' from reservations where id = res2;
  fp := t85_fp(res2);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t85_chg(%L,%L,%L,%L)', rr, solo, t + 1940, 'ct-6-9'), 'INVALID_STATE: payment started');
  perform t_sys(); if t85_fp(res2) <> fp then raise exception 'FAIL a booking with a payment in flight changed'; end if;
  raise notice 'PASS no free room, same type, bad dates, no reason, unknown type, housekeeping, a discount and a payment in flight each refuse and change nothing';
end $$;
