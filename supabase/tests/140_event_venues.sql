-- Events part 1 (migration 140): venues, terms, venue bookings with quote, hold, deposit, balance, refund, cancel, room blocks and linked stays.
-- Reuses t_as / t_sys / t_expect / t_book (05). Users: aa01 owner A, aa02 housekeeping A, aa04 front desk A (event.manage, payment.record),
-- aa05 accountant A (event.view, payment.record, refund.approve, report.view; no event.manage), bb01 owner of Hotel B.
\set ON_ERROR_STOP on

do $$ declare
  v_a constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_b constant uuid := '00000000-0000-0000-0000-0000000000b2';
  r jsonb; v_venue uuid; v_n integer;
begin
  perform t_sys();
  delete from hotel_venues where property_id in (v_a, v_b);

  -- who may set up venues: property.configure only
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select save_hotel_venue(%L, null, ''Grand Hall'', '''', 300, 50000, 2000000, true, true)', v_a), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select save_hotel_venue(%L, null, ''Grand Hall'', '''', 300, 50000, 2000000, true, true)', v_a), 'NOT_FOUND');

  -- validation
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select save_hotel_venue(%L, null, ''  '', '''', 300, 50000, null, true, true)', v_a), 'POLICY_VIOLATION: name');
  perform t_expect(format('select save_hotel_venue(%L, null, ''Hall'', '''', 0, 50000, null, true, true)', v_a), 'POLICY_VIOLATION: capacity');
  perform t_expect(format('select save_hotel_venue(%L, null, ''Hall'', '''', 100, null, null, true, true)', v_a), 'POLICY_VIOLATION: price');
  perform t_expect(format('select save_hotel_venue(%L, null, ''Hall'', '''', 100, 0, null, true, true)', v_a), 'POLICY_VIOLATION: price');
  perform t_expect(format('select save_hotel_venue(%L, null, ''Hall'', %L, 100, 5, null, true, true)', v_a, repeat('x', 201)), 'POLICY_VIOLATION: text');

  r := save_hotel_venue(v_a, null, '  Grand Hall ', 'Seats 300', 300, 50000, 2000000, true, true);
  v_venue := (r ->> 'venue_id')::uuid;
  perform save_hotel_venue(v_a, null, 'Boardroom', '', 20, 20000, null, false, true);
  perform t_sys();
  if (select name from hotel_venues where id = v_venue) <> 'Grand Hall' then raise exception 'FAIL not trimmed'; end if;
  if (select count(*) from audit_logs where action = 'hotel_venue.saved' and property_id = v_a) < 2 then raise exception 'FAIL audit'; end if;
  -- another hotel cannot edit it
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select save_hotel_venue(%L, %L, ''X'', '''', 10, 5, null, true, true)', v_b, v_venue), 'NOT_FOUND');
  -- reading: housekeeping and the other hotel see nothing, front desk sees them
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  select count(*) into v_n from hotel_venues; if v_n <> 0 then raise exception 'FAIL housekeeping sees venues'; end if;
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  select count(*) into v_n from hotel_venues; if v_n <> 0 then raise exception 'FAIL other hotel sees venues'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  select count(*) into v_n from hotel_venues; if v_n <> 2 then raise exception 'FAIL front desk venues %', v_n; end if;
  -- limit of 12
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  for v_n in 1..10 loop perform save_hotel_venue(v_a, null, 'V' || v_n, '', 10, 1000, null, false, true); end loop;
  perform t_expect(format('select save_hotel_venue(%L, null, ''Too many'', '''', 10, 1000, null, false, true)', v_a), 'POLICY_VIOLATION: limit');
  perform t_sys();
  delete from hotel_venues where property_id = v_a and name like 'V%';
  raise notice 'PASS venues: configure-only writes, validation, trimmed, audited, hidden from others, limit of 12';
end $$;

do $$ declare
  v_a constant uuid := '00000000-0000-0000-0000-0000000000a2';
  r jsonb;
