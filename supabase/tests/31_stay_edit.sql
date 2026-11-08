-- Editing a booking's dates and guests (migration 033, update_reservation_stay). Reuses t_as / t_sys / t_expect / t_book / t_rr (05)
-- and t21_room (21). Users: aa01 owner A, aa02 housekeeping A, aa04 front desk A, aa05 accountant A, bb01 owner of Hotel B.
-- Ids: a2 property A, a3 the STD room type (5 rooms, 2 adults, 2 in all), a5 guest A.
-- Dates are relative to today in the property's timezone; this file uses offsets 700 to 860 (earlier files, the race fixtures included, use up to about 550).
\set ON_ERROR_STOP on

create table t31_ctx (label text primary key, val text not null);
create function t31_get(p_label text) returns text language sql stable as $$ select val from t31_ctx where label = p_label $$;

create function t31_upd(p_res uuid, p_arr date, p_dep date, p_guests text, p_reason text, p_key text) returns jsonb
language sql as $$ select update_reservation_stay(p_res, p_arr, p_dep, p_guests::jsonb, p_reason, p_key) $$;

-- Everything the edit may touch on one booking, as one string, so "nothing changed" is a single comparison.
create function t31_fp(p_res uuid) returns text language sql stable as $$
  select concat_ws('|', r.arrival_date, r.departure_date, r.subtotal_minor, r.tax_minor, r.total_minor, r.reservation_status,
    (select count(*) || ':' || coalesce(sum(n.rate_minor), 0) || ':' || coalesce(sum(n.tax_minor), 0) || ':' || coalesce(min(n.night_date)::text, '') || ':' || coalesce(max(n.night_date)::text, '')
       from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = r.id),
    (select coalesce(string_agg(c.room_id || '@' || c.start_date || '-' || c.end_date || '/' || c.status, ',' order by c.start_date, c.id), '')
       from room_inventory_claims c join reservation_rooms x on x.id = c.reservation_room_id where x.reservation_id = r.id),
    (select coalesce(string_agg(x.adults || 'a' || x.children || 'c', ',' order by x.id), '') from reservation_rooms x where x.reservation_id = r.id))
  from reservations r where r.id = p_res
$$;
create function t31_claim_room(p_res uuid) returns uuid language sql stable as $$
  select c.room_id from room_inventory_claims c join reservation_rooms x on x.id = c.reservation_room_id
   where x.reservation_id = p_res and c.status = 'active' and c.claim_type = 'stay' order by c.start_date limit 1
$$;
create function t31_audits(p_res uuid) returns bigint language sql stable as $$
  select count(*) from audit_logs where action = 'reservation.stay_changed' and entity_id = p_res
$$;

-- 1. A three-night booking to work on, and who may edit it
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; r jsonb;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 700, t + 703, 'se-book-a');
  res := (b ->> 'reservation_id')::uuid;
  perform t_sys();
  insert into t31_ctx values ('a', res::text), ('a_rr', t_rr(b)::text);

  -- who may edit: front desk yes; housekeeping, accountant and another hotel's owner see nothing
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select t31_upd(%L,%L,%L,null,%L,%L)', res, t + 700, t + 704, 'x', 'se-hk'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select t31_upd(%L,%L,%L,null,%L,%L)', res, t + 700, t + 704, 'x', 'se-acc'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select t31_upd(%L,%L,%L,null,%L,%L)', res, t + 700, t + 704, 'x', 'se-b'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t31_upd(%L,%L,%L,null,%L,%L)', gen_random_uuid(), t + 700, t + 704, 'x', 'se-none'), 'NOT_FOUND');
  perform t_sys();
  if t31_audits(res) <> 0 then raise exception 'FAIL a refused edit was audited'; end if;
  raise notice 'PASS permissions: front desk may edit; housekeeping, accountant, another hotel and an unknown booking get NOT_FOUND';
end $$;

