-- Events parts 2 to 4 (migrations 141, 142, 143): ticketed events, tickets and the door, online venue booking and ticket orders, Paystack
-- confirmation by EVT- reference, and the events report. Needs 140_event_venues.sql to have run (Grand Hall, Boardroom, event terms 7.5 / 10 / 30 / 48).
-- Users: aa01 owner A, aa02 housekeeping A, aa04 front desk A, aa05 accountant A, bb01 owner B. Host book.hotel-a.test (06).
\set ON_ERROR_STOP on

do $$ declare
  v_a constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_base timestamp; v_venue uuid; v_board uuid; r jsonb; v_ev uuid; v_ev2 uuid;
  v_t1 uuid; v_t2 uuid; v_n integer;
begin
  perform t_sys();
  v_base := date_trunc('day', property_local_now(v_a)) + interval '90 days';
  select id into v_venue from hotel_venues where property_id = v_a and name = 'Grand Hall';
  select id into v_board from hotel_venues where property_id = v_a and name = 'Boardroom';

  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select save_hotel_event(%L, null, ''Jazz night'', '''', null, %L, %L, 10, null)', v_a, v_base + interval '19 hours', v_base + interval '23 hours'), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select save_hotel_event(%L, null, ''  '', '''', null, %L, %L, 10, null)', v_a, v_base + interval '19 hours', v_base + interval '23 hours'), 'POLICY_VIOLATION: title');
  perform t_expect(format('select save_hotel_event(%L, null, ''Jazz'', '''', null, %L, %L, 10, null)', v_a, v_base + interval '23 hours', v_base + interval '19 hours'), 'POLICY_VIOLATION: times');
  perform t_expect(format('select save_hotel_event(%L, null, ''Jazz'', '''', null, %L, %L, 0, null)', v_a, v_base + interval '19 hours', v_base + interval '23 hours'), 'POLICY_VIOLATION: max per order');
  perform t_expect(format('select save_hotel_event(%L, null, ''Jazz'', '''', null, %L, %L, 10, %L)', v_a, v_base + interval '19 hours', v_base + interval '23 hours', v_base + interval '30 hours'), 'POLICY_VIOLATION: sales close');
  perform t_expect(format('select save_hotel_event(%L, null, ''Jazz'', '''', null, %L, %L, 10, null)', v_a, v_base - interval '200 days', v_base - interval '200 days' + interval '3 hours'), 'POLICY_VIOLATION: past');

  -- an event with a venue holds the venue's slot
  r := save_hotel_event(v_a, null, 'Jazz night', 'Live band', v_venue, v_base + interval '19 hours', v_base + interval '23 hours', 6, null);
  v_ev := (r ->> 'event_id')::uuid;
  perform t_sys();
  if (select count(*) from venue_bookings where source = 'ticketed_event' and status = 'confirmed' and venue_id = v_venue and starts_at = v_base + interval '19 hours') <> 1 then raise exception 'FAIL venue slot'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select create_venue_booking(%L, %L, %L, %L, ''party'', ''Clash'', ''Ife'', ''ife@example.com'', null, 20, null, true, ''k-t-clash'')', v_a, v_venue, v_base + interval '20 hours', v_base + interval '21 hours'), 'VENUE_UNAVAILABLE');
  raise notice 'PASS ticketed event created with its venue slot held';
end $$;

do $$ declare
  v_a constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_base timestamp; v_venue uuid; r jsonb; v_ev uuid; v_ev2 uuid; v_t1 uuid; v_t2 uuid; v_order uuid; v_code text;
  v_n integer;