begin
  perform t_sys();
  delete from event_settings;
  -- defaults before anyone sets anything: no tax, no service charge
  r := event_terms(v_a);
  if (r ->> 'tax_percent')::numeric <> 0 or (r ->> 'service_percent')::numeric <> 0 or (r ->> 'deposit_percent')::integer <> 30 or (r ->> 'hold_hours')::integer <> 48 then
    raise exception 'FAIL defaults %', r; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select save_event_settings(%L, 7.5, 10, 30, 48)', v_a), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select save_event_settings(%L, 101, 10, 30, 48)', v_a), 'POLICY_VIOLATION: tax');
  perform t_expect(format('select save_event_settings(%L, 7.5, -1, 30, 48)', v_a), 'POLICY_VIOLATION: service');
  perform t_expect(format('select save_event_settings(%L, 7.5, 10, 101, 48)', v_a), 'POLICY_VIOLATION: deposit');
  perform t_expect(format('select save_event_settings(%L, 7.5, 10, 30, 0)', v_a), 'POLICY_VIOLATION: hold hours');
  perform save_event_settings(v_a, 7.5, 10, 30, 48);
  perform save_event_settings(v_a, 7.5, 10, 30, 48);   -- saving twice keeps one row
  perform t_sys();
  if (select count(*) from event_settings where property_id = v_a) <> 1 then raise exception 'FAIL one row'; end if;
  if (select count(*) from audit_logs where action = 'event_settings.saved') < 2 then raise exception 'FAIL audit'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := event_terms_get(v_a);
  if (r ->> 'tax_percent')::numeric <> 7.5 then raise exception 'FAIL terms read %', r; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select event_terms_get(%L)', v_a), 'NOT_FOUND');
  raise notice 'PASS event terms: defaults are zero tax and service, configure-only, validated, one row, readable by event.view only';
end $$;

-- quote arithmetic, hold, double booking, lapsed hold
do $$ declare
  v_a constant uuid := '00000000-0000-0000-0000-0000000000a2';
  v_base timestamp; v_venue uuid; v_board uuid; r jsonb; v_b1 uuid; v_b2 uuid; v_b3 uuid; b venue_bookings%rowtype;
