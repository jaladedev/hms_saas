-- 142 Events, part 3: what a guest can do on the hotel's website, and Paystack payments for events. Every function here is for the
-- Next.js server only (service_role), which passes the real request Host header or an id it has already checked against a signed link, like
-- the room booking functions (009, 014).
--
-- Venue hire online. guest_venues lists the venues a hotel switched on for online booking, with the hotel's terms. guest_venue_busy shows
-- when a venue is taken (time ranges only, never who). guest_request_venue makes one of two things:
--   mode 'enquiry'  a request with nothing held; staff quote it. Any active venue.
--   mode 'book'     a booking held at once for the hotel's hold hours with an automatic quote (the venue's hire price, the hotel's tax and
--                   service percentages) and the deposit asked for. Only venues switched on for online booking. The guest pays the deposit with
--                   Paystack; the booking is confirmed when the payment lands, or lapses when the hold runs out.
-- Online bookings start at least 48 hours ahead and at most 540 days ahead. One contact email can have at most 3 open holds at a hotel.
--
-- Tickets online. guest_events lists the events on sale with what is left of each ticket type. guest_create_ticket_order holds the tickets
-- for 20 minutes (141); the guest pays with Paystack, or a free order is paid at once.
--
-- Paystack. create_event_payment_attempt decides the amount (the deposit, then the balance, for a booking; the whole total for a ticket
-- order) and never takes it from the caller. The reference starts with EVT-. confirm_payment (011) is replaced by a thin router: a reference
-- that starts with EVT- goes to confirm_event_payment, everything else to the unchanged room-booking function, renamed
-- confirm_reservation_payment. The webhook route and its signature and amount checks are untouched.

create table event_payment_attempts (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  property_id      uuid not null,
  venue_booking_id uuid,
  ticket_order_id  uuid,
  provider         text not null check (provider in ('paystack')),
  reference        text not null,
  amount_minor     bigint not null check (amount_minor > 0),
  currency         char(3) not null,
  status           text not null default 'initiated' check (status in ('initiated', 'succeeded', 'failed', 'abandoned', 'needs_attention')),
  failure_reason   text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz,
  foreign key (tenant_id, property_id, venue_booking_id) references venue_bookings (tenant_id, property_id, id),
  foreign key (tenant_id, property_id, ticket_order_id) references ticket_orders (tenant_id, property_id, id),
  unique (provider, reference),
  check ((venue_booking_id is null) <> (ticket_order_id is null))
);
create index event_payment_attempts_booking_idx on event_payment_attempts (venue_booking_id) where venue_booking_id is not null;
create index event_payment_attempts_order_idx on event_payment_attempts (ticket_order_id) where ticket_order_id is not null;
create trigger event_payment_attempts_updated before update on event_payment_attempts for each row execute function set_updated_at();
alter table event_payment_attempts enable row level security;
create policy event_payment_attempts_select on event_payment_attempts for select to authenticated using (can_view_money(property_id));
revoke insert, update, delete on event_payment_attempts from authenticated, anon;
alter table event_payments add foreign key (attempt_id) references event_payment_attempts (id);

-- ---- reading, for the website -------------------------------------------------------------------------------
create function guest_venues(p_host text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_property uuid; v_currency char(3); v_t jsonb;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  select currency into v_currency from properties where id = v_property;
  v_t := event_terms(v_property);
  return jsonb_build_object('currency', v_currency, 'deposit_percent', v_t -> 'deposit_percent', 'hold_hours', v_t -> 'hold_hours',
    'venues', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'body', x.body, 'capacity', x.capacity, 'hourly_rate_minor', x.hourly_rate_minor,
                                          'day_rate_minor', x.day_rate_minor, 'bookable_online', x.bookable_online)
                       order by x.sort_order, x.created_at)
        from hotel_venues x where x.property_id = v_property and x.is_active), '[]'::jsonb));
end $$;
revoke all on function guest_venues(text) from public, anon, authenticated;
grant execute on function guest_venues(text) to service_role;

