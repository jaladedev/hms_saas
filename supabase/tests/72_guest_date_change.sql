-- The guest changing dates alone (migration 071). Rooms T72-1..6 of type a3, retired at the end.
-- Reuses t_as / t_sys / t_expect / t_book / t_rr (05). Policy rows are immutable, so the one in force is edited with triggers off.
\set ON_ERROR_STOP on

create function t72_policy(p_on boolean) returns void language plpgsql as $$
declare prop uuid := '00000000-0000-0000-0000-0000000000a2'; cfg jsonb; pid uuid;
begin
  set local session_replication_role = replica;
  select id, config into pid, cfg from property_policies where property_id = prop and effective_from <= property_today(prop) order by effective_from desc limit 1;
  cfg := cfg - 'guest_changes' - 'guest_change_hours';
  if p_on then cfg := cfg || jsonb_build_object('guest_changes', 'on'); end if;
  update property_policies set config = cfg where id = pid;
  set local session_replication_role = origin;
end $$;

create function t72_denied(p_sql text) returns void language plpgsql as $$
begin execute p_sql; raise exception 'FAIL expected permission denied: %', p_sql;
exception when insufficient_privilege then null; end $$;

do $$ declare
  prop uuid := '00000000-0000-0000-0000-0000000000a2'; t date; ty uuid := '00000000-0000-0000-0000-0000000000a3';
  owner text := '00000000-0000-0000-0000-00000000aa01';
  rooms_ uuid[]; r jsonb; q jsonb; res uuid; rr uuid; old_total bigint; n integer; inv_old uuid; inv_new uuid; rm_before uuid; req uuid; g0 integer;