begin
  perform t_sys();
  v_base := date_trunc('day', property_local_now(v_a)) + interval '90 days';
  select id into v_venue from hotel_venues where property_id = v_a and name = 'Grand Hall';
  select id into v_ev from hotel_events where title = 'Jazz night';
  if v_ev is null then raise exception 'FAIL event missing'; end if;

  -- another event cannot take the same venue slot; a clash changes nothing
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select save_hotel_event(%L, null, ''Rival'', '''', %L, %L, %L, 6, null)', v_a, v_venue, v_base + interval '20 hours', v_base + interval '22 hours'), 'VENUE_UNAVAILABLE');
  perform t_sys();
  if exists (select 1 from hotel_events where title = 'Rival') then raise exception 'FAIL clash left an event'; end if;

  -- ticket types: validation, venue capacity (300), limit, unique name
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select save_ticket_type(%L, null, '' '', 5000, 10, true)', v_ev), 'POLICY_VIOLATION: name');
  perform t_expect(format('select save_ticket_type(%L, null, ''Reg'', -1, 10, true)', v_ev), 'POLICY_VIOLATION: price');
  perform t_expect(format('select save_ticket_type(%L, null, ''Reg'', 5000, 0, true)', v_ev), 'POLICY_VIOLATION: quantity');
  perform t_expect(format('select save_ticket_type(%L, null, ''Reg'', 5000, 301, true)', v_ev), 'POLICY_VIOLATION: venue capacity');
  v_t1 := (save_ticket_type(v_ev, null, 'Regular', 500000, 10, true) ->> 'ticket_type_id')::uuid;
  v_t2 := (save_ticket_type(v_ev, null, 'VIP', 1500000, 5, true, 1) ->> 'ticket_type_id')::uuid;
  perform t_expect(format('select save_ticket_type(%L, null, ''regular'', 1, 1, true)', v_ev), 'POLICY_VIOLATION: name taken');
  perform t_expect(format('select save_ticket_type(%L, null, ''Big'', 1, 290, true)', v_ev), 'POLICY_VIOLATION: venue capacity');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select save_ticket_type(%L, null, ''X'', 1, 1, true)', v_ev), 'NOT_FOUND');

  -- on sale needs tickets; draft sells nothing
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select staff_sell_tickets(%L, %L, %L::jsonb, ''Kemi'', null, ''+2348011111111'', ''cash'', null, ''s-0'')', v_a, v_ev, format('[{"ticket_type_id":"%s","quantity":1}]', v_t1)), 'INVALID_STATE: not on sale');
  perform set_hotel_event_status(v_ev, 'on_sale');

  -- staff sell at the desk: order + manual payment in one step, tickets issued
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select staff_sell_tickets(%L, %L, %L::jsonb, ''Kemi'', null, ''+2348011111111'', ''cash'', null, ''s-1'')', v_a, v_ev, format('[{"ticket_type_id":"%s","quantity":1}]', v_t1)), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select staff_sell_tickets(%L, %L, %L::jsonb, ''Kemi'', null, null, ''cash'', null, ''s-1'')', v_a, v_ev, format('[{"ticket_type_id":"%s","quantity":1}]', v_t1)), 'POLICY_VIOLATION: contact');
  perform t_expect(format('select staff_sell_tickets(%L, %L, %L::jsonb, ''Kemi'', null, ''+2348011111111'', ''cash'', null, ''s-1'')', v_a, v_ev, format('[{"ticket_type_id":"%s","quantity":7}]', v_t1)), 'POLICY_VIOLATION: too many tickets');
  perform t_expect(format('select staff_sell_tickets(%L, %L, %L::jsonb, ''Kemi'', null, ''+2348011111111'', ''cash'', null, ''s-1'')', v_a, v_ev, format('[{"ticket_type_id":"%s","quantity":1},{"ticket_type_id":"%s","quantity":1}]', v_t1, v_t1)), 'POLICY_VIOLATION: items');
  perform t_expect(format('select staff_sell_tickets(%L, %L, %L::jsonb, ''Kemi'', null, ''+2348011111111'', ''cash'', null, ''s-1'')', v_a, v_ev, format('[{"ticket_type_id":"%s","quantity":1}]', gen_random_uuid())), 'NOT_FOUND: ticket type');
  r := staff_sell_tickets(v_a, v_ev, format('[{"ticket_type_id":"%s","quantity":2},{"ticket_type_id":"%s","quantity":1}]', v_t1, v_t2)::jsonb, 'Kemi', null, '+2348011111111', 'cash', 'rcpt-1', 's-2');
  v_order := (r ->> 'order_id')::uuid;
  if r ->> 'status' <> 'paid' or (r ->> 'total_minor')::bigint <> 2500000 then raise exception 'FAIL sale %', r; end if;
  if staff_sell_tickets(v_a, v_ev, format('[{"ticket_type_id":"%s","quantity":2},{"ticket_type_id":"%s","quantity":1}]', v_t1, v_t2)::jsonb, 'Kemi', null, '+2348011111111', 'cash', 'rcpt-1', 's-2') <> r then raise exception 'FAIL sale idempotent'; end if;
  perform t_sys();
  select count(*) into v_n from tickets where order_id = v_order and status = 'valid';
  if v_n <> 3 then raise exception 'FAIL tickets issued %', v_n; end if;
  if ticket_order_paid(v_order) <> 2500000 then raise exception 'FAIL order paid after a retry %', ticket_order_paid(v_order); end if;
  if (select count(*) from tickets where code !~ '^T[0-9A-F]{9}$') <> 0 then raise exception 'FAIL code shape'; end if;

  -- sold out: VIP has 5, 1 sold; 5 more would be 6
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select staff_sell_tickets(%L, %L, %L::jsonb, ''Lola'', ''l@example.com'', null, ''cash'', null, ''s-3'')', v_a, v_ev, format('[{"ticket_type_id":"%s","quantity":5}]', v_t2)), 'SOLD_OUT');
  perform t_sys();
  if (select count(*) from ticket_orders where buyer_name = 'Lola') <> 0 then raise exception 'FAIL sold-out left an order'; end if;
  -- the quantity cannot go below what is sold
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select save_ticket_type(%L, %L, ''Regular'', 500000, 1, true)', v_ev, v_t1), 'POLICY_VIOLATION: below sold 2');
  perform t_expect(format('select delete_ticket_type(%L)', v_t1), 'INVALID_STATE: used');
  perform t_expect(format('select set_hotel_event_status(%L, ''draft'')', v_ev), 'INVALID_STATE: has orders');
  perform t_expect(format('select delete_hotel_event(%L)', v_ev), 'INVALID_STATE: has orders');

  -- the door
  select code into v_code from tickets where order_id = v_order order by code limit 1;
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select ticket_check_in(%L, %L)', v_a, v_code), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select ticket_check_in(%L, ''TNOPE'')', v_a), 'NOT_FOUND: ticket');
  perform t_expect(format('select ticket_check_in(%L, %L, %L)', v_a, v_code, gen_random_uuid()), 'INVALID_STATE: wrong event');
  r := ticket_check_in(v_a, lower(v_code), v_ev);
  if r ->> 'status' <> 'ok' or (r ->> 'checked_in')::integer <> 1 or (r ->> 'tickets')::integer <> 3 or r ->> 'buyer' <> 'Kemi' then raise exception 'FAIL check in %', r; end if;
  perform t_expect(format('select ticket_check_in(%L, %L)', v_a, v_code), 'INVALID_STATE: used');
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select ticket_check_in(%L, %L)', '00000000-0000-0000-0000-0000000000b2', v_code), 'NOT_FOUND: ticket');

  -- cancelling an order: refused once a ticket was used; otherwise voids the tickets and keeps the money on the order
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select cancel_ticket_order(%L, ''changed mind'')', v_order), 'INVALID_STATE: used');
  r := staff_sell_tickets(v_a, v_ev, format('[{"ticket_type_id":"%s","quantity":1}]', v_t1)::jsonb, 'Mide', 'mide@example.com', null, 'pos', null, 's-4');
  perform t_expect(format('select cancel_ticket_order(%L, '' '')', (r ->> 'order_id')::uuid), 'POLICY_VIOLATION: reason');
  r := cancel_ticket_order((r ->> 'order_id')::uuid, 'Double booked');
  if r ->> 'status' <> 'cancelled' or (r ->> 'paid_minor')::bigint <> 500000 then raise exception 'FAIL cancel order %', r; end if;
  perform t_sys();
  if (select count(*) from tickets t join ticket_orders o on o.id = t.order_id where o.buyer_name = 'Mide' and t.status = 'void') <> 1 then raise exception 'FAIL not voided'; end if;
  -- the refund of a ticket: refund.approve only
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select record_event_refund(null, %L, 500000, ''pos'', null, null, ''tr-0'')', (select id from ticket_orders where buyer_name = 'Mide')), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform record_event_refund(null, (select id from ticket_orders where buyer_name = 'Mide'), 500000, 'pos', null, 'back to buyer', 'tr-1');
  perform t_sys();
  if ticket_order_paid((select id from ticket_orders where buyer_name = 'Mide')) <> 0 then raise exception 'FAIL ticket refund'; end if;
  raise notice 'PASS ticketed events: venue slot held, clash changes nothing, ticket types and capacity, staff sale, sold out, door check-in, order cancel and refund rules';
end $$;

-- event cancel, close, free events
do $$ declare
  v_a constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_base timestamp; v_board uuid; v_ev uuid; v_t uuid; r jsonb; v_main uuid; v_n integer;
begin
  perform t_sys();
  v_base := date_trunc('day', property_local_now(v_a)) + interval '120 days';
  select id into v_board from hotel_venues where property_id = v_a and name = 'Boardroom';
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  v_ev := (save_hotel_event(v_a, null, 'Free talk', '', v_board, v_base + interval '10 hours', v_base + interval '12 hours', 3, v_base + interval '9 hours') ->> 'event_id')::uuid;
  perform t_expect(format('select save_ticket_type(%L, null, ''Seat'', 0, 21, true)', v_ev), 'POLICY_VIOLATION: venue capacity');
  v_t := (save_ticket_type(v_ev, null, 'Seat', 0, 10, true) ->> 'ticket_type_id')::uuid;
  perform set_hotel_event_status(v_ev, 'on_sale');
  -- a free order is paid at once and needs no payment
  perform t_sys();
  r := guest_create_ticket_order('book.hotel-a.test', v_ev, format('[{"ticket_type_id":"%s","quantity":2}]', v_t)::jsonb, 'Nia', 'nia@example.com', null, 'g-free');
  if r ->> 'status' <> 'paid' or (r ->> 'total_minor')::bigint <> 0 then raise exception 'FAIL free order %', r; end if;
  perform t_sys();
  if (select count(*) from tickets where event_id = v_ev and status = 'valid') <> 2 then raise exception 'FAIL free tickets'; end if;
  -- close: no more sales, tickets still work
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform set_hotel_event_status(v_ev, 'closed');
  perform t_sys();
  begin perform guest_create_ticket_order('book.hotel-a.test', v_ev, format('[{"ticket_type_id":"%s","quantity":1}]', v_t)::jsonb, 'Ola', 'ola@example.com', null, 'g-closed'); raise exception 'FAIL sold after close';
  exception when sqlstate 'P0001' then if sqlerrm not like 'INVALID_STATE%' then raise; end if; end;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform ticket_check_in(v_a, (select code from tickets where event_id = v_ev order by code limit 1), v_ev);
  -- cancel the event: venue freed, tickets voided, cancelled is final
  perform set_hotel_event_status(v_ev, 'cancelled');
  perform t_sys();
  if (select status from venue_bookings where id = (select venue_booking_id from hotel_events where id = v_ev)) <> 'cancelled' then raise exception 'FAIL slot not freed'; end if;
  if (select count(*) from tickets where event_id = v_ev and status = 'valid') <> 0 then raise exception 'FAIL valid tickets after cancel'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select set_hotel_event_status(%L, ''on_sale'')', v_ev), 'INVALID_STATE: cancelled');
  perform t_expect(format('select save_ticket_type(%L, null, ''Late'', 1, 1, true)', v_ev), 'INVALID_STATE: cancelled');
  r := create_venue_booking(v_a, v_board, v_base + interval '10 hours', v_base + interval '12 hours', 'meeting', 'After', 'Pam', 'pam@example.com', null, 5, null, true, 'k-after');
  if r ->> 'status' <> 'tentative' then raise exception 'FAIL venue not free after cancel %', r; end if;
  -- an unused event can be deleted, and its slot goes with it
  v_main := (save_hotel_event(v_a, null, 'Draft party', '', null, v_base + interval '40 hours', v_base + interval '44 hours', 5, null) ->> 'event_id')::uuid;
  perform delete_hotel_event(v_main);
  perform t_sys();
  if exists (select 1 from hotel_events where id = v_main) then raise exception 'FAIL delete'; end if;
  raise notice 'PASS event lifecycle: free order paid at once, closed sells nothing but tickets work, cancel frees the slot and voids tickets, cancelled is final, delete';
end $$;

-- the website: venues, busy times, requests
do $$ declare
  v_a constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_base timestamp; v_venue uuid; v_board uuid; r jsonb; v_bk uuid; v_att jsonb; b venue_bookings%rowtype;
begin
  perform t_sys();
  v_base := date_trunc('day', property_local_now(v_a)) + interval '150 days';
  select id into v_venue from hotel_venues where property_id = v_a and name = 'Grand Hall';
  select id into v_board from hotel_venues where property_id = v_a and name = 'Boardroom';
  r := guest_venues('book.hotel-a.test');
  if jsonb_array_length(r -> 'venues') <> 2 or (r ->> 'deposit_percent')::integer <> 30 or r::text like '%00000000-0000-0000-0000-0000000000a%' then raise exception 'FAIL guest venues %', r; end if;
  if jsonb_array_length(guest_venues('hotel-b.test') -> 'venues') <> 0 then raise exception 'FAIL other hotel venues'; end if;
  begin perform guest_venues('draft.hotel-a.test'); raise exception 'FAIL unverified host'; exception when sqlstate 'P0001' then null; end;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  begin perform guest_venues('book.hotel-a.test'); raise exception 'FAIL staff called a service function'; exception when insufficient_privilege then null; end;
  perform t_sys();

  -- requests: validation, not-online venues cannot be booked, soon is refused
  perform t_expect(format('select guest_request_venue(''book.hotel-a.test'', %L, %L, %L, ''wedding'', ''T'', ''Zed'', null, null, 50, null, ''enquiry'', ''g-1'')', v_venue, v_base + interval '10 hours', v_base + interval '16 hours'), 'POLICY_VIOLATION: email');
  perform t_expect(format('select guest_request_venue(''book.hotel-a.test'', %L, %L, %L, ''wedding'', ''T'', ''Zed'', ''z@example.com'', null, 50, null, ''hold'', ''g-1'')', v_venue, v_base + interval '10 hours', v_base + interval '16 hours'), 'POLICY_VIOLATION: mode');
  perform t_expect(format('select guest_request_venue(''book.hotel-a.test'', %L, %L, %L, ''meeting'', ''T'', ''Zed'', ''z@example.com'', null, 5, null, ''book'', ''g-1'')', v_board, v_base + interval '10 hours', v_base + interval '16 hours'), 'POLICY_VIOLATION: not bookable online');
  perform t_expect(format('select guest_request_venue(''book.hotel-a.test'', %L, %L, %L, ''wedding'', ''T'', ''Zed'', ''z@example.com'', null, 50, null, ''book'', ''g-1'')', v_venue, property_local_now(v_a) + interval '10 hours', property_local_now(v_a) + interval '14 hours'), 'POLICY_VIOLATION: too soon');
  perform t_expect(format('select guest_request_venue(''book.hotel-a.test'', %L, %L, %L, ''wedding'', ''T'', ''Zed'', ''z@example.com'', null, 50, null, ''enquiry'', ''g-1'')', v_venue, v_base + interval '700 days', v_base + interval '700 days 4 hours'), 'POLICY_VIOLATION: too far');
  perform t_expect(format('select guest_request_venue(''hotel-b.test'', %L, %L, %L, ''wedding'', ''T'', ''Zed'', ''z@example.com'', null, 50, null, ''enquiry'', ''g-1'')', v_venue, v_base + interval '10 hours', v_base + interval '16 hours'), 'NOT_FOUND: venue');

  -- an enquiry holds nothing; a booking holds with an automatic quote: 6 h x 50,000 = 300,000 (+10% +7.5%) = 354,750; deposit 106,425
  r := guest_request_venue('book.hotel-a.test', v_venue, v_base + interval '10 hours', v_base + interval '16 hours', 'wedding', 'Zed wedding', 'Zed', 'z@example.com', '+2348022222222', 50, null, 'enquiry', 'g-2');
  if r ->> 'status' <> 'enquiry' then raise exception 'FAIL enquiry %', r; end if;
  r := guest_request_venue('book.hotel-a.test', v_venue, v_base + interval '10 hours', v_base + interval '16 hours', 'wedding', 'Zed wedding', 'Zed', 'z@example.com', '+2348022222222', 50, null, 'book', 'g-3');
  v_bk := (r ->> 'booking_id')::uuid;
  if r ->> 'status' <> 'tentative' then raise exception 'FAIL online hold %', r; end if;
  if guest_request_venue('book.hotel-a.test', v_venue, v_base + interval '10 hours', v_base + interval '16 hours', 'wedding', 'Zed wedding', 'Zed', 'z@example.com', '+2348022222222', 50, null, 'book', 'g-3') <> r then raise exception 'FAIL idempotent'; end if;
  select * into b from venue_bookings where id = v_bk;
  if (b.total_minor, b.deposit_minor) <> (354750, 106425) or b.source <> 'website' then raise exception 'FAIL online quote %', b; end if;
  -- busy times show the held slot with no names
  r := guest_venue_busy('book.hotel-a.test', v_venue, v_base::date, v_base::date);
  if jsonb_array_length(r -> 'busy') <> 1 or r::text like '%Zed%' or r::text like '%example.com%' then raise exception 'FAIL busy %', r; end if;
  -- someone else cannot book the same slot
  perform t_expect(format('select guest_request_venue(''book.hotel-a.test'', %L, %L, %L, ''party'', ''P'', ''Yan'', ''y@example.com'', null, 20, null, ''book'', ''g-4'')', v_venue, v_base + interval '12 hours', v_base + interval '15 hours'), 'VENUE_UNAVAILABLE');
  -- at most 3 open requests per email
  perform guest_request_venue('book.hotel-a.test', v_venue, v_base + interval '30 days', v_base + interval '30 days 3 hours', 'party', 'a', 'Zed', 'z@example.com', null, 20, null, 'enquiry', 'g-5');
  perform t_expect(format('select guest_request_venue(''book.hotel-a.test'', %L, %L, %L, ''party'', ''a'', ''Zed'', ''Z@Example.com'', null, 20, null, ''enquiry'', ''g-6'')', v_venue, v_base + interval '32 days', v_base + interval '32 days 3 hours'), 'POLICY_VIOLATION: too many open');

  -- the booking page: no ids of other records, due is the deposit while held
  r := guest_venue_booking(v_bk);
  if (r ->> 'due_minor')::bigint <> 106425 or r ->> 'status' <> 'tentative' or r::text like '%tenant%' then raise exception 'FAIL booking view %', r; end if;
  -- a staff-made booking is not shown on the website
  begin perform guest_venue_booking((select id from venue_bookings where source = 'staff' limit 1)); raise exception 'FAIL staff booking exposed'; exception when sqlstate 'P0001' then if sqlerrm <> 'NOT_FOUND' then raise; end if; end;
  raise notice 'PASS online venue booking: hosts, busy times without names, validation, enquiry vs held booking, automatic quote, clash, per-email limit, page view';
end $$;

-- Paystack: attempts and confirmation
do $$ declare
  v_a constant uuid := '00000000-0000-0000-0000-0000000000a2'; v_t constant uuid := '00000000-0000-0000-0000-0000000000a1';
  v_bk uuid; r jsonb; a jsonb; v_ref text; b venue_bookings%rowtype; v_ev uuid; v_ty uuid; v_order uuid; v_n integer;
begin
  perform t_sys();
  delete from payment_provider_accounts where tenant_id = v_t;
  insert into payment_provider_accounts (tenant_id, provider, mode, account_label, secret_reference, status) values (v_t, 'paystack', 'test', 'Hotel A', 'TEST_SECRET', 'active');
  select id into v_bk from venue_bookings where title = 'Zed wedding' and status = 'tentative';

  -- the amount is decided by the database: the deposit
  a := create_event_payment_attempt('booking', v_bk, 'a-1');
  if (a ->> 'amount_minor')::bigint <> 106425 or a ->> 'reference' !~ '^EVT-[0-9A-F]{16}$' then raise exception 'FAIL attempt %', a; end if;
  if create_event_payment_attempt('booking', v_bk, 'a-1') <> a then raise exception 'FAIL attempt idempotent'; end if;
  v_ref := a ->> 'reference';
  r := event_payment_start_context('booking', v_bk);
  if r ->> 'payer_email' <> 'z@example.com' or r ->> 'secret_reference' <> 'TEST_SECRET' then raise exception 'FAIL start context %', r; end if;
  -- wrong amount is held for a person, nothing recorded
  r := confirm_payment('paystack', 'evt-1', 'charge.success', v_ref, 'success', 100, 'NGN', 'card', '{}'::jsonb, '00000000-0000-0000-0000-0000000000a1');
  if r ->> 'result' <> 'mismatch' then raise exception 'FAIL mismatch %', r; end if;
  if venue_booking_paid(v_bk) <> 0 or (select attention_reason from venue_bookings where id = v_bk) <> 'payment_amount_or_currency_mismatch' then raise exception 'FAIL mismatch effects'; end if;
  -- another hotel's tenant cannot confirm it
  r := confirm_payment('paystack', 'evt-2', 'charge.success', v_ref, 'success', 106425, 'NGN', 'card', '{}'::jsonb, '00000000-0000-0000-0000-0000000000b1');
  if r ->> 'result' <> 'ignored' then raise exception 'FAIL cross tenant %', r; end if;
  -- a fresh attempt paid correctly confirms the booking
  perform t_sys();
  update event_payment_attempts set status = 'abandoned' where reference = v_ref;
  update venue_bookings set attention_reason = null where id = v_bk;
  a := create_event_payment_attempt('booking', v_bk, 'a-2');
  v_ref := a ->> 'reference';
  r := confirm_payment('paystack', 'evt-3', 'charge.success', v_ref, 'success', 106425, 'NGN', 'card', '{}'::jsonb, v_t);
  if r ->> 'result' <> 'confirmed' then raise exception 'FAIL confirm %', r; end if;
  if (select status from venue_bookings where id = v_bk) <> 'confirmed' then raise exception 'FAIL not confirmed'; end if;
  -- the same event twice changes nothing
  r := confirm_payment('paystack', 'evt-3', 'charge.success', v_ref, 'success', 106425, 'NGN', 'card', '{}'::jsonb, v_t);
  if (r ->> 'duplicate')::boolean is not true or venue_booking_paid(v_bk) <> 106425 then raise exception 'FAIL duplicate %', r; end if;
  -- and so does a second event for the same paid attempt
  r := confirm_payment('paystack', 'evt-4', 'charge.success', v_ref, 'success', 106425, 'NGN', 'card', '{}'::jsonb, v_t);
  if r ->> 'result' <> 'already_processed' or venue_booking_paid(v_bk) <> 106425 then raise exception 'FAIL second event %', r; end if;
  -- then the balance: 354,750 - 106,425 = 248,325
  a := create_event_payment_attempt('booking', v_bk, 'a-3');
  if (a ->> 'amount_minor')::bigint <> 248325 then raise exception 'FAIL balance attempt %', a; end if;
  r := confirm_payment('paystack', 'evt-5', 'charge.success', a ->> 'reference', 'success', 248325, 'NGN', 'bank', '{}'::jsonb, v_t);
  if venue_booking_paid(v_bk) <> 354750 then raise exception 'FAIL balance'; end if;
  begin perform create_event_payment_attempt('booking', v_bk, 'a-4'); raise exception 'FAIL nothing due'; exception when sqlstate 'P0001' then if sqlerrm <> 'INVALID_STATE: nothing due' then raise; end if; end;
  -- a room-booking reference still goes the old way (unknown here, so ignored)
  r := confirm_payment('paystack', 'evt-6', 'charge.success', 'PAY-DOES-NOT-EXIST', 'success', 100, 'NGN', 'card', '{}'::jsonb, v_t);
  if r ->> 'result' <> 'ignored' then raise exception 'FAIL room route %', r; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  begin perform create_event_payment_attempt('booking', v_bk, 'a-5'); raise exception 'FAIL staff made an attempt'; exception when insufficient_privilege then null; end;
  perform t_sys();

  -- ticket order by the website: hold, pay, tickets; a paid-after-expiry order takes its tickets back while there are some
  select id into v_ev from hotel_events where title = 'Jazz night';
  select id into v_ty from event_ticket_types where event_id = v_ev and name = 'Regular';
  r := guest_create_ticket_order('book.hotel-a.test', v_ev, format('[{"ticket_type_id":"%s","quantity":2}]', v_ty)::jsonb, 'Rex', 'rex@example.com', null, 'g-t1');
  v_order := (r ->> 'order_id')::uuid;
  if r ->> 'status' <> 'pending' or (r ->> 'total_minor')::bigint <> 1000000 then raise exception 'FAIL ticket order %', r; end if;
  if (select (e -> 'ticket_types' -> 0 ->> 'remaining')::integer from jsonb_array_elements(guest_events('book.hotel-a.test') -> 'events') e where e ->> 'title' = 'Jazz night') <> 6 then raise exception 'FAIL held tickets not counted'; end if;
  a := create_event_payment_attempt('ticket_order', v_order, 'a-t1');
  if (a ->> 'amount_minor')::bigint <> 1000000 then raise exception 'FAIL ticket attempt %', a; end if;
  update ticket_orders set hold_expires_at = now() - interval '1 minute' where id = v_order;   -- the buyer paid after the hold ran out
  if (select (e -> 'ticket_types' -> 0 ->> 'remaining')::integer from jsonb_array_elements(guest_events('book.hotel-a.test') -> 'events') e where e ->> 'title' = 'Jazz night') <> 8 then raise exception 'FAIL lapsed hold still counted'; end if;
  r := confirm_payment('paystack', 'evt-t1', 'charge.success', a ->> 'reference', 'success', 1000000, 'NGN', 'card', '{}'::jsonb, v_t);
  if r ->> 'result' <> 'confirmed' or (select status from ticket_orders where id = v_order) <> 'paid' then raise exception 'FAIL paid after expiry %', r; end if;
  select count(*) into v_n from tickets where order_id = v_order and status = 'valid'; if v_n <> 2 then raise exception 'FAIL tickets %', v_n; end if;
  -- the buyer's page shows the codes only for a paid order
  r := guest_ticket_order(v_order);
  if jsonb_array_length(r -> 'tickets') <> 2 or r ->> 'status' <> 'paid' or r::text like '%tenant%' then raise exception 'FAIL order page %', r; end if;
  -- no more than 3 open orders per email
  perform guest_create_ticket_order('book.hotel-a.test', v_ev, format('[{"ticket_type_id":"%s","quantity":1}]', v_ty)::jsonb, 'Rex', 'rex@example.com', null, 'g-t2');
  perform guest_create_ticket_order('book.hotel-a.test', v_ev, format('[{"ticket_type_id":"%s","quantity":1}]', v_ty)::jsonb, 'Rex', 'rex@example.com', null, 'g-t3');
  perform guest_create_ticket_order('book.hotel-a.test', v_ev, format('[{"ticket_type_id":"%s","quantity":1}]', v_ty)::jsonb, 'Rex', 'REX@example.com', null, 'g-t4');
  begin perform guest_create_ticket_order('book.hotel-a.test', v_ev, format('[{"ticket_type_id":"%s","quantity":1}]', v_ty)::jsonb, 'Rex', 'rex@example.com', null, 'g-t5'); raise exception 'FAIL limit';
  exception when sqlstate 'P0001' then if sqlerrm <> 'POLICY_VIOLATION: too many open' then raise; end if; end;
  -- the sweep lapses unpaid orders and holds
  update ticket_orders set hold_expires_at = now() - interval '1 minute' where status = 'pending';
  if expire_lapsed_event_holds() < 3 then raise exception 'FAIL sweep'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  begin perform expire_lapsed_event_holds(); raise exception 'FAIL staff swept'; exception when sqlstate 'P0001' then null; when insufficient_privilege then null; end;
  raise notice 'PASS event payments: db decides the amount, mismatch held for a person, other tenant ignored, deposit then balance, duplicate events harmless, room route untouched, ticket orders paid and swept';
end $$;

-- the report
do $$ declare
  v_a constant uuid := '00000000-0000-0000-0000-0000000000a2'; r jsonb; v_today date := property_today('00000000-0000-0000-0000-0000000000a2');
begin
  perform t_as('00000000-0000-0000-0000-00000000aa02');
  perform t_expect(format('select event_report(%L, %L, %L)', v_a, v_today, v_today + 365), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa04');
  perform t_expect(format('select event_report(%L, %L, %L)', v_a, v_today, v_today + 30), 'NOT_FOUND');   -- front desk has no report.view
  perform t_as('00000000-0000-0000-0000-00000000bb01');
  perform t_expect(format('select event_report(%L, %L, %L)', v_a, v_today, v_today + 30), 'NOT_FOUND');
  perform t_as('00000000-0000-0000-0000-00000000aa05');
  perform t_expect(format('select event_report(%L, %L, %L)', v_a, v_today, v_today + 400), 'POLICY_VIOLATION: dates');
  perform t_expect(format('select event_report(%L, %L, %L)', v_a, v_today + 5, v_today), 'POLICY_VIOLATION: dates');
  r := event_report(v_a, v_today, v_today + 365);
  -- the Zed wedding: 354,750 booked and received; the Okafor and Big day bookings were cancelled and do not count
  if (r -> 'booked' ->> 'bookings')::integer <> 1 or (r -> 'booked' ->> 'total_minor')::bigint <> 354750 or (r -> 'booked' ->> 'received_minor')::bigint <> 354750
     or (r -> 'booked' ->> 'outstanding_minor')::bigint <> 0 then raise exception 'FAIL booked %', r -> 'booked'; end if;
  if (r -> 'booked' ->> 'tax_minor')::bigint <> 24750 or (r -> 'booked' ->> 'service_minor')::bigint <> 30000 then raise exception 'FAIL tax split %', r -> 'booked'; end if;
  if (select (v ->> 'bookings')::integer from jsonb_array_elements(r -> 'venues') v where v ->> 'name' = 'Grand Hall') <> 1 then raise exception 'FAIL venue row %', r -> 'venues'; end if;
  -- Jazz night: 3 + 2 sold (the cancelled and refunded order is void), 1 checked in; revenue 2,500,000 + 1,000,000 + 0
  if (select (e ->> 'revenue_minor')::bigint from jsonb_array_elements(r -> 'events') e where e ->> 'title' = 'Jazz night') <> 3500000 then raise exception 'FAIL event revenue %', r -> 'events'; end if;
  if (select (e ->> 'checked_in')::integer from jsonb_array_elements(r -> 'events') e where e ->> 'title' = 'Jazz night') <> 1 then raise exception 'FAIL checked in'; end if;
  -- the cancelled free talk has nothing to give back
  if (select (e ->> 'refund_due_minor')::bigint from jsonb_array_elements(r -> 'events') e where e ->> 'title' = 'Free talk') <> 0 then raise exception 'FAIL refund due'; end if;
  perform t_as('00000000-0000-0000-0000-00000000aa01');
  if event_report(v_a, v_today, v_today + 1) ->> 'from' is null then raise exception 'FAIL owner report'; end if;
  raise notice 'PASS events report: report.view and event.view only, validated, booked and received, tax split, per-venue, ticket revenue and door counts';
end $$;