-- When a venue is taken between two dates: time ranges only.
create function guest_venue_busy(p_host text, p_venue uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_property uuid;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then raise exception 'POLICY_VIOLATION: dates' using errcode = 'P0001'; end if;
  if not exists (select 1 from hotel_venues where id = p_venue and property_id = v_property and is_active) then raise exception 'NOT_FOUND: venue' using errcode = 'P0001'; end if;
  return jsonb_build_object('busy', coalesce((
    select jsonb_agg(jsonb_build_object('starts_at', b.starts_at, 'ends_at', b.ends_at) order by b.starts_at)
      from venue_bookings b
     where b.venue_id = p_venue and (b.status = 'confirmed' or (b.status = 'tentative' and b.hold_expires_at > now()))
       and b.starts_at < (p_to + 1)::timestamp and b.ends_at > p_from::timestamp), '[]'::jsonb));
end $$;
revoke all on function guest_venue_busy(text, uuid, date, date) from public, anon, authenticated;
grant execute on function guest_venue_busy(text, uuid, date, date) to service_role;

create function guest_venue_booking(p_booking uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare b venue_bookings%rowtype; v_paid bigint; v_due bigint; v_live boolean;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into b from venue_bookings where id = p_booking;
  if not found or b.source <> 'website' then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_paid := venue_booking_paid(b.id);
  v_live := b.status = 'tentative' and b.hold_expires_at > now();
  v_due := case when v_live then greatest(b.deposit_minor - v_paid, 0)
                when b.status = 'confirmed' then greatest(b.total_minor - v_paid, 0) else 0 end;
  return jsonb_build_object(
    'reference', b.reference, 'status', case when b.status = 'tentative' and not v_live then 'expired' else b.status end,
    'venue', (select name from hotel_venues where id = b.venue_id), 'hotel', (select name from properties where id = b.property_id),
    'event_type', b.event_type, 'title', b.title, 'starts_at', b.starts_at, 'ends_at', b.ends_at, 'attendees', b.attendees, 'contact_name', b.contact_name,
    'currency', b.currency, 'subtotal_minor', b.subtotal_minor, 'service_minor', b.service_minor, 'tax_minor', b.tax_minor, 'total_minor', b.total_minor,
    'deposit_minor', b.deposit_minor, 'paid_minor', v_paid, 'due_minor', v_due, 'hold_expires_at', case when v_live then b.hold_expires_at end,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('description', l.description, 'quantity', l.quantity, 'unit_amount_minor', l.unit_amount_minor,
                                                           'line_total_minor', l.line_total_minor) order by l.sort_order, l.id)
                         from venue_booking_lines l where l.booking_id = b.id), '[]'::jsonb));
end $$;
revoke all on function guest_venue_booking(uuid) from public, anon, authenticated;
grant execute on function guest_venue_booking(uuid) to service_role;

create function guest_events(p_host text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_property uuid; v_currency char(3); v_now timestamp;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  select currency into v_currency from properties where id = v_property;
  v_now := property_local_now(v_property);
  return jsonb_build_object('currency', v_currency, 'events', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', e.id, 'title', e.title, 'body', e.body, 'starts_at', e.starts_at, 'ends_at', e.ends_at, 'max_per_order', e.max_per_order,
             'venue', (select name from hotel_venues where id = e.venue_id),
             'ticket_types', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'price_minor', t.price_minor,
                                                                            'remaining', greatest(t.quantity_total - ticket_type_taken(t.id), 0))
                                                        order by t.sort_order, t.created_at)
                                         from event_ticket_types t where t.event_id = e.id and t.is_active), '[]'::jsonb))
           order by e.starts_at)
      from hotel_events e
     where e.property_id = v_property and e.status = 'on_sale' and e.ends_at > v_now and (e.sales_close_at is null or e.sales_close_at > v_now)), '[]'::jsonb));
end $$;
revoke all on function guest_events(text) from public, anon, authenticated;
grant execute on function guest_events(text) to service_role;