begin
  perform t_sys();
  v_base := date_trunc('day', property_local_now(v_a)) + interval '20 days';
  select id into v_venue from hotel_venues where property_id = v_a and name = 'Grand Hall';
  select id into v_board from hotel_venues where property_id = v_a and name = 'Boardroom';

  -- who may create
  perform t_as('00000000-0000-0000-0000-00000000aa05');   -- accountant: view only
  perform t_expect(format('select create_venue_booking(%L, %L, %L, %L, ''wedding'', ''W'', ''Ada'', ''ada@example.com'', null, 100, null, false, ''k0'')', v_a, v_venue, v_base + interval '10 hours', v_base + interval '20 hours'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  -- validation
  perform t_expect(format('select create_venue_booking(%L, %L, %L, %L, ''wedding'', ''W'', ''Ada'', null, null, 100, null, false, ''k1'')', v_a, v_venue, v_base + interval '10 hours', v_base + interval '20 hours'), 'POLICY_VIOLATION: contact');
  perform t_expect(format('select create_venue_booking(%L, %L, %L, %L, ''wedding'', ''W'', ''Ada'', ''bad'', null, 100, null, false, ''k1'')', v_a, v_venue, v_base + interval '10 hours', v_base + interval '20 hours'), 'POLICY_VIOLATION: email');
  perform t_expect(format('select create_venue_booking(%L, %L, %L, %L, ''wedding'', ''W'', ''Ada'', ''ada@example.com'', null, 301, null, false, ''k1'')', v_a, v_venue, v_base + interval '10 hours', v_base + interval '20 hours'), 'POLICY_VIOLATION: attendees');
  perform t_expect(format('select create_venue_booking(%L, %L, %L, %L, ''wedding'', ''W'', ''Ada'', ''ada@example.com'', null, 100, null, false, ''k1'')', v_a, v_venue, v_base + interval '20 hours', v_base + interval '10 hours'), 'POLICY_VIOLATION: times');
  perform t_expect(format('select create_venue_booking(%L, %L, %L, %L, ''wedding'', ''W'', ''Ada'', ''ada@example.com'', null, 100, null, false, ''k1'')', v_a, v_venue, v_base + interval '1 hour', v_base + interval '40 days'), 'POLICY_VIOLATION: times');
  perform t_expect(format('select create_venue_booking(%L, %L, %L, %L, ''wedding'', ''W'', ''Ada'', ''ada@example.com'', null, 100, null, false, ''k1'')', v_a, v_venue, v_base - interval '30 days', v_base - interval '30 days' + interval '3 hours'), 'POLICY_VIOLATION: past');
  perform t_expect(format('select create_venue_booking(%L, %L, %L, %L, ''funeral'', ''W'', ''Ada'', ''ada@example.com'', null, 100, null, false, ''k1'')', v_a, v_venue, v_base + interval '10 hours', v_base + interval '20 hours'), 'POLICY_VIOLATION: event type');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select create_venue_booking(%L, %L, %L, %L, ''wedding'', ''W'', ''Ada'', ''ada@example.com'', null, 100, null, false, ''k1'')', v_a, v_venue, v_base + interval '10 hours', v_base + interval '20 hours'), 'NOT_FOUND');

  -- an enquiry holds nothing
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := create_venue_booking(v_a, v_venue, v_base + interval '10 hours', v_base + interval '20 hours', 'wedding', 'Okafor wedding', 'Ada Okafor', 'ada@example.com', '+2348000000001', 200, null, false, 'k-b1');
  v_b1 := (r ->> 'booking_id')::uuid;
  if r ->> 'status' <> 'enquiry' or r ->> 'reference' !~ '^EVB-[0-9A-F]{8}$' then raise exception 'FAIL enquiry %', r; end if;
  if create_venue_booking(v_a, v_venue, v_base + interval '10 hours', v_base + interval '20 hours', 'wedding', 'Okafor wedding', 'Ada Okafor', 'ada@example.com', '+2348000000001', 200, null, false, 'k-b1') <> r then raise exception 'FAIL idempotent'; end if;
  perform t_expect(format('select create_venue_booking(%L, %L, %L, %L, ''party'', ''Other'', ''Bola'', ''b@example.com'', null, 50, null, false, ''k-b1'')', v_a, v_venue, v_base + interval '10 hours', v_base + interval '20 hours'), 'IDEMPOTENCY_MISMATCH');
  perform t_expect(format('select hold_venue_booking(%L)', v_b1), 'INVALID_STATE: no lines');

  -- quote: 1 x 1,000,000 + 100 x 5,000 = 1,500,000; service 10% = 150,000; tax 7.5% of 1,650,000 = 123,750; total 1,773,750; deposit 30% = 532,125
  perform set_venue_booking_lines(v_b1, '[{"kind":"venue","description":"Grand Hall, 10 hours","quantity":1,"unit_amount_minor":1000000},{"kind":"catering","description":"Buffet","quantity":100,"unit_amount_minor":5000}]'::jsonb);
  perform t_sys();
  select * into b from venue_bookings where id = v_b1;
  if (b.subtotal_minor, b.service_minor, b.tax_minor, b.total_minor, b.deposit_minor) <> (1500000, 150000, 123750, 1773750, 532125) then raise exception 'FAIL totals %', b; end if;
  -- line validation
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select set_venue_booking_lines(%L, ''[]''::jsonb)', v_b1), 'POLICY_VIOLATION: lines');
  perform t_expect(format('select set_venue_booking_lines(%L, ''[{"kind":"x","description":"a","quantity":1,"unit_amount_minor":1}]''::jsonb)', v_b1), 'POLICY_VIOLATION: line kind');
  perform t_expect(format('select set_venue_booking_lines(%L, ''[{"kind":"other","description":"","quantity":1,"unit_amount_minor":1}]''::jsonb)', v_b1), 'POLICY_VIOLATION: line text');
  perform t_expect(format('select set_venue_booking_lines(%L, ''[{"kind":"other","description":"a","quantity":0,"unit_amount_minor":1}]''::jsonb)', v_b1), 'POLICY_VIOLATION: line quantity');
  perform t_expect(format('select set_venue_booking_lines(%L, ''[{"kind":"other","description":"a","quantity":1,"unit_amount_minor":-5}]''::jsonb)', v_b1), 'POLICY_VIOLATION: line amount');
  perform t_sys();
  select * into b from venue_bookings where id = v_b1;
  if b.total_minor <> 1773750 then raise exception 'FAIL a refused edit changed the quote'; end if;

  -- an enquiry on the same slot does not block; a hold does
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := create_venue_booking(v_a, v_venue, v_base + interval '15 hours', v_base + interval '20 hours', 'party', 'Party', 'Bola', 'bola@example.com', null, 80, null, false, 'k-b2');
  v_b2 := (r ->> 'booking_id')::uuid;
  perform set_venue_booking_lines(v_b2, '[{"kind":"venue","description":"Hire","quantity":1,"unit_amount_minor":350000}]'::jsonb);
  r := hold_venue_booking(v_b1);
  if r ->> 'status' <> 'tentative' then raise exception 'FAIL hold %', r; end if;
  perform t_sys();
  select * into b from venue_bookings where id = v_b1;
  if b.hold_expires_at < now() + interval '47 hours' or b.hold_expires_at > now() + interval '49 hours' then raise exception 'FAIL hold hours %', b.hold_expires_at; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if hold_venue_booking(v_b1) ->> 'status' <> 'tentative' then raise exception 'FAIL hold twice'; end if;
  perform t_expect(format('select hold_venue_booking(%L)', v_b2), 'VENUE_UNAVAILABLE');
  perform t_expect(format('select confirm_venue_booking(%L, true)', v_b2), 'VENUE_UNAVAILABLE');
  -- touching slots are fine: b3 starts when b1 ends
  r := create_venue_booking(v_a, v_venue, v_base + interval '20 hours', v_base + interval '23 hours', 'party', 'Late', 'Chi', 'chi@example.com', null, 50, null, true, 'k-b3');
  v_b3 := (r ->> 'booking_id')::uuid;
  if r ->> 'status' <> 'tentative' then raise exception 'FAIL touching slot %', r; end if;
  -- the automatic quote for a 3 hour hire: min(3 x 50,000, 2,000,000 x 1) = 150,000; service 10% 15,000; tax 7.5% of 165,000 = 12,375; total 177,375
  perform t_sys();
  select * into b from venue_bookings where id = v_b3;
  if (b.subtotal_minor, b.total_minor) <> (150000, 177375) then raise exception 'FAIL auto quote %', b; end if;
  -- another venue is free at the same time
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := create_venue_booking(v_a, v_board, v_base + interval '10 hours', v_base + interval '12 hours', 'meeting', 'Board', 'Dayo', 'd@example.com', null, 10, null, true, 'k-b4');
  if r ->> 'status' <> 'tentative' then raise exception 'FAIL other venue %', r; end if;

  -- a lapsed hold frees the slot, inside the same transaction that needs it
  perform t_sys();
  update venue_bookings set hold_expires_at = now() - interval '1 minute' where id = v_b1;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := hold_venue_booking(v_b2);
  if r ->> 'status' <> 'tentative' then raise exception 'FAIL lapsed hold not released %', r; end if;
  perform t_sys();
  if (select status from venue_bookings where id = v_b1) <> 'expired' then raise exception 'FAIL b1 not expired'; end if;
  -- the lapsed one cannot be confirmed over the new hold, and holding it again says unavailable
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select hold_venue_booking(%L)', v_b1), 'VENUE_UNAVAILABLE');
  -- a customer's other-hotel view: nothing
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select hold_venue_booking(%L)', v_b1), 'NOT_FOUND');
  perform t_expect(format('select set_venue_booking_lines(%L, ''[{"kind":"other","description":"a","quantity":1,"unit_amount_minor":1}]''::jsonb)', v_b1), 'NOT_FOUND');
  raise notice 'PASS venue bookings: validation, idempotent, quote arithmetic, enquiry holds nothing, hold/double-booking, touching slots, automatic quote, lapsed hold released';
end $$;

-- deposit, balance, refund, cancel
do $$ declare
  v_a constant uuid := '00000000-0000-0000-0000-0000000000a2';
  v_base timestamp; v_venue uuid; v_bk uuid; r jsonb; b venue_bookings%rowtype;
begin
  perform t_sys();
  v_base := date_trunc('day', property_local_now(v_a)) + interval '40 days';
  select id into v_venue from hotel_venues where property_id = v_a and name = 'Grand Hall';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := create_venue_booking(v_a, v_venue, v_base + interval '9 hours', v_base + interval '17 hours', 'conference', 'Conf', 'Eze', 'eze@example.com', null, 150, null, false, 'k-p1');
  v_bk := (r ->> 'booking_id')::uuid;
  perform set_venue_booking_lines(v_bk, '[{"kind":"venue","description":"Hire","quantity":1,"unit_amount_minor":1000000}]'::jsonb);
  -- 1,000,000 + 10% = 1,100,000; tax 7.5% = 82,500; total 1,182,500; deposit 30% = ceil(354,750) = 354,750
  perform t_sys();
  select * into b from venue_bookings where id = v_bk;
  if (b.total_minor, b.deposit_minor) <> (1182500, 354750) then raise exception 'FAIL totals %', b; end if;

  -- money before the slot is held is refused; confirm without the deposit is refused
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select record_event_payment(%L, null, 100000, ''cash'', null, null, ''p-0'')', v_bk), 'INVALID_STATE: enquiry');
  perform hold_venue_booking(v_bk);
  perform t_expect(format('select confirm_venue_booking(%L)', v_bk), 'PAYMENT_REQUIRED');

  -- manual payment: validation, who may
  perform t_expect(format('select record_event_payment(%L, null, 0, ''cash'', null, null, ''p-1'')', v_bk), 'POLICY_VIOLATION: amount must be positive');
  perform t_expect(format('select record_event_payment(%L, null, 100000, ''card'', null, null, ''p-1'')', v_bk), 'POLICY_VIOLATION: payment method');
  perform t_expect(format('select record_event_payment(%L, %L, 100000, ''cash'', null, null, ''p-1'')', v_bk, v_bk), 'POLICY_VIOLATION: target');
  perform t_expect(format('select record_event_payment(null, null, 100000, ''cash'', null, null, ''p-1'')'), 'POLICY_VIOLATION: target');
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select record_event_payment(%L, null, 100000, ''cash'', null, null, ''p-1'')', v_bk), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select record_event_payment(%L, null, 100000, ''cash'', null, null, ''p-1'')', v_bk), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := record_event_payment(v_bk, null, 100000, 'cash', 'slip-1', 'part deposit', 'p-1');
  if r ->> 'status' <> 'tentative' then raise exception 'FAIL still held %', r; end if;
  if record_event_payment(v_bk, null, 100000, 'cash', 'slip-1', 'part deposit', 'p-1') <> r then raise exception 'FAIL payment idempotent'; end if;
  perform t_sys();
  if venue_booking_paid(v_bk) <> 100000 then raise exception 'FAIL paid after retry %', venue_booking_paid(v_bk); end if;
  -- the rest of the deposit confirms the booking by itself
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := record_event_payment(v_bk, null, 254750, 'bank_transfer', null, null, 'p-2');
  if r ->> 'status' <> 'confirmed' then raise exception 'FAIL not confirmed %', r; end if;
  perform t_sys();
  select * into b from venue_bookings where id = v_bk;
  if b.status <> 'confirmed' or b.hold_expires_at is not null or b.deposit_waived then raise exception 'FAIL confirmed row %', b; end if;
  -- overpayment, and quote changes below what is paid
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select record_event_payment(%L, null, 900000, ''cash'', null, null, ''p-3'')', v_bk), 'OVERPAYMENT outstanding 827750');
  perform t_expect(format('select set_venue_booking_lines(%L, ''[{"kind":"venue","description":"Cheaper","quantity":1,"unit_amount_minor":100000}]''::jsonb)', v_bk), 'POLICY_VIOLATION: total below paid');
  -- payments cannot be edited or deleted
  perform t_sys();
  begin update event_payments set amount_minor = 1 where venue_booking_id = v_bk; raise exception 'FAIL payment edited'; exception when sqlstate '23514' then null; end;
  begin delete from event_payments where venue_booking_id = v_bk; raise exception 'FAIL payment deleted'; exception when sqlstate '23514' then null; end;

  -- refunds: refund.approve only (not front desk), never above what was taken
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select record_event_refund(%L, null, 1000, ''cash'', null, null, ''r-0'')', v_bk), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select record_event_refund(%L, null, 354751, ''cash'', null, null, ''r-1'')', v_bk), 'REFUND_EXCEEDS_PAYMENT refundable 354750');
  perform t_expect(format('select record_event_refund(%L, null, 1000, ''ussd'', null, null, ''r-1'')', v_bk), 'POLICY_VIOLATION: payment method');
  r := record_event_refund(v_bk, null, 54750, 'bank_transfer', 'ref-77', 'goodwill', 'r-1');
  if (r ->> 'refundable_minor')::bigint <> 300000 then raise exception 'FAIL refundable %', r; end if;
  perform t_sys();
  if venue_booking_paid(v_bk) <> 300000 then raise exception 'FAIL net paid %', venue_booking_paid(v_bk); end if;
  -- the accountant sees the money lines; housekeeping does not
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  if (select count(*) from event_payments where venue_booking_id = v_bk) <> 3 then raise exception 'FAIL accountant payment rows'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  if (select count(*) from event_payments) <> 0 or (select count(*) from venue_bookings) <> 0 then raise exception 'FAIL housekeeping sees events money'; end if;

  -- cancel: reason needed, money stays and is reported, the slot is free again
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select cancel_venue_booking(%L, ''changed plans'')', v_bk), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select cancel_venue_booking(%L, '' '')', v_bk), 'POLICY_VIOLATION: reason');
  r := cancel_venue_booking(v_bk, 'Client postponed');
  if r ->> 'status' <> 'cancelled' or (r ->> 'paid_minor')::bigint <> 300000 then raise exception 'FAIL cancel %', r; end if;
  if cancel_venue_booking(v_bk, 'again') ->> 'status' <> 'cancelled' then raise exception 'FAIL cancel twice'; end if;
  perform t_expect(format('select record_event_payment(%L, null, 1000, ''cash'', null, null, ''p-9'')', v_bk), 'INVALID_STATE: cancelled');
  r := create_venue_booking(v_a, v_venue, v_base + interval '9 hours', v_base + interval '17 hours', 'conference', 'Again', 'Fay', 'fay@example.com', null, 150, null, true, 'k-p2');
  if r ->> 'status' <> 'tentative' then raise exception 'FAIL slot not freed %', r; end if;
  -- an enquiry nobody held and nobody paid is declined, not cancelled
  r := create_venue_booking(v_a, v_venue, v_base + interval '30 days', v_base + interval '30 days 5 hours', 'party', 'Maybe', 'Gus', 'gus@example.com', null, 40, null, false, 'k-p3');
  if cancel_venue_booking((r ->> 'booking_id')::uuid, 'Not available') ->> 'status' <> 'declined' then raise exception 'FAIL decline'; end if;
  perform t_sys();
  if (select count(*) from audit_logs where action in ('venue_booking.created', 'venue_booking.quoted', 'venue_booking.held', 'venue_booking.cancelled', 'venue_booking.declined',
        'event_payment.recorded', 'event_payment.refunded')) < 10 then raise exception 'FAIL audit coverage'; end if;
  raise notice 'PASS venue money: deposit confirms the booking, idempotent payments, overpayment, quote floor, immutable ledger, refund rules, cancel and decline free the slot';