-- 2. Input is checked before anything changes
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); res uuid := t31_get('a')::uuid; rr uuid := t31_get('a_rr')::uuid; fp text;
begin
  perform t_sys(); fp := t31_fp(res);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t31_upd(%L,%L,%L,null,%L,%L)', res, t + 700, t + 704, '   ', 'se-i1'), 'POLICY_VIOLATION: reason');
  perform t_expect(format('select t31_upd(%L,%L,%L,null,%L,%L)', res, t + 700, t + 704, repeat('r', 201), 'se-i2'), 'POLICY_VIOLATION: reason');
  perform t_expect(format('select t31_upd(%L,%L,%L,null,%L,%L)', res, t + 704, t + 704, 'x', 'se-i3'), 'POLICY_VIOLATION: departure must follow arrival');
  perform t_expect(format('select t31_upd(%L,%L,%L,null,%L,%L)', res, t + 705, t + 704, 'x', 'se-i4'), 'POLICY_VIOLATION: departure must follow arrival');
  perform t_expect(format('select t31_upd(%L,null,%L,null,%L,%L)', res, t + 704, 'x', 'se-i5'), 'POLICY_VIOLATION: departure must follow arrival');
  perform t_expect(format('select t31_upd(%L,%L,%L,null,%L,%L)', res, t + 700, t + 731, 'x', 'se-i6'), 'POLICY_VIOLATION: stay too long');
  perform t_expect(format('select t31_upd(%L,%L,%L,null,%L,%L)', res, t - 1, t + 2, 'x', 'se-i7'), 'POLICY_VIOLATION: arrival in the past');
  perform t_expect(format('select t31_upd(%L,%L,%L,%L,%L,%L)', res, t + 700, t + 703, '{"a":1}', 'x', 'se-i8'), 'POLICY_VIOLATION: guests');
  perform t_expect(format('select t31_upd(%L,%L,%L,%L,%L,%L)', res, t + 700, t + 703, '[{"adults":1}]', 'x', 'se-i9'), 'POLICY_VIOLATION: guests');
  perform t_expect(format('select t31_upd(%L,%L,%L,%L,%L,%L)', res, t + 700, t + 703, '[{"reservation_room_id":"nope","adults":1}]', 'x', 'se-i10'), 'POLICY_VIOLATION: guests');
  perform t_expect(format('select t31_upd(%L,%L,%L,%L,%L,%L)', res, t + 700, t + 703,
    format('[{"reservation_room_id":"%s","adults":1},{"reservation_room_id":"%s","adults":1}]', rr, rr), 'x', 'se-i11'), 'POLICY_VIOLATION: guests');
  perform t_expect(format('select t31_upd(%L,%L,%L,%L,%L,%L)', res, t + 700, t + 703,
    format('[{"reservation_room_id":"%s","adults":1}]', gen_random_uuid()), 'x', 'se-i12'), 'POLICY_VIOLATION: room');
  -- capacity: STD takes at most 2 adults and 2 people in all
  perform t_expect(format('select t31_upd(%L,%L,%L,%L,%L,%L)', res, t + 700, t + 703,
    format('[{"reservation_room_id":"%s","adults":3,"children":0}]', rr), 'x', 'se-i13'), 'CAPACITY_EXCEEDED');
  perform t_expect(format('select t31_upd(%L,%L,%L,%L,%L,%L)', res, t + 700, t + 703,
    format('[{"reservation_room_id":"%s","adults":0,"children":0}]', rr), 'x', 'se-i14'), 'CAPACITY_EXCEEDED');
  perform t_expect(format('select t31_upd(%L,%L,%L,%L,%L,%L)', res, t + 700, t + 703,
    format('[{"reservation_room_id":"%s","adults":2,"children":1}]', rr), 'x', 'se-i15'), 'CAPACITY_EXCEEDED');
  -- a bad guest entry stops a date change too: nothing is half done
  perform t_expect(format('select t31_upd(%L,%L,%L,%L,%L,%L)', res, t + 700, t + 705,
    format('[{"reservation_room_id":"%s","adults":3}]', rr), 'x', 'se-i16'), 'CAPACITY_EXCEEDED');
  perform t_sys();
  if t31_fp(res) <> fp then raise exception 'FAIL a refused edit changed the booking'; end if;
  if t31_audits(res) <> 0 then raise exception 'FAIL a refused edit was audited'; end if;
  raise notice 'PASS input: reason, dates, 30-night cap, past arrival, guest list shape, unknown room and capacity are refused, and nothing changes';
end $$;

-- 3. Nothing to change, and a repeated key
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); res uuid := t31_get('a')::uuid; rr uuid := t31_get('a_rr')::uuid;
  r jsonb; r2 jsonb; fp text;