create function guest_ticket_order(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o ticket_orders%rowtype; ev hotel_events%rowtype; v_live boolean; v_paid bigint;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select * into o from ticket_orders where id = p_order;
  if not found or o.source <> 'website' then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into ev from hotel_events where id = o.event_id;
  v_live := o.status = 'pending' and o.hold_expires_at > now();
  v_paid := ticket_order_paid(o.id);
  return jsonb_build_object(
    'reference', o.reference, 'status', case when o.status = 'pending' and not v_live then 'expired' else o.status end,
    'hotel', (select name from properties where id = o.property_id), 'event', ev.title, 'event_status', ev.status,
    'starts_at', ev.starts_at, 'ends_at', ev.ends_at, 'venue', (select name from hotel_venues where id = ev.venue_id),
    'buyer_name', o.buyer_name, 'currency', o.currency, 'total_minor', o.total_minor, 'paid_minor', v_paid,
    'due_minor', case when v_live then greatest(o.total_minor - v_paid, 0) else 0 end, 'hold_expires_at', case when v_live then o.hold_expires_at end,
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.name_at_order, 'quantity', i.quantity, 'unit_price_minor', i.unit_price_minor) order by i.id)
                         from ticket_order_items i where i.order_id = o.id), '[]'::jsonb),
    'tickets', coalesce((select jsonb_agg(jsonb_build_object('code', t.code, 'status', t.status,
                                                             'type', (select name from event_ticket_types where id = t.ticket_type_id)) order by t.created_at, t.id)
                           from tickets t where t.order_id = o.id), '[]'::jsonb));
end $$;
revoke all on function guest_ticket_order(uuid) from public, anon, authenticated;
grant execute on function guest_ticket_order(uuid) to service_role;