begin
  perform t_sys();
  t := property_today(prop);
  insert into rooms (tenant_id, property_id, room_type_id, room_number, floor)
    select tenant_id, id, ty, 'T72-' || g, 9 from properties, generate_series(1, 6) g where id = prop;
  select array_agg(id order by room_number) into rooms_ from rooms where property_id = prop and room_number like 'T72-%';
  update rooms set housekeeping_status = 'clean' where id = any (rooms_);

  -- A. off by default, and closed to logins
  perform t72_policy(false);
  perform t_as(owner);
  r := t_book(ty, t + 20, t + 23, 't72-a', rooms_[1]); res := (r ->> 'reservation_id')::uuid;
  perform t72_denied(format('select guest_change_dates_quote(%L, %L, %L)', res, t + 21, t + 24));
  perform t72_denied(format('select guest_change_dates(%L, %L, %L, 1, %L)', res, t + 21, t + 24, 't72-a1'));
  perform t_sys();
  q := guest_change_dates_quote(res, t + 21, t + 24);
  if (q ->> 'allowed')::boolean or q ->> 'why_not' <> 'disabled' then raise exception 'FAIL off: %', q; end if;

  -- B. on: a shift of the same length is allowed (the price is the same), the room stays, claims and nights move
  perform t72_policy(true);
  select total_minor into old_total from reservations where id = res;
  select room_id into rm_before from room_inventory_claims where reservation_room_id = (select id from reservation_rooms where reservation_id = res) and status = 'active';
  q := guest_change_dates_quote(res, t + 21, t + 24);
  if not (q ->> 'allowed')::boolean or (q ->> 'new_total_minor')::bigint > old_total or (q ->> 'nights_added')::int <> 1 or (q ->> 'nights_dropped')::int <> 1 then raise exception 'FAIL quote B: %', q; end if;
  perform t_expect(format('select guest_change_dates(%L, %L, %L, %L, %L)', res, t + 21, t + 24, (q ->> 'new_total_minor')::bigint + 1, 't72-b0'), 'POLICY_VIOLATION: total changed');
  r := guest_change_dates(res, t + 21, t + 24, (q ->> 'new_total_minor')::bigint, 't72-b1');
  r := guest_change_dates(res, t + 21, t + 24, (q ->> 'new_total_minor')::bigint, 't72-b1');
  if (select arrival_date from reservations where id = res) <> t + 21 or (select departure_date from reservations where id = res) <> t + 24 then raise exception 'FAIL dates'; end if;
  if (select count(*) from reservation_nights where reservation_room_id = (select id from reservation_rooms where reservation_id = res)
       and night_date between t + 21 and t + 23) <> 3 or (select count(*) from reservation_nights where reservation_room_id = (select id from reservation_rooms where reservation_id = res)) <> 3 then raise exception 'FAIL nights'; end if;
  if (select room_id from room_inventory_claims where reservation_room_id = (select id from reservation_rooms where reservation_id = res) and status = 'active') <> rm_before
     or (select start_date from room_inventory_claims where reservation_room_id = (select id from reservation_rooms where reservation_id = res) and status = 'active') <> t + 21 then raise exception 'FAIL claim'; end if;
  if (select subtotal_minor + tax_minor - discount_minor from reservations where id = res) <> (select total_minor from reservations where id = res)
     or (select total_minor from reservations where id = res) <> (select sum(rate_minor + tax_minor) from reservation_nights where reservation_room_id = (select id from reservation_rooms where reservation_id = res)) then raise exception 'FAIL totals reconcile'; end if;
  if (select count(*) from audit_logs where action = 'reservation.stay_changed' and entity_id = res and metadata ->> 'by' = 'guest') <> 1 then raise exception 'FAIL audit once'; end if;
  if (select count(*) from notifications where kind = 'guest_stay_changed' and entity_id = res) <> 1 then raise exception 'FAIL notice once'; end if;

  -- C. shorter is cheaper and allowed; longer is dearer and refused; same dates refused; past and bad dates refused
  q := guest_change_dates_quote(res, t + 21, t + 23);
  if not (q ->> 'allowed')::boolean or (q ->> 'difference_minor')::bigint >= 0 then raise exception 'FAIL shorter: %', q; end if;
  q := guest_change_dates_quote(res, t + 21, t + 26);
  if (q ->> 'allowed')::boolean or q ->> 'why_not' <> 'dearer' then raise exception 'FAIL longer: %', q; end if;
  perform t_expect(format('select guest_change_dates(%L, %L, %L, %L, %L)', res, t + 21, t + 26, (q ->> 'new_total_minor')::bigint, 't72-c1'), 'INVALID_STATE: dates dearer');
  if guest_change_dates_quote(res, t + 21, t + 24) ->> 'why_not' <> 'same' then raise exception 'FAIL same'; end if;
  if guest_change_dates_quote(res, t - 2, t + 1) ->> 'why_not' <> 'dates' or guest_change_dates_quote(res, t + 5, t + 5) ->> 'why_not' <> 'dates'
     or guest_change_dates_quote(res, t + 5, t + 40) ->> 'why_not' <> 'dates' then raise exception 'FAIL bad dates'; end if;

  -- D. money: paid in full, an invoice live. A shift is fine and the invoice is replaced and still paid; shortening would overpay and is refused
  perform t_as(owner);
  r := t_book(ty, t + 30, t + 33, 't72-d', rooms_[2]); res := (r ->> 'reservation_id')::uuid;
  select total_minor into old_total from reservations where id = res;
  perform record_manual_payment(res, old_total, 'cash', 't72 cash', null, 't72-d-pay');
  r := issue_invoice(res, 't72-d-inv'); inv_old := (r ->> 'invoice_id')::uuid;
  perform t_sys();
  q := guest_change_dates_quote(res, t + 32, t + 35);
  if not (q ->> 'allowed')::boolean then raise exception 'FAIL paid shift: %', q; end if;
  perform guest_change_dates(res, t + 32, t + 35, (q ->> 'new_total_minor')::bigint, 't72-d1');
  select id into inv_new from invoices where reservation_id = res and invoice_status <> 'void';
  if inv_new is null or inv_new = inv_old or (select invoice_status from invoices where id = inv_old) <> 'void' then raise exception 'FAIL invoice replaced'; end if;
  if (select total_minor from invoices where id = inv_new) <> (select total_minor from reservations where id = res) then raise exception 'FAIL invoice total'; end if;
  if (select payment_status from reservations where id = res) <> 'paid' then raise exception 'FAIL still paid: %', (select payment_status from reservations where id = res); end if;
  q := guest_change_dates_quote(res, t + 32, t + 34);
  if (q ->> 'allowed')::boolean or q ->> 'why_not' <> 'overpaid' then raise exception 'FAIL overpaid: %', q; end if;

  -- E. a discount, an invoice line that is not a night, a payment in progress, and a stay under way each send the guest to staff
  perform t_as(owner);
  r := t_book(ty, t + 40, t + 42, 't72-e1', rooms_[3]); res := (r ->> 'reservation_id')::uuid;
  perform apply_discount(res, 10, 'regular guest', 't72-e1-d');
  perform t_sys();
  if guest_change_dates_quote(res, t + 41, t + 43) ->> 'why_not' <> 'discount' then raise exception 'FAIL discount'; end if;
  perform t_as(owner);
  r := t_book(ty, t + 44, t + 46, 't72-e2', rooms_[4]); res := (r ->> 'reservation_id')::uuid;
  perform t_sys();
  insert into payment_attempts (tenant_id, property_id, reservation_id, provider, reference, amount_minor, currency, status)
    select tenant_id, property_id, id, 'paystack', 't72-pa', 1000, currency, 'initiated' from reservations where id = res;
  if guest_change_dates_quote(res, t + 45, t + 47) ->> 'why_not' <> 'busy' then raise exception 'FAIL busy'; end if;
  perform t_as(owner);
  r := t_book(ty, t, t + 2, 't72-e3', rooms_[5]);
  perform check_in(t_rr(r), null);
  perform t_sys();
  if guest_change_dates_quote((r ->> 'reservation_id')::uuid, t + 1, t + 3) ->> 'why_not' not in ('started', 'status', 'window') then raise exception 'FAIL in house'; end if;

  -- F. the notice window: inside it the dates are closed
  perform t_as(owner);
  r := t_book(ty, t + 1, t + 3, 't72-f1', rooms_[6]); res := (r ->> 'reservation_id')::uuid;
  perform t_sys();
  if guest_change_dates_quote(res, t + 2, t + 4) ->> 'why_not' <> 'window' then raise exception 'FAIL window'; end if;

  -- G. an open dates request is closed as done by the change; a booking cancelled or not confirmed cannot change
  -- The shifted nights must cost the same, so the window must not straddle 2027-01-01, where test 04's Test VAT rule starts.
  g0 := case when t + 50 <= date '2027-01-01' and t + 54 > date '2027-01-01' then 56 else 50 end;
  perform t_as(owner);
  r := t_book(ty, t + g0, t + g0 + 2, 't72-g', rooms_[1]); res := (r ->> 'reservation_id')::uuid;
  perform t_sys();
  req := (guest_request_change(res, 'dates', t + g0 + 1, t + g0 + 3, null, 't72-g1') ->> 'request_id')::uuid;
  q := guest_change_dates_quote(res, t + g0 + 1, t + g0 + 3);
  perform guest_change_dates(res, t + g0 + 1, t + g0 + 3, (q ->> 'new_total_minor')::bigint, 't72-g2');
  if (select status from guest_change_requests where id = req) <> 'done' then raise exception 'FAIL request not closed'; end if;
  perform t_as(owner);
  perform cancel_reservation(res, 'test', 't72-g3');
  perform t_sys();
  if guest_change_dates_quote(res, t + g0 + 2, t + g0 + 4) ->> 'why_not' <> 'status' then raise exception 'FAIL cancelled'; end if;

  -- H. the room is taken on the new dates: another room of the type is used, and with none free the change fails whole
  perform t_as(owner);
  r := t_book(ty, t + 60, t + 62, 't72-h1', rooms_[1]); res := (r ->> 'reservation_id')::uuid;
  perform t_book(ty, t + 62, t + 64, 't72-h2', rooms_[1]);
  perform t_sys();
  q := guest_change_dates_quote(res, t + 61, t + 63);
  perform guest_change_dates(res, t + 61, t + 63, (q ->> 'new_total_minor')::bigint, 't72-h3');
  if (select room_id from room_inventory_claims where reservation_room_id = (select id from reservation_rooms where reservation_id = res) and status = 'active') = rooms_[1] then raise exception 'FAIL expected another room'; end if;
  if (select (metadata ->> 'rooms_moved')::int from audit_logs where action = 'reservation.stay_changed' and entity_id = res order by created_at desc limit 1) <> 1 then raise exception 'FAIL rooms_moved'; end if;

  update rooms set operational_status = 'retired' where id = any (rooms_);
  perform t72_policy(false);
  raise notice 'PASS guest date change: allowed only when it needs no extra payment and leaves nothing to refund; nights, claims, levy, invoice and payment status follow; staff are told; refusals leave the booking untouched';
end $$;

drop function t72_policy(boolean), t72_denied(text);