begin
  perform t_sys(); fp := t31_fp(res);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := t31_upd(res, t + 700, t + 703, format('[{"reservation_room_id":"%s","adults":1,"children":0}]', rr), 'same again', 'se-noop');
  if (r ->> 'changed')::boolean then raise exception 'FAIL an edit that changes nothing was reported as a change: %', r; end if;
  r2 := t31_upd(res, t + 700, t + 703, format('[{"reservation_room_id":"%s","adults":1,"children":0}]', rr), 'same again', 'se-noop');
  if r2 <> r then raise exception 'FAIL repeating a key gave a different answer'; end if;
  perform t_expect(format('select t31_upd(%L,%L,%L,null,%L,%L)', res, t + 700, t + 703, 'other words', 'se-noop'), 'IDEMPOTENCY_MISMATCH');
  perform t_sys();
  if t31_fp(res) <> fp then raise exception 'FAIL a no-op changed the booking'; end if;
  if t31_audits(res) <> 0 then raise exception 'FAIL a no-op was audited'; end if;
  raise notice 'PASS no-op: nothing to change answers changed=false, is not audited, repeats by key, and other words under the key are a mismatch';
end $$;

-- 4. Lengthening keeps the price of nights already sold; only the new nights take today's price
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); res uuid := t31_get('a')::uuid; r jsonb; r2 jsonb;
  v_old_total bigint; v_old_room uuid; v_before record; v_n integer;
begin
  perform t_sys();
  select total_minor into v_old_total from reservations where id = res;
  v_old_room := t31_claim_room(res);
  create temp table t31_old_nights as
    select n.night_date, n.rate_minor, n.tax_minor from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = res;
  -- the hotel raises its standard price after this booking was made
  update room_types set base_rate_minor = 3000000 where id = '00000000-0000-0000-0000-0000000000a3';

  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := t31_upd(res, t + 700, t + 705, null, 'Guest stays two more nights', 'se-ext');
  perform t_sys();
  if not (r ->> 'changed')::boolean then raise exception 'FAIL an extension was not applied: %', r; end if;
  if (r ->> 'departure_date')::date <> t + 705 or (r ->> 'arrival_date')::date <> t + 700 then raise exception 'FAIL dates not applied: %', r; end if;
  select count(*) into v_n from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = res;
  if v_n <> 5 then raise exception 'FAIL expected 5 nights, found %', v_n; end if;
  if exists (select 1 from t31_old_nights o join reservation_nights n on n.night_date = o.night_date
              join reservation_rooms x on x.id = n.reservation_room_id and x.reservation_id = res
             where n.rate_minor <> o.rate_minor or n.tax_minor <> o.tax_minor) then
    raise exception 'FAIL a night already sold changed its price';
  end if;
  if (select count(*) from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id
       where x.reservation_id = res and n.night_date >= t + 703 and n.rate_minor = 3000000) <> 2 then
    raise exception 'FAIL the two new nights did not take the current price';
  end if;
  if (select total_minor from reservations where id = res) <> (select sum(n.rate_minor + n.tax_minor) from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = res)
     then raise exception 'FAIL total is not the sum of the nights'; end if;
  if (select subtotal_minor + tax_minor from reservations where id = res) <> (select total_minor from reservations where id = res) then raise exception 'FAIL total <> subtotal + tax'; end if;
  if (select total_minor from reservations where id = res) <= v_old_total then raise exception 'FAIL total did not grow'; end if;
  -- the room is kept, and one active claim covers the whole new stay
  if t31_claim_room(res) <> v_old_room then raise exception 'FAIL the room changed though it was free'; end if;
  if (select count(*) from room_inventory_claims c join reservation_rooms x on x.id = c.reservation_room_id
       where x.reservation_id = res and c.status = 'active' and c.start_date = t + 700 and c.end_date = t + 705) <> 1 then
    raise exception 'FAIL the claim does not cover the new stay';
  end if;
  if (r ->> 'rooms_moved')::integer <> 0 then raise exception 'FAIL rooms_moved should be 0'; end if;
  -- the audit says what changed
  if t31_audits(res) <> 1 then raise exception 'FAIL expected one audit row'; end if;
  if (select metadata ->> 'from_departure' from audit_logs where action = 'reservation.stay_changed' and entity_id = res) <> (t + 703)::text
     or (select metadata ->> 'to_departure' from audit_logs where action = 'reservation.stay_changed' and entity_id = res) <> (t + 705)::text
     or (select (metadata ->> 'from_total_minor')::bigint from audit_logs where action = 'reservation.stay_changed' and entity_id = res) <> v_old_total
     or (select metadata ->> 'reason' from audit_logs where action = 'reservation.stay_changed' and entity_id = res) <> 'Guest stays two more nights' then
    raise exception 'FAIL the audit row does not record the change';
  end if;
  -- the same call again is the same answer and does nothing twice
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r2 := t31_upd(res, t + 700, t + 705, null, 'Guest stays two more nights', 'se-ext');
  perform t_sys();
  if r2 <> r then raise exception 'FAIL a repeated key gave a different answer'; end if;
  if t31_audits(res) <> 1 then raise exception 'FAIL a repeated key was audited twice'; end if;
  update room_types set base_rate_minor = 2500000 where id = '00000000-0000-0000-0000-0000000000a3';
  raise notice 'PASS lengthening: old nights keep their price, new nights take the current one, total = nights, room kept, one claim covers the stay, audited once';