-- ---- writing, for the website -----------------------------------------------------------------------------
create function guest_request_venue(
  p_host text, p_venue uuid, p_starts timestamp, p_ends timestamp, p_event_type text, p_title text, p_name text, p_email text, p_phone text,
  p_attendees integer, p_note text, p_mode text, p_key text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_property uuid; v_prop properties%rowtype; v_venue hotel_venues%rowtype; v_idem record; v_hash text; v_id uuid; v_ref text; v_t jsonb; v_amt jsonb; v_result jsonb;
  v_name text := btrim(coalesce(p_name, '')); v_email text := nullif(btrim(coalesce(p_email, '')), ''); v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_title text := btrim(coalesce(p_title, '')); v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_type text := coalesce(nullif(btrim(coalesce(p_event_type, '')), ''), 'other');
  v_now timestamp; v_lead interval;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  select * into v_prop from properties where id = v_property;
  select * into v_venue from hotel_venues where id = p_venue and property_id = v_property and is_active;
  if not found then raise exception 'NOT_FOUND: venue' using errcode = 'P0001'; end if;
  if p_mode is null or p_mode not in ('enquiry', 'book') then raise exception 'POLICY_VIOLATION: mode' using errcode = 'P0001'; end if;
  if p_mode = 'book' and not v_venue.bookable_online then raise exception 'POLICY_VIOLATION: not bookable online' using errcode = 'P0001'; end if;
  if v_type not in ('wedding', 'conference', 'meeting', 'birthday', 'party', 'other') then raise exception 'POLICY_VIOLATION: event type' using errcode = 'P0001'; end if;
  if length(v_name) not between 1 and 80 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if length(v_title) > 80 then raise exception 'POLICY_VIOLATION: title' using errcode = 'P0001'; end if;
  if v_email is null or not (length(v_email) <= 120 and v_email ~ '^[^@ ]+@[^@ ]+\.[^@ ]+$') then raise exception 'POLICY_VIOLATION: email' using errcode = 'P0001'; end if;
  if v_phone is not null and length(v_phone) not between 5 and 40 then raise exception 'POLICY_VIOLATION: phone' using errcode = 'P0001'; end if;
  if v_note is not null and length(v_note) > 500 then raise exception 'POLICY_VIOLATION: note' using errcode = 'P0001'; end if;
  if p_starts is null or p_ends is null or p_starts >= p_ends or p_ends > p_starts + interval '14 days' then raise exception 'POLICY_VIOLATION: times' using errcode = 'P0001'; end if;
  v_now := property_local_now(v_property);
  v_lead := case when p_mode = 'book' then interval '48 hours' else interval '0' end;
  if p_starts <= v_now + v_lead then raise exception 'POLICY_VIOLATION: too soon' using errcode = 'P0001'; end if;
  if p_starts > v_now + interval '540 days' then raise exception 'POLICY_VIOLATION: too far' using errcode = 'P0001'; end if;
  if p_attendees is null or p_attendees < 1 or p_attendees > v_venue.capacity then raise exception 'POLICY_VIOLATION: attendees' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', v_property, p_venue, p_starts, p_ends, v_type, v_name, v_email, coalesce(v_phone, ''), p_attendees, p_mode));
  select * into v_idem from idem_begin(v_prop.tenant_id, 'guest_request_venue', p_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  if (select count(*) from venue_bookings where property_id = v_property and source = 'website' and lower(contact_email) = lower(v_email)
         and (status = 'enquiry' or (status = 'tentative' and hold_expires_at > now()))) >= 3 then
    raise exception 'POLICY_VIOLATION: too many open' using errcode = 'P0001';
  end if;

  v_t := event_terms(v_property);
  v_ref := venue_booking_new_reference(v_property);
  insert into venue_bookings (tenant_id, property_id, venue_id, reference, status, source, event_type, title, contact_name, contact_email, contact_phone,
                              attendees, starts_at, ends_at, note, currency, tax_percent, service_percent, deposit_percent)
  values (v_prop.tenant_id, v_property, p_venue, v_ref, 'enquiry', 'website', v_type, v_title, v_name, v_email, v_phone, p_attendees, p_starts, p_ends, v_note,
          v_prop.currency, (v_t ->> 'tax_percent')::numeric, (v_t ->> 'service_percent')::numeric, (v_t ->> 'deposit_percent')::integer)
  returning id into v_id;

  if p_mode = 'book' then
    v_amt := venue_hire_amount(p_venue, p_starts, p_ends);
    insert into venue_booking_lines (tenant_id, property_id, booking_id, kind, description, quantity, unit_amount_minor)
    values (v_prop.tenant_id, v_property, v_id, 'venue', left('Hire of ' || v_venue.name || ', ' || (v_amt ->> 'hours') || ' hours', 120), 1, (v_amt ->> 'amount_minor')::bigint);
    perform venue_booking_recalc(v_id);
    perform venue_booking_hold_internal(v_id, (v_t ->> 'hold_hours')::integer);
  end if;

  v_result := jsonb_build_object('booking_id', v_id, 'reference', v_ref, 'status', (select status from venue_bookings where id = v_id));
  perform idem_finish(v_prop.tenant_id, 'guest_request_venue', p_key, v_result);
  perform write_audit(v_prop.tenant_id, v_property, null, 'venue_booking.requested', 'venue_booking', v_id, p_key,
                      jsonb_build_object('reference', v_ref, 'venue', v_venue.name, 'mode', p_mode, 'status', v_result ->> 'status'));
  return v_result;
end $$;
revoke all on function guest_request_venue(text, uuid, timestamp, timestamp, text, text, text, text, text, integer, text, text, text) from public, anon, authenticated;
grant execute on function guest_request_venue(text, uuid, timestamp, timestamp, text, text, text, text, text, integer, text, text, text) to service_role;

create function guest_create_ticket_order(p_host text, p_event uuid, p_items jsonb, p_name text, p_email text, p_phone text, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_property uuid; v_prop properties%rowtype; v_idem record; v_hash text; v_order uuid; o ticket_orders%rowtype; v_result jsonb;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  select h.property_id into v_property from resolve_host(p_host) h;
  select * into v_prop from properties where id = v_property;
  if not exists (select 1 from hotel_events where id = p_event and property_id = v_property) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if nullif(btrim(coalesce(p_email, '')), '') is null then raise exception 'POLICY_VIOLATION: email' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', p_event, p_items::text, coalesce(p_name, ''), coalesce(p_email, ''), coalesce(p_phone, '')));
  select * into v_idem from idem_begin(v_prop.tenant_id, 'guest_create_ticket_order', p_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  if (select count(*) from ticket_orders where property_id = v_property and source = 'website' and lower(buyer_email) = lower(btrim(p_email))
         and status = 'pending' and hold_expires_at > now()) >= 3 then
    raise exception 'POLICY_VIOLATION: too many open' using errcode = 'P0001';
  end if;

  v_order := ticket_order_create_internal(p_event, p_items, p_name, p_email, p_phone, 'website', null);
  select * into o from ticket_orders where id = v_order;
  v_result := jsonb_build_object('order_id', v_order, 'reference', o.reference, 'status', o.status, 'total_minor', o.total_minor);
  perform idem_finish(v_prop.tenant_id, 'guest_create_ticket_order', p_key, v_result);
  perform write_audit(v_prop.tenant_id, v_property, null, 'ticket_order.created', 'ticket_order', v_order, p_key,
                      jsonb_build_object('reference', o.reference, 'total_minor', o.total_minor, 'status', o.status));
  return v_result;
end $$;
revoke all on function guest_create_ticket_order(text, uuid, jsonb, text, text, text, text) from public, anon, authenticated;
grant execute on function guest_create_ticket_order(text, uuid, jsonb, text, text, text, text) to service_role;

-- ---- Paystack ---------------------------------------------------------------------------------------------
-- What the server needs to open a checkout for a venue booking or a ticket order: the account, the payer's email and the code to show.
create function event_payment_start_context(p_kind text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid; v_email text; v_ref text; a record;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if p_kind = 'booking' then select tenant_id, contact_email, reference into v_tenant, v_email, v_ref from venue_bookings where id = p_id and source = 'website';
  elsif p_kind = 'ticket_order' then select tenant_id, buyer_email, reference into v_tenant, v_email, v_ref from ticket_orders where id = p_id and source = 'website';
  else raise exception 'POLICY_VIOLATION: kind' using errcode = 'P0001'; end if;
  if v_tenant is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select id, secret_reference, mode into a from payment_provider_accounts
   where tenant_id = v_tenant and provider = 'paystack' and status = 'active' and secret_reference is not null order by (mode = 'live') desc limit 1;
  if not found then raise exception 'INVALID_STATE: no payment provider configured' using errcode = 'P0001'; end if;
  if v_email is null then raise exception 'INVALID_STATE: email missing' using errcode = 'P0001'; end if;
  return jsonb_build_object('account_id', a.id, 'secret_reference', a.secret_reference, 'mode', a.mode, 'payer_email', v_email, 'reference', v_ref);
end $$;
revoke all on function event_payment_start_context(text, uuid) from public, anon, authenticated;
grant execute on function event_payment_start_context(text, uuid) to service_role;

create function create_event_payment_attempt(p_kind text, p_id uuid, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b venue_bookings%rowtype; o ticket_orders%rowtype; v_tenant uuid; v_prop uuid; v_currency char(3); v_amount bigint; v_paid bigint;
  v_idem record; v_hash text; v_ref text; v_id uuid := gen_random_uuid(); v_result jsonb;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if p_kind = 'booking' then
    select * into b from venue_bookings where id = p_id and source = 'website';
    if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
    v_tenant := b.tenant_id; v_prop := b.property_id; v_currency := b.currency;
  elsif p_kind = 'ticket_order' then
    select * into o from ticket_orders where id = p_id and source = 'website';
    if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
    v_tenant := o.tenant_id; v_prop := o.property_id; v_currency := o.currency;
  else raise exception 'POLICY_VIOLATION: kind' using errcode = 'P0001'; end if;

  v_hash := md5(p_kind || ':' || p_id::text);
  select * into v_idem from idem_begin(v_tenant, 'create_event_payment_attempt', p_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;
  if not exists (select 1 from payment_provider_accounts where tenant_id = v_tenant and provider = 'paystack' and status = 'active') then
    raise exception 'INVALID_STATE: no payment provider configured' using errcode = 'P0001';
  end if;

  if p_kind = 'booking' then
    select * into b from venue_bookings where id = p_id for update;
    v_paid := venue_booking_paid(b.id);
    if b.status = 'tentative' and b.hold_expires_at > now() then v_amount := b.deposit_minor - v_paid;
    elsif b.status = 'confirmed' then v_amount := b.total_minor - v_paid;
    elsif b.status = 'tentative' then raise exception 'INVALID_STATE: hold lapsed' using errcode = 'P0001';
    else raise exception 'INVALID_STATE: %', b.status using errcode = 'P0001'; end if;
  else
    select * into o from ticket_orders where id = p_id for update;
    if o.status <> 'pending' or o.hold_expires_at <= now() then raise exception 'INVALID_STATE: hold lapsed' using errcode = 'P0001'; end if;
    v_paid := ticket_order_paid(o.id);
    v_amount := o.total_minor - v_paid;
  end if;
  if v_amount <= 0 then raise exception 'INVALID_STATE: nothing due' using errcode = 'P0001'; end if;

  loop
    v_ref := 'EVT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16));
    exit when not exists (select 1 from event_payment_attempts where provider = 'paystack' and reference = v_ref);
  end loop;
  insert into event_payment_attempts (id, tenant_id, property_id, venue_booking_id, ticket_order_id, provider, reference, amount_minor, currency)
  values (v_id, v_tenant, v_prop, case when p_kind = 'booking' then p_id end, case when p_kind = 'ticket_order' then p_id end, 'paystack', v_ref, v_amount, v_currency);

  v_result := jsonb_build_object('attempt_id', v_id, 'reference', v_ref, 'amount_minor', v_amount, 'currency', v_currency);
  perform idem_finish(v_tenant, 'create_event_payment_attempt', p_key, v_result);
  perform write_audit(v_tenant, v_prop, null, 'event_payment_attempt.created', 'event_payment_attempt', v_id, p_key,
                      jsonb_build_object('kind', p_kind, 'target_id', p_id, 'amount_minor', v_amount));
  return v_result;
end $$;
revoke all on function create_event_payment_attempt(text, uuid, text) from public, anon, authenticated;
grant execute on function create_event_payment_attempt(text, uuid, text) to service_role;

-- The payment half of the webhook for EVT- references. It follows confirm_payment (011): log the event, find the attempt for this
-- hotel's own account, check amount and currency, record the money first, then let the booking or order follow.
create function confirm_event_payment(
  p_provider text, p_event_id text, p_event_type text, p_reference text, p_status text,
  p_amount_minor bigint, p_currency text, p_channel text, p_payload jsonb default '{}'::jsonb, p_tenant_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a event_payment_attempts%rowtype; v_event uuid; v_prior jsonb; v_result jsonb; v_ev_status text := 'processed'; v_summary text;
  v_paid bigint; v_total bigint; v_pay uuid := gen_random_uuid(); v_ref text; v_method text; v_after text;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if p_provider is null or p_event_id is null or length(p_event_id) = 0 or p_reference is null or length(p_reference) = 0 then
    raise exception 'POLICY_VIOLATION: provider, event id and reference required' using errcode = 'P0001';
  end if;
  if p_status is null or p_status not in ('success', 'failed', 'abandoned') then raise exception 'POLICY_VIOLATION: status' using errcode = 'P0001'; end if;

  insert into payment_events (provider, provider_event_id, event_type, provider_reference, payload)
  values (p_provider, p_event_id, p_event_type, p_reference, coalesce(p_payload, '{}'::jsonb))
  on conflict (provider, provider_event_id) do nothing returning id into v_event;
  if v_event is null then
    select result into v_prior from payment_events where provider = p_provider and provider_event_id = p_event_id;
    return coalesce(v_prior, '{}'::jsonb) || jsonb_build_object('duplicate', true);
  end if;

  select * into a from event_payment_attempts where provider = p_provider and reference = p_reference and (p_tenant_id is null or tenant_id = p_tenant_id) for update;
  if not found then
    v_result := jsonb_build_object('result', 'ignored', 'reason', 'unknown reference');
    update payment_events set processing_status = 'ignored', result = v_result, processed_at = now(), error_summary = 'unknown reference' where id = v_event;
    return v_result;
  end if;
  update payment_events set tenant_id = a.tenant_id where id = v_event;

  if a.status = 'succeeded' then
    v_result := jsonb_build_object('result', 'already_processed'); v_ev_status := 'ignored';
  elsif a.status = 'needs_attention' then
    v_result := jsonb_build_object('result', 'ignored', 'reason', 'attempt needs attention'); v_ev_status := 'ignored';
  elsif p_status <> 'success' then
    update event_payment_attempts set status = case p_status when 'failed' then 'failed' else 'abandoned' end, completed_at = now() where id = a.id;
    v_result := jsonb_build_object('result', p_status);
  else
    if a.venue_booking_id is not null then
      perform 1 from venue_bookings where id = a.venue_booking_id for update;
      v_paid := venue_booking_paid(a.venue_booking_id); select total_minor into v_total from venue_bookings where id = a.venue_booking_id;
    else
      perform 1 from ticket_orders where id = a.ticket_order_id for update;
      v_paid := ticket_order_paid(a.ticket_order_id); select total_minor into v_total from ticket_orders where id = a.ticket_order_id;
    end if;
    if p_amount_minor is distinct from a.amount_minor or upper(coalesce(p_currency, '')) <> a.currency then v_summary := 'amount_or_currency_mismatch';
    elsif v_paid + a.amount_minor > v_total then v_summary := 'overpayment'; end if;

    if v_summary is not null then
      update event_payment_attempts set status = 'needs_attention', failure_reason = v_summary, completed_at = now() where id = a.id;
      if a.venue_booking_id is not null then update venue_bookings set attention_reason = 'payment_' || v_summary where id = a.venue_booking_id;
      else update ticket_orders set attention_reason = 'payment_' || v_summary where id = a.ticket_order_id; end if;
      v_result := jsonb_build_object('result', 'mismatch', 'reason', v_summary);
      v_ev_status := 'mismatch';
    else
      loop
        v_ref := 'EVP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
        exit when not exists (select 1 from event_payments where tenant_id = a.tenant_id and internal_reference = v_ref);
      end loop;
      v_method := case when lower(coalesce(p_channel, '')) in ('card', 'bank', 'ussd', 'qr', 'mobile_money', 'eft', 'bank_transfer') then lower(p_channel) else 'other' end;
      insert into event_payments (id, tenant_id, property_id, venue_booking_id, ticket_order_id, payment_kind, payment_provider, payment_method,
                                  provider_reference, internal_reference, amount_minor, currency, attempt_id)
      values (v_pay, a.tenant_id, a.property_id, a.venue_booking_id, a.ticket_order_id, 'payment', p_provider, v_method, p_reference, v_ref, a.amount_minor, a.currency, a.id);
      update event_payment_attempts set status = 'succeeded', completed_at = now() where id = a.id;
      v_after := case when a.venue_booking_id is not null then venue_booking_after_payment(a.venue_booking_id) else ticket_order_after_payment(a.ticket_order_id) end;
      v_result := jsonb_build_object('result', case v_after when 'confirmed' then 'confirmed' when 'paid' then 'confirmed' when 'slot_lost' then 'recorded_slot_lost'
                                                      when 'expired' then 'recorded_after_expiry' when 'cancelled' then 'recorded_after_cancel' else 'recorded' end,
                                     'payment_id', v_pay, 'amount_minor', a.amount_minor, 'status', v_after);
      perform write_audit(a.tenant_id, a.property_id, null, 'event_payment.confirmed', 'event_payment', v_pay, p_event_id,
                          jsonb_build_object('venue_booking_id', a.venue_booking_id, 'ticket_order_id', a.ticket_order_id, 'amount_minor', a.amount_minor, 'status', v_after));
    end if;
  end if;
  update payment_events set processing_status = v_ev_status, result = v_result, processed_at = now(), error_summary = v_summary where id = v_event;
  return v_result;
end $$;
revoke all on function confirm_event_payment(text, text, text, text, text, bigint, text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function confirm_event_payment(text, text, text, text, text, bigint, text, text, jsonb, uuid) to service_role;

-- The router. The room-booking function keeps its code and gets a new name; the old name now picks by reference.
alter function confirm_payment(text, text, text, text, text, bigint, text, text, jsonb, uuid) rename to confirm_reservation_payment;
revoke all on function confirm_reservation_payment(text, text, text, text, text, bigint, text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function confirm_reservation_payment(text, text, text, text, text, bigint, text, text, jsonb, uuid) to service_role;

create function confirm_payment(
  p_provider text, p_event_id text, p_event_type text, p_reference text, p_status text,
  p_amount_minor bigint, p_currency text, p_channel text, p_payload jsonb default '{}'::jsonb, p_tenant_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if p_reference like 'EVT-%' then
    return confirm_event_payment(p_provider, p_event_id, p_event_type, p_reference, p_status, p_amount_minor, p_currency, p_channel, p_payload, p_tenant_id);
  end if;
  return confirm_reservation_payment(p_provider, p_event_id, p_event_type, p_reference, p_status, p_amount_minor, p_currency, p_channel, p_payload, p_tenant_id);
end $$;
revoke all on function confirm_payment(text, text, text, text, text, bigint, text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function confirm_payment(text, text, text, text, text, bigint, text, text, jsonb, uuid) to service_role;