end $$;

-- waived deposit, completion, room blocks, linked stays
do $$ declare
  v_a constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_std constant uuid := '00000000-0000-0000-0000-0000000000a3'; v_solo constant uuid := '00000000-0000-0000-0000-0000000000a4';
  v_base timestamp; v_venue uuid; v_bk uuid; r jsonb; v_blk uuid; v_blk2 uuid; v_res uuid; v_day date; v_n integer;
begin
  perform t_sys();
  v_base := date_trunc('day', property_local_now(v_a)) + interval '60 days';
  v_day := v_base::date;
  select id into v_venue from hotel_venues where property_id = v_a and name = 'Grand Hall';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  r := create_venue_booking(v_a, v_venue, v_base + interval '14 hours', v_base + interval '23 hours', 'wedding', 'Big day', 'Hope', 'hope@example.com', null, 250, null, false, 'k-r1');
  v_bk := (r ->> 'booking_id')::uuid;
  perform set_venue_booking_lines(v_bk, '[{"kind":"venue","description":"Hire","quantity":1,"unit_amount_minor":800000}]'::jsonb);
  -- the deposit can be waived for a client on account; it is recorded on the booking
  r := confirm_venue_booking(v_bk, true);
  if r ->> 'status' <> 'confirmed' then raise exception 'FAIL waive %', r; end if;
  perform t_sys();
  if not (select deposit_waived from venue_bookings where id = v_bk) then raise exception 'FAIL waiver not recorded'; end if;
  if (select (metadata ->> 'deposit_waived')::boolean from audit_logs where action = 'venue_booking.confirmed' and entity_id = v_bk) is not true then raise exception 'FAIL waiver audit'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  if confirm_venue_booking(v_bk, false) ->> 'status' <> 'confirmed' then raise exception 'FAIL confirm twice'; end if;
  perform t_expect(format('select complete_venue_booking(%L)', v_bk), 'INVALID_STATE: too early');

  -- room blocks: event.manage and room.block both; the front desk has no room.block
  perform t_expect(format('select create_event_room_block(%L, %L, 2, %L, %L)', v_bk, v_std, v_day, v_day + 2), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  perform t_expect(format('select create_event_room_block(%L, %L, 0, %L, %L)', v_bk, v_std, v_day, v_day + 2), 'POLICY_VIOLATION: rooms');
  perform t_expect(format('select create_event_room_block(%L, %L, 2, %L, %L)', v_bk, v_std, v_day, v_day), 'POLICY_VIOLATION: dates');
  perform t_expect(format('select create_event_room_block(%L, %L, 2, %L, %L)', v_bk, v_std, v_day - 100, v_day - 98), 'POLICY_VIOLATION: block cannot start in the past');
  perform t_expect(format('select create_event_room_block(%L, %L, 2, %L, %L)', v_bk, '00000000-0000-0000-0000-0000000000b3', v_day, v_day + 2), 'NOT_FOUND: room type');
  perform t_expect(format('select create_event_room_block(%L, %L, 2, %L, %L)', v_bk, v_solo, v_day, v_day + 2), 'ROOM_UNAVAILABLE');   -- one solo suite only
  perform t_sys();
  select count(*) into v_n from room_inventory_claims where claim_type = 'block' and status = 'active' and start_date = v_day;
  if v_n <> 0 then raise exception 'FAIL a refused block left claims %', v_n; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  r := create_event_room_block(v_bk, v_std, 3, v_day, v_day + 2);
  v_blk := (r ->> 'block_id')::uuid;
  perform t_sys();
  select count(*) into v_n from room_inventory_claims where claim_type = 'block' and status = 'active' and start_date = v_day and block_reason like 'Event EVB-%';
  if v_n <> 3 then raise exception 'FAIL block claims %', v_n; end if;
  -- the rooms are really held: 3 of the standard rooms are held, so a request for all but two is refused
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  select count(*) into v_n from rooms where property_id = v_a and room_type_id = v_std;
  perform t_expect(format('select create_event_room_block(%L, %L, %s, %L, %L)', v_bk, v_std, least(v_n - 2, 50), v_day, v_day + 1), 'ROOM_UNAVAILABLE');
  r := create_event_room_block(v_bk, v_std, 2, v_day + 1, v_day + 2);
  v_blk2 := (r ->> 'block_id')::uuid;
  perform release_event_room_block(v_blk2);
  perform release_event_room_block(v_blk2);   -- twice is fine
  perform t_sys();
  if (select status from event_room_blocks where id = v_blk2) <> 'released' then raise exception 'FAIL release'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select release_event_room_block(%L)', v_blk), 'NOT_FOUND');

  -- linked stays: a reservation of this hotel can be linked and unlinked; another hotel's cannot
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  v_res := (t_book(v_std, v_day, v_day + 2, 'k-link-1') ->> 'reservation_id')::uuid;
  perform set_event_reservation_link(v_bk, v_res, true);
  perform set_event_reservation_link(v_bk, v_res, true);
  perform t_sys();
  if (select count(*) from event_reservation_links where booking_id = v_bk) <> 1 then raise exception 'FAIL link'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform set_event_reservation_link(v_bk, v_res, false);
  perform t_sys();
  if (select count(*) from event_reservation_links where booking_id = v_bk) <> 0 then raise exception 'FAIL unlink'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select set_event_reservation_link(%L, %L, true)', v_bk, gen_random_uuid()), 'NOT_FOUND: reservation');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select set_event_reservation_link(%L, %L, true)', v_bk, v_res), 'NOT_FOUND');

  -- cancelling the booking gives the block rooms back
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform cancel_venue_booking(v_bk, 'Client withdrew');
  perform t_sys();
  select count(*) into v_n from room_inventory_claims where claim_type = 'block' and status = 'active' and block_reason like 'Event EVB-%' and start_date = v_day;
  if v_n <> 0 then raise exception 'FAIL block rooms not given back %', v_n; end if;
  if (select status from event_room_blocks where id = v_blk) <> 'released' then raise exception 'FAIL block row'; end if;
  raise notice 'PASS event rooms: deposit waiver recorded, all-or-nothing blocks, real inventory, release, linked stays, cancel gives rooms back';
end $$;

do $$ begin
  perform t_sys();
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in
      ('save_hotel_venue', 'create_venue_booking', 'record_event_payment', 'record_event_refund', 'create_event_room_block', 'confirm_venue_booking')
      and has_function_privilege('anon', p.oid, 'execute')) <> 0 then raise exception 'FAIL anon can run an events function'; end if;
  if has_function_privilege('authenticated', 'venue_booking_paid(uuid)', 'execute') or has_function_privilege('authenticated', 'venue_booking_recalc(uuid)', 'execute')
     or has_function_privilege('authenticated', 'property_local_now(uuid)', 'execute') then raise exception 'FAIL internal helper open to staff'; end if;
  raise notice 'PASS events functions: closed to anon, internal helpers closed to staff';
end $$;