end $$;

-- 5. Shortening and moving the arrival: nights that fall away go, the claim follows
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); res uuid := t31_get('a')::uuid; r jsonb; v_exp bigint;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := t31_upd(res, t + 701, t + 704, null, 'Arrives a day later, leaves a day earlier', 'se-short');
  perform t_sys();
  if (select min(n.night_date) || '/' || max(n.night_date) || '/' || count(*) from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = res)
     <> (t + 701)::text || '/' || (t + 703)::text || '/3' then raise exception 'FAIL nights do not match the new dates'; end if;
  select sum(n.rate_minor + n.tax_minor) into v_exp from reservation_nights n join reservation_rooms x on x.id = n.reservation_room_id where x.reservation_id = res;
  if (select total_minor from reservations where id = res) <> v_exp then raise exception 'FAIL total <> nights after shortening'; end if;
  if (select count(*) from room_inventory_claims c join reservation_rooms x on x.id = c.reservation_room_id
       where x.reservation_id = res and c.status = 'active' and c.start_date = t + 701 and c.end_date = t + 704) <> 1 then
    raise exception 'FAIL the claim does not cover the shortened stay';
  end if;
  if (select count(*) from room_inventory_claims c join reservation_rooms x on x.id = c.reservation_room_id where x.reservation_id = res and c.status = 'active') <> 1 then
    raise exception 'FAIL more than one active claim after shortening';
  end if;
  -- the nights that were released are free for someone else
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_book('00000000-0000-0000-0000-0000000000a3', t + 700, t + 701, 'se-reuse', (select t31_claim_room(res)));
  raise notice 'PASS shortening: nights outside the new dates are removed, the total follows, the freed night can be booked by someone else';
end $$;

-- 6. The booking's room is taken for the new nights: it moves to another room of the type
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); a jsonb; b jsonb; res uuid; room uuid; r jsonb; v_room uuid;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  a := t_book('00000000-0000-0000-0000-0000000000a3', t + 720, t + 721, 'se-m-a');
  res := (a ->> 'reservation_id')::uuid;
  perform t_sys(); room := t31_claim_room(res); insert into t31_ctx values ('m', res::text);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 721, t + 722, 'se-m-b', room);     -- someone else has that room the next night
  r := t31_upd(res, t + 720, t + 722, null, 'Stays one more night', 'se-m-ext');
  perform t_sys();
  if (r ->> 'rooms_moved')::integer <> 1 then raise exception 'FAIL expected the room to move: %', r; end if;
  select c.room_id into v_room from room_inventory_claims c join reservation_rooms x on x.id = c.reservation_room_id
   where x.reservation_id = res and c.status = 'active';
  if v_room = room then raise exception 'FAIL still in the taken room'; end if;
  if (select count(*) from room_inventory_claims c join reservation_rooms x on x.id = c.reservation_room_id
       where x.reservation_id = res and c.status = 'active' and c.start_date = t + 720 and c.end_date = t + 722) <> 1 then
    raise exception 'FAIL one claim should cover both nights in the new room';
  end if;
  if (select count(*) from room_inventory_claims where room_id = room and status = 'active' and start_date = t + 721) <> 1 then
    raise exception 'FAIL the other guest lost their room';
  end if;
  raise notice 'PASS room taken: the booking moves to another free room of the type, and the other guest keeps theirs';
end $$;

-- 7. No room can be held for the new dates: nothing changes at all
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); c jsonb; res uuid; room uuid; fp text; n integer := 0; rm record;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  c := t_book('00000000-0000-0000-0000-0000000000a3', t + 740, t + 741, 'se-f-c');
  res := (c ->> 'reservation_id')::uuid;
  perform t_sys(); room := t31_claim_room(res);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  -- every STD room (this booking's own included) is taken the next night
  for rm in select id from rooms where property_id = '00000000-0000-0000-0000-0000000000a2' and room_type_id = '00000000-0000-0000-0000-0000000000a3' and operational_status = 'active' order by room_number loop
    n := n + 1;
    perform t_book('00000000-0000-0000-0000-0000000000a3', t + 741, t + 742, 'se-f-' || n, rm.id);
  end loop;
  perform t_sys(); fp := t31_fp(res);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t31_upd(%L,%L,%L,null,%L,%L)', res, t + 740, t + 742, 'one more night', 'se-f-ext'), 'ROOM_UNAVAILABLE');
  perform t_expect(format('select t31_upd(%L,%L,%L,%L,%L,%L)', res, t + 740, t + 742,
    format('[{"reservation_room_id":"%s","adults":2}]', (select id from reservation_rooms where reservation_id = res)), 'with guests too', 'se-f-ext2'), 'ROOM_UNAVAILABLE');
  perform t_sys();
  if t31_fp(res) <> fp then raise exception 'FAIL a failed edit left the booking half changed: % vs %', fp, t31_fp(res); end if;
  if t31_claim_room(res) <> room then raise exception 'FAIL the booking lost its room'; end if;
  if t31_audits(res) <> 0 then raise exception 'FAIL a failed edit was audited'; end if;
  raise notice 'PASS all or nothing: with no free room for the new dates the booking, its room, its nights and its guests are exactly as before';
end $$;

-- 8. Money and state: nothing may move under an in-flight, cancelled or pending booking (070: a payment or invoice is allowed)
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; inv uuid; res uuid; fp text; v_att uuid := gen_random_uuid();
  p jsonb; w jsonb;
begin
  -- an issued invoice
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 760, t + 762, 'se-inv-b'); res := (b ->> 'reservation_id')::uuid;
  perform issue_invoice(res, 'se-inv-i');
  perform t_sys(); insert into t31_ctx values ('inv', res::text);
  -- 070: an issued invoice no longer stops the edit: it is replaced by one for the new nights (the money rules are
  -- tested in full in 71_stay_change_money.sql)
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t31_upd(res, t + 760, t + 763, null, 'x', 'se-inv-u');
  perform t_sys();
  if (select count(*) from invoices where reservation_id = res and invoice_status <> 'void') <> 1
     or (select total_minor from invoices where reservation_id = res and invoice_status <> 'void') <> (select total_minor from reservations where id = res) then
    raise exception 'FAIL an invoiced booking has no single live invoice for the new total after the edit';
  end if;

  -- a payment recorded at the desk no longer stops it either (070)
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 770, t + 772, 'se-pay-b'); res := (b ->> 'reservation_id')::uuid;
  perform record_manual_payment(res, 100000, 'cash', null, null, 'se-pay-p');
  perform t31_upd(res, t + 770, t + 773, null, 'x', 'se-pay-u');
  perform t_sys();
  if (select arrival_date from reservations where id = res) <> t + 770 or (select departure_date from reservations where id = res) <> t + 773 then
    raise exception 'FAIL a paid booking was not changed';
  end if;

  -- a provider payment started and not finished
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 780, t + 782, 'se-att-b'); res := (b ->> 'reservation_id')::uuid;
  perform t_sys();
  insert into payment_attempts (id, tenant_id, property_id, reservation_id, provider, reference, amount_minor, currency, status)
  select v_att, tenant_id, property_id, id, 'paystack', 'se-att-ref', 100000, currency, 'initiated' from reservations where id = res;
  fp := t31_fp(res);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t31_upd(%L,%L,%L,null,%L,%L)', res, t + 780, t + 783, 'x', 'se-att-u'), 'INVALID_STATE: payment started');
  perform t_sys(); if t31_fp(res) <> fp then raise exception 'FAIL a booking with a payment in flight changed'; end if;
  update payment_attempts set status = 'abandoned' where id = v_att;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t31_upd(res, t + 780, t + 783, null, 'attempt abandoned', 'se-att-u2');

  -- a cancelled booking and an online booking still waiting for payment
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 790, t + 792, 'se-can-b'); res := (b ->> 'reservation_id')::uuid;
  perform t_as('00000000-0000-0000-0000-00000000aa01');   -- front desk may not cancel
  perform cancel_reservation(res, 'changed their mind', 'se-can-c');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t31_upd(%L,%L,%L,null,%L,%L)', res, t + 790, t + 793, 'x', 'se-can-u'), 'INVALID_STATE: cancelled');
  perform t_sys();
  w := create_reservation('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a5', 'website', t + 800, t + 802,
         jsonb_build_array(jsonb_build_object('room_type_id', '00000000-0000-0000-0000-0000000000a3', 'adults', 1)), 'se-web-b');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t31_upd(%L,%L,%L,null,%L,%L)', (w ->> 'reservation_id')::uuid, t + 800, t + 803, 'x', 'se-web-u'), 'INVALID_STATE: pending');
  raise notice 'PASS money and state: a payment in flight, a cancelled booking and a pending online booking refuse the edit and change nothing; an abandoned attempt no longer blocks it; an invoice and a payment no longer block it (070)';
end $$;

-- 9. Guests only: numbers change, dates, price and room do not
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; rr uuid; fp text; r jsonb; v_before text;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 810, t + 812, 'se-g-b'); res := (b ->> 'reservation_id')::uuid; rr := t_rr(b);
  perform t_sys(); v_before := (select total_minor || '|' || arrival_date || '|' || departure_date from reservations where id = res);
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := t31_upd(res, t + 810, t + 812, format('[{"reservation_room_id":"%s","adults":2,"children":0}]', rr), 'Second guest arrives', 'se-g-u');
  perform t_sys();
  if not (r ->> 'changed')::boolean then raise exception 'FAIL a guest change was not applied'; end if;
  if (select adults || '/' || children from reservation_rooms where id = rr) <> '2/0' then raise exception 'FAIL guests not saved'; end if;
  if (select total_minor || '|' || arrival_date || '|' || departure_date from reservations where id = res) <> v_before then raise exception 'FAIL a guest-only change touched the dates or price'; end if;
  if (select count(*) from room_inventory_claims c where c.reservation_room_id = rr and c.status = 'active') <> 1 then raise exception 'FAIL claims changed'; end if;
  if (select (metadata ->> 'dates_changed')::boolean from audit_logs where action = 'reservation.stay_changed' and entity_id = res) is not false then raise exception 'FAIL audit should say the dates did not change'; end if;
  raise notice 'PASS guests only: adults and children are saved; dates, price and room are untouched';
end $$;

-- 10. A planned change of room partway through blocks a date edit (merging would drop the move)
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); b jsonb; res uuid; rr uuid; fp text;
begin
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  b := t_book('00000000-0000-0000-0000-0000000000a3', t + 820, t + 823, 'se-s-b'); res := (b ->> 'reservation_id')::uuid; rr := t_rr(b);
  perform transfer_room(rr, null, t + 821, 'room fault', 'se-s-t');
  perform t_sys(); fp := t31_fp(res);
  if (select count(*) from room_inventory_claims where reservation_room_id = rr and status = 'active') <> 2 then raise exception 'FAIL fixture: expected two claims'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select t31_upd(%L,%L,%L,null,%L,%L)', res, t + 820, t + 824, 'x', 'se-s-u'), 'INVALID_STATE: split stay');
  perform t_sys(); if t31_fp(res) <> fp then raise exception 'FAIL a refused edit changed a split stay'; end if;
  -- a guest-only edit on the same booking is fine
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t31_upd(res, t + 820, t + 823, format('[{"reservation_room_id":"%s","adults":2}]', rr), 'Second guest', 'se-s-g');
  raise notice 'PASS split stay: dates cannot be edited while a room change is planned, guests can';
end $$;

-- 11. Edits leave the rest of the booking alone
do $$ declare
  t date := property_today('00000000-0000-0000-0000-0000000000a2'); res uuid := t31_get('a')::uuid;
begin
  perform t_sys();
  if (select count(*) from payments where reservation_id = res) <> 0 or (select count(*) from invoices where reservation_id = res) <> 0 then
    raise exception 'FAIL an edit created money records';
  end if;
  if (select reservation_status from reservations where id = res) <> 'confirmed' then raise exception 'FAIL status changed'; end if;
  if exists (select 1 from reservation_rooms where reservation_id = res and room_status <> 'booked') then raise exception 'FAIL room status changed'; end if;
  -- no client can write the tables directly, the function is the only way
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  begin
    update reservations set departure_date = departure_date + 1 where id = res;
    raise exception 'FAIL a client updated a reservation directly';
  exception when insufficient_privilege then null; end;
  perform t_sys();
  raise notice 'PASS the edit touches nothing but dates, nights, claims, totals and guest numbers, and clients cannot write the tables directly';
end $$;
