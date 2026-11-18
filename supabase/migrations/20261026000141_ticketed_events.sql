-- 141 Events, part 2: ticketed events the hotel puts on (live music, a brunch, a party night). Guests buy tickets online (142) or staff
-- sell them at the desk here; each paid ticket has a code that staff check at the door.
--
-- An event has a title, a start and an end (the hotel's local time), up to 8 ticket types (name, price, how many), and optionally a
-- venue. Giving an event a venue makes it hold that venue's slot, through a confirmed venue booking of source 'ticketed_event' (140), so
-- the venue calendar and its double-booking rule cover ticketed events too. Changing the venue or the time moves that booking; a clash
-- answers VENUE_UNAVAILABLE and changes nothing.
--
-- Event status: draft (not shown, nothing sold) | on_sale | closed (no more sales, tickets still work) | cancelled (terminal: its venue slot is
-- freed, unpaid orders are cancelled, tickets are voided; money taken stays on the orders and a person with refund.approve returns it).
--
-- Orders. An order is one buyer and 1 to 5 ticket types, at most max_per_order tickets in all. It is pending for 20 minutes (the
-- hold), then paid (all of its price is in) or expired/cancelled. Tickets count against a type while their order is paid, or pending and
-- inside its hold; the event row is locked while an order is made, so two buyers cannot take the last ticket together. A free
-- order (total 0) is paid at once. Prices are copied onto the order, so a later price change never alters it.
--
-- Staff sell at the desk with staff_sell_tickets (event.manage and payment.record): the order and the manual payment are one step.

create table hotel_events (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  property_id      uuid not null,
  title            text not null check (length(btrim(title)) between 1 and 80),
  body             text not null default '' check (length(body) <= 500),
  venue_id         uuid,
  venue_booking_id uuid,
  starts_at        timestamp not null,
  ends_at          timestamp not null,
  status           text not null default 'draft' check (status in ('draft', 'on_sale', 'closed', 'cancelled')),
  sales_close_at   timestamp,
  max_per_order    integer not null default 10 check (max_per_order between 1 and 50),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  foreign key (tenant_id, property_id, venue_id) references hotel_venues (tenant_id, property_id, id),
  foreign key (tenant_id, property_id, venue_booking_id) references venue_bookings (tenant_id, property_id, id),
  unique (tenant_id, property_id, id),
  check (starts_at < ends_at and ends_at <= starts_at + interval '14 days'),
  check (sales_close_at is null or sales_close_at <= ends_at),
  check ((venue_id is null) = (venue_booking_id is null))
);
create index hotel_events_property_idx on hotel_events (property_id, starts_at);
create trigger hotel_events_updated before update on hotel_events for each row execute function set_updated_at();
alter table hotel_events enable row level security;
create policy hotel_events_select on hotel_events for select to authenticated using (has_permission(property_id, 'event.view'));
revoke insert, update, delete on hotel_events from authenticated, anon;

create table event_ticket_types (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  property_id    uuid not null,
  event_id       uuid not null,
  name           text not null check (length(btrim(name)) between 1 and 40),
  price_minor    bigint not null check (price_minor between 0 and 1000000000),
  quantity_total integer not null check (quantity_total between 1 and 100000),
  is_active      boolean not null default true,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (tenant_id, property_id, event_id) references hotel_events (tenant_id, property_id, id),
  unique (tenant_id, property_id, id)
);
create unique index event_ticket_types_name_idx on event_ticket_types (event_id, lower(name));
alter table event_ticket_types enable row level security;
create policy event_ticket_types_select on event_ticket_types for select to authenticated using (has_permission(property_id, 'event.view'));
revoke insert, update, delete on event_ticket_types from authenticated, anon;

create table ticket_orders (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  property_id      uuid not null,
  event_id         uuid not null,
  reference        text not null,
  status           text not null default 'pending' check (status in ('pending', 'paid', 'cancelled', 'expired')),
  source           text not null default 'website' check (source in ('website', 'staff')),
  buyer_name       text not null check (length(btrim(buyer_name)) between 1 and 80),
  buyer_email      text check (buyer_email is null or (length(buyer_email) <= 120 and buyer_email ~ '^[^@ ]+@[^@ ]+\.[^@ ]+$')),
  buyer_phone      text check (buyer_phone is null or length(buyer_phone) between 5 and 40),
  total_minor      bigint not null check (total_minor >= 0),
  currency         char(3) not null,
  hold_expires_at  timestamptz,
  attention_reason text,
  cancel_reason    text check (cancel_reason is null or length(cancel_reason) <= 200),
  paid_at          timestamptz,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (tenant_id, property_id, event_id) references hotel_events (tenant_id, property_id, id),
  unique (tenant_id, property_id, id),
  unique (property_id, reference),
  check (status <> 'pending' or hold_expires_at is not null),
  check ((status = 'paid') = (paid_at is not null) or status in ('cancelled', 'expired'))
);
create index ticket_orders_event_idx on ticket_orders (event_id, status);
create trigger ticket_orders_updated before update on ticket_orders for each row execute function set_updated_at();
alter table ticket_orders enable row level security;
create policy ticket_orders_select on ticket_orders for select to authenticated using (has_permission(property_id, 'event.view'));
revoke insert, update, delete on ticket_orders from authenticated, anon;

create table ticket_order_items (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  property_id      uuid not null,
  order_id         uuid not null,
  ticket_type_id   uuid not null,
  quantity         integer not null check (quantity between 1 and 50),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  name_at_order    text not null,
  foreign key (tenant_id, property_id, order_id) references ticket_orders (tenant_id, property_id, id),
  foreign key (tenant_id, property_id, ticket_type_id) references event_ticket_types (tenant_id, property_id, id)
);
create index ticket_order_items_order_idx on ticket_order_items (order_id);
create index ticket_order_items_type_idx on ticket_order_items (ticket_type_id);
alter table ticket_order_items enable row level security;
create policy ticket_order_items_select on ticket_order_items for select to authenticated using (has_permission(property_id, 'event.view'));
revoke insert, update, delete on ticket_order_items from authenticated, anon;

create table tickets (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  property_id    uuid not null,
  event_id       uuid not null,
  order_id       uuid not null,
  ticket_type_id uuid not null,
  code           text not null check (code ~ '^T[0-9A-F]{9}$'),
  status         text not null default 'valid' check (status in ('valid', 'used', 'void')),
  used_at        timestamptz,
  used_by        uuid,
  created_at     timestamptz not null default now(),
  foreign key (tenant_id, property_id, event_id) references hotel_events (tenant_id, property_id, id),
  foreign key (tenant_id, property_id, order_id) references ticket_orders (tenant_id, property_id, id),
  foreign key (tenant_id, property_id, ticket_type_id) references event_ticket_types (tenant_id, property_id, id),
  unique (property_id, code),
  check ((status = 'used') = (used_at is not null))
);
create index tickets_order_idx on tickets (order_id);
create index tickets_event_idx on tickets (event_id, status);
alter table tickets enable row level security;
create policy tickets_select on tickets for select to authenticated using (has_permission(property_id, 'event.view'));
revoke insert, update, delete on tickets from authenticated, anon;

-- The ticket-order side of the shared money ledger (140).
alter table event_payments add foreign key (tenant_id, property_id, ticket_order_id) references ticket_orders (tenant_id, property_id, id);

-- ---- internal helpers -----------------------------------------------------------------------------
create function ticket_order_paid(p_order uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(case payment_kind when 'payment' then amount_minor else -amount_minor end), 0)::bigint
    from event_payments where ticket_order_id = p_order
$$;
revoke all on function ticket_order_paid(uuid) from public, anon, authenticated;

-- Tickets of a type that are spoken for: on a paid order, or on a pending one still inside its hold.
create function ticket_type_taken(p_type uuid) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(sum(i.quantity), 0)::integer
    from ticket_order_items i join ticket_orders o on o.id = i.order_id
   where i.ticket_type_id = p_type and (o.status = 'paid' or (o.status = 'pending' and o.hold_expires_at > now()))
$$;
revoke all on function ticket_type_taken(uuid) from public, anon, authenticated;

create function issue_tickets(p_order uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare o ticket_orders%rowtype; it record; i integer; v_n integer := 0; v_code text;
begin
  select * into o from ticket_orders where id = p_order;
  if exists (select 1 from tickets where order_id = p_order) then return 0; end if;
  for it in select ticket_type_id, quantity from ticket_order_items where order_id = p_order order by id loop
    for i in 1..it.quantity loop
      loop
        v_code := 'T' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 9));
        begin
          insert into tickets (tenant_id, property_id, event_id, order_id, ticket_type_id, code)
          values (o.tenant_id, o.property_id, o.event_id, o.id, it.ticket_type_id, v_code);
          exit;
        exception when unique_violation then continue;
        end;
      end loop;
      v_n := v_n + 1;
    end loop;
  end loop;
  return v_n;
end $$;
revoke all on function issue_tickets(uuid) from public, anon, authenticated;

-- After money moves on an order: paid in full makes it paid and issues its tickets. An order that lapsed while the buyer paid takes its
-- tickets back when there are still enough; otherwise the money is on the order, flagged for a person (paid_after_expiry).
create function ticket_order_after_payment(p_order uuid) returns text
language plpgsql security definer set search_path = public as $$
declare o ticket_orders%rowtype; v_paid bigint; it record; ev hotel_events%rowtype; v_ok boolean := true;
begin
  select * into o from ticket_orders where id = p_order for update;
  v_paid := ticket_order_paid(p_order);
  if v_paid < o.total_minor then return o.status; end if;
  if o.status = 'pending' then
    update ticket_orders set status = 'paid', paid_at = now(), hold_expires_at = null where id = o.id;
    perform issue_tickets(o.id);
    return 'paid';
  elsif o.status = 'expired' then
    select * into ev from hotel_events where id = o.event_id for update;
    if ev.status <> 'on_sale' and ev.status <> 'closed' then v_ok := false; end if;
    for it in select i.ticket_type_id, i.quantity, t.quantity_total from ticket_order_items i join event_ticket_types t on t.id = i.ticket_type_id where i.order_id = o.id loop
      if ticket_type_taken(it.ticket_type_id) + it.quantity > it.quantity_total then v_ok := false; end if;
    end loop;
    if v_ok then
      update ticket_orders set status = 'paid', paid_at = now(), hold_expires_at = null, attention_reason = null where id = o.id;
      perform issue_tickets(o.id);
      return 'paid';
    end if;
    update ticket_orders set attention_reason = 'paid_after_expiry' where id = o.id;
    return 'expired';
  elsif o.status = 'cancelled' then
    update ticket_orders set attention_reason = 'paid_after_cancel' where id = o.id;
  end if;
  return o.status;
end $$;
revoke all on function ticket_order_after_payment(uuid) from public, anon, authenticated;

-- Makes one order. The caller has checked who may. Returns the order id.
create function ticket_order_create_internal(p_event uuid, p_items jsonb, p_name text, p_email text, p_phone text, p_source text, p_actor uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  ev hotel_events%rowtype; v_prop properties%rowtype; v_id uuid := gen_random_uuid(); v_ref text; v_total bigint := 0; v_count integer := 0; v_n integer := 0;
  it jsonb; v_type event_ticket_types%rowtype; v_qty integer; v_seen uuid[] := '{}'; v_now timestamp;
  v_name text := btrim(coalesce(p_name, '')); v_email text := nullif(btrim(coalesce(p_email, '')), ''); v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
begin
  select * into ev from hotel_events where id = p_event for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into v_prop from properties where id = ev.property_id;
  v_now := property_local_now(ev.property_id);
  if ev.status <> 'on_sale' or ev.ends_at <= v_now or (ev.sales_close_at is not null and ev.sales_close_at <= v_now) then
    raise exception 'INVALID_STATE: not on sale' using errcode = 'P0001';
  end if;
  if length(v_name) not between 1 and 80 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if v_email is not null and not (length(v_email) <= 120 and v_email ~ '^[^@ ]+@[^@ ]+\.[^@ ]+$') then raise exception 'POLICY_VIOLATION: email' using errcode = 'P0001'; end if;
  if v_phone is not null and length(v_phone) not between 5 and 40 then raise exception 'POLICY_VIOLATION: phone' using errcode = 'P0001'; end if;
  if v_email is null and v_phone is null then raise exception 'POLICY_VIOLATION: contact' using errcode = 'P0001'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 5 then raise exception 'POLICY_VIOLATION: items' using errcode = 'P0001'; end if;

  loop
    v_ref := 'TKT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists (select 1 from ticket_orders where property_id = ev.property_id and reference = v_ref);
  end loop;
  insert into ticket_orders (id, tenant_id, property_id, event_id, reference, status, source, buyer_name, buyer_email, buyer_phone, total_minor, currency, hold_expires_at, created_by)
  values (v_id, ev.tenant_id, ev.property_id, ev.id, v_ref, 'pending', p_source, v_name, v_email, v_phone, 0, v_prop.currency, now() + interval '20 minutes', p_actor);

  for it in select * from jsonb_array_elements(p_items) loop
    if (it ->> 'ticket_type_id') is null or (it ->> 'ticket_type_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'POLICY_VIOLATION: items' using errcode = 'P0001'; end if;
    if (it ->> 'quantity') is null or (it ->> 'quantity') !~ '^\d{1,2}$' or (it ->> 'quantity')::integer not between 1 and 50 then raise exception 'POLICY_VIOLATION: quantity' using errcode = 'P0001'; end if;
    v_qty := (it ->> 'quantity')::integer;
    select * into v_type from event_ticket_types where id = (it ->> 'ticket_type_id')::uuid and event_id = ev.id and is_active;
    if not found then raise exception 'NOT_FOUND: ticket type' using errcode = 'P0001'; end if;
    if v_type.id = any(v_seen) then raise exception 'POLICY_VIOLATION: items' using errcode = 'P0001'; end if;
    v_seen := v_seen || v_type.id;
    v_count := v_count + v_qty;
    if v_count > ev.max_per_order then raise exception 'POLICY_VIOLATION: too many tickets' using errcode = 'P0001'; end if;
    if ticket_type_taken(v_type.id) + v_qty > v_type.quantity_total then raise exception 'SOLD_OUT' using errcode = 'P0001'; end if;
    insert into ticket_order_items (tenant_id, property_id, order_id, ticket_type_id, quantity, unit_price_minor, name_at_order)
    values (ev.tenant_id, ev.property_id, v_id, v_type.id, v_qty, v_type.price_minor, v_type.name);
    v_total := v_total + v_qty * v_type.price_minor;
    v_n := v_n + 1;
  end loop;
  update ticket_orders set total_minor = v_total where id = v_id;
  if v_total = 0 then   -- a free order needs no payment
    update ticket_orders set status = 'paid', paid_at = now(), hold_expires_at = null where id = v_id;
    perform issue_tickets(v_id);
  end if;
  return v_id;
end $$;
revoke all on function ticket_order_create_internal(uuid, jsonb, text, text, text, text, uuid) from public, anon, authenticated;

-- ---- staff: events ------------------------------------------------------------------------------------
-- Creates (p_event null) or edits an event, and moves its venue slot with it.
create function save_hotel_event(p_property uuid, p_event uuid, p_title text, p_body text, p_venue uuid, p_starts timestamp, p_ends timestamp,
                                 p_max_per_order integer, p_sales_close timestamp)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prop properties%rowtype; v_actor uuid; v_id uuid; ev hotel_events%rowtype; v_venue hotel_venues%rowtype; v_bk uuid; v_ref text;
  v_title text := btrim(coalesce(p_title, '')); v_body text := btrim(coalesce(p_body, ''));
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'event.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if length(v_title) not between 1 and 80 then raise exception 'POLICY_VIOLATION: title' using errcode = 'P0001'; end if;
  if length(v_body) > 500 then raise exception 'POLICY_VIOLATION: text' using errcode = 'P0001'; end if;
  if p_starts is null or p_ends is null or p_starts >= p_ends or p_ends > p_starts + interval '14 days' then raise exception 'POLICY_VIOLATION: times' using errcode = 'P0001'; end if;
  if p_max_per_order is null or p_max_per_order not between 1 and 50 then raise exception 'POLICY_VIOLATION: max per order' using errcode = 'P0001'; end if;
  if p_sales_close is not null and p_sales_close > p_ends then raise exception 'POLICY_VIOLATION: sales close' using errcode = 'P0001'; end if;
  if p_venue is not null then
    select * into v_venue from hotel_venues where id = p_venue and property_id = p_property and is_active;
    if not found then raise exception 'NOT_FOUND: venue' using errcode = 'P0001'; end if;
  end if;

  if p_event is null then
    if p_starts <= property_local_now(p_property) then raise exception 'POLICY_VIOLATION: past' using errcode = 'P0001'; end if;
    if (select count(*) from hotel_events where property_id = p_property and status <> 'cancelled' and ends_at > property_local_now(p_property)) >= 40 then
      raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001';
    end if;
    insert into hotel_events (tenant_id, property_id, title, body, starts_at, ends_at, max_per_order, sales_close_at, created_by)
    values (v_prop.tenant_id, p_property, v_title, v_body, p_starts, p_ends, p_max_per_order, p_sales_close, v_actor)
    returning id into v_id;
  else
    select * into ev from hotel_events where id = p_event and property_id = p_property for update;
    if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
    if ev.status = 'cancelled' then raise exception 'INVALID_STATE: cancelled' using errcode = 'P0001'; end if;
    v_id := ev.id;
    update hotel_events set title = v_title, body = v_body, starts_at = p_starts, ends_at = p_ends, max_per_order = p_max_per_order, sales_close_at = p_sales_close where id = v_id;
  end if;

  select * into ev from hotel_events where id = v_id;
  if p_venue is null and ev.venue_booking_id is not null then   -- the venue is let go
    update venue_bookings set status = 'cancelled', cancel_reason = 'Event no longer uses this venue' where id = ev.venue_booking_id;
    update hotel_events set venue_id = null, venue_booking_id = null where id = v_id;
  elsif p_venue is not null then
    perform release_expired_venue_holds(p_venue);
    begin
      if ev.venue_booking_id is null then
        v_ref := venue_booking_new_reference(p_property);
        insert into venue_bookings (tenant_id, property_id, venue_id, reference, status, source, event_type, title, contact_name, attendees, starts_at, ends_at, currency, created_by)
        values (v_prop.tenant_id, p_property, p_venue, v_ref, 'confirmed', 'ticketed_event', 'ticketed', v_title, left(v_prop.name, 80), v_venue.capacity, p_starts, p_ends, v_prop.currency, v_actor)
        returning id into v_bk;
        update hotel_events set venue_id = p_venue, venue_booking_id = v_bk where id = v_id;
      else
        update venue_bookings set venue_id = p_venue, title = v_title, starts_at = p_starts, ends_at = p_ends, attendees = v_venue.capacity where id = ev.venue_booking_id;
        update hotel_events set venue_id = p_venue where id = v_id;
      end if;
    exception when exclusion_violation then
      raise exception 'VENUE_UNAVAILABLE' using errcode = 'P0001';
    end;
  end if;

  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'hotel_event.saved', 'hotel_event', v_id, null,
                      jsonb_build_object('title', v_title, 'starts_at', p_starts, 'ends_at', p_ends, 'venue', p_venue is not null, 'created', p_event is null));
  return jsonb_build_object('event_id', v_id);
end $$;
revoke all on function save_hotel_event(uuid, uuid, text, text, uuid, timestamp, timestamp, integer, timestamp) from public, anon;
grant execute on function save_hotel_event(uuid, uuid, text, text, uuid, timestamp, timestamp, integer, timestamp) to authenticated;

create function set_hotel_event_status(p_event uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ev hotel_events%rowtype; v_actor uuid; v_voided integer := 0;
begin
  select * into ev from hotel_events where id = p_event;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(ev.property_id, 'event.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_status is null or p_status not in ('draft', 'on_sale', 'closed', 'cancelled') then raise exception 'POLICY_VIOLATION: status' using errcode = 'P0001'; end if;
  select * into ev from hotel_events where id = p_event for update;
  if ev.status = p_status then return jsonb_build_object('status', ev.status); end if;
  if ev.status = 'cancelled' then raise exception 'INVALID_STATE: cancelled' using errcode = 'P0001'; end if;

  if p_status = 'on_sale' then
    if ev.ends_at <= property_local_now(ev.property_id) then raise exception 'POLICY_VIOLATION: past' using errcode = 'P0001'; end if;
    if not exists (select 1 from event_ticket_types where event_id = ev.id and is_active) then raise exception 'INVALID_STATE: no tickets' using errcode = 'P0001'; end if;
  elsif p_status = 'draft' then
    if exists (select 1 from ticket_orders where event_id = ev.id) then raise exception 'INVALID_STATE: has orders' using errcode = 'P0001'; end if;
  elsif p_status = 'cancelled' then
    if ev.venue_booking_id is not null then
      update venue_bookings set status = 'cancelled', cancel_reason = 'Event cancelled' where id = ev.venue_booking_id and status <> 'cancelled';
    end if;
    update ticket_orders set status = 'cancelled', cancel_reason = 'Event cancelled', hold_expires_at = null where event_id = ev.id and status in ('pending', 'expired');
    update tickets set status = 'void' where event_id = ev.id and status = 'valid';
    get diagnostics v_voided = row_count;
  end if;
  update hotel_events set status = p_status where id = ev.id;
  perform write_audit(ev.tenant_id, ev.property_id, v_actor, 'hotel_event.' || p_status, 'hotel_event', ev.id, null,
                      jsonb_build_object('title', ev.title, 'from', ev.status, 'tickets_voided', v_voided));
  return jsonb_build_object('status', p_status);
end $$;
revoke all on function set_hotel_event_status(uuid, text) from public, anon;
grant execute on function set_hotel_event_status(uuid, text) to authenticated;

create function delete_hotel_event(p_event uuid) returns void
language plpgsql security definer set search_path = public as $$
declare ev hotel_events%rowtype; v_actor uuid;
begin
  select * into ev from hotel_events where id = p_event;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(ev.property_id, 'event.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if exists (select 1 from ticket_orders where event_id = ev.id) then raise exception 'INVALID_STATE: has orders' using errcode = 'P0001'; end if;
  delete from event_ticket_types where event_id = ev.id;
  delete from hotel_events where id = ev.id;
  if ev.venue_booking_id is not null then
    update venue_bookings set status = 'cancelled', cancel_reason = 'Event deleted' where id = ev.venue_booking_id;
  end if;
  perform write_audit(ev.tenant_id, ev.property_id, v_actor, 'hotel_event.deleted', 'hotel_event', ev.id, null, jsonb_build_object('title', ev.title));
end $$;
revoke all on function delete_hotel_event(uuid) from public, anon;
grant execute on function delete_hotel_event(uuid) to authenticated;

create function save_ticket_type(p_event uuid, p_type uuid, p_name text, p_price bigint, p_quantity integer, p_active boolean, p_sort integer default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  ev hotel_events%rowtype; v_actor uuid; v_id uuid; v_name text := btrim(coalesce(p_name, '')); v_cap integer; v_others bigint; v_taken integer;
begin
  select * into ev from hotel_events where id = p_event;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(ev.property_id, 'event.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if length(v_name) not between 1 and 40 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if p_price is null or p_price not between 0 and 1000000000 then raise exception 'POLICY_VIOLATION: price' using errcode = 'P0001'; end if;
  if p_quantity is null or p_quantity not between 1 and 100000 then raise exception 'POLICY_VIOLATION: quantity' using errcode = 'P0001'; end if;
  select * into ev from hotel_events where id = p_event for update;
  if ev.status = 'cancelled' then raise exception 'INVALID_STATE: cancelled' using errcode = 'P0001'; end if;
  if ev.venue_id is not null then   -- all the types together cannot sell more than the venue holds
    select capacity into v_cap from hotel_venues where id = ev.venue_id;
    select coalesce(sum(quantity_total), 0) into v_others from event_ticket_types where event_id = ev.id and id is distinct from p_type and is_active;
    if coalesce(p_active, true) and v_others + p_quantity > v_cap then raise exception 'POLICY_VIOLATION: venue capacity' using errcode = 'P0001'; end if;
  end if;

  if p_type is null then
    if (select count(*) from event_ticket_types where event_id = ev.id) >= 8 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
    begin
      insert into event_ticket_types (tenant_id, property_id, event_id, name, price_minor, quantity_total, is_active, sort_order)
      values (ev.tenant_id, ev.property_id, ev.id, v_name, p_price, p_quantity, coalesce(p_active, true), coalesce(p_sort, 0))
      returning id into v_id;
    exception when unique_violation then raise exception 'POLICY_VIOLATION: name taken' using errcode = 'P0001';
    end;
  else
    perform 1 from event_ticket_types where id = p_type and event_id = ev.id for update;
    if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
    v_taken := ticket_type_taken(p_type);
    if p_quantity < v_taken then raise exception 'POLICY_VIOLATION: below sold %', v_taken using errcode = 'P0001'; end if;
    begin
      update event_ticket_types set name = v_name, price_minor = p_price, quantity_total = p_quantity, is_active = coalesce(p_active, true),
             sort_order = coalesce(p_sort, sort_order), updated_at = now() where id = p_type returning id into v_id;
    exception when unique_violation then raise exception 'POLICY_VIOLATION: name taken' using errcode = 'P0001';
    end;
  end if;
  perform write_audit(ev.tenant_id, ev.property_id, v_actor, 'ticket_type.saved', 'ticket_type', v_id, null,
                      jsonb_build_object('event', ev.title, 'name', v_name, 'price_minor', p_price, 'quantity', p_quantity, 'created', p_type is null));
  return jsonb_build_object('ticket_type_id', v_id);
end $$;
revoke all on function save_ticket_type(uuid, uuid, text, bigint, integer, boolean, integer) from public, anon;
grant execute on function save_ticket_type(uuid, uuid, text, bigint, integer, boolean, integer) to authenticated;

create function delete_ticket_type(p_type uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t event_ticket_types%rowtype; v_actor uuid;
begin
  select * into t from event_ticket_types where id = p_type;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(t.property_id, 'event.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if exists (select 1 from ticket_order_items where ticket_type_id = t.id) then raise exception 'INVALID_STATE: used' using errcode = 'P0001'; end if;
  delete from event_ticket_types where id = t.id;
  perform write_audit(t.tenant_id, t.property_id, v_actor, 'ticket_type.deleted', 'ticket_type', t.id, null, jsonb_build_object('name', t.name));
end $$;
revoke all on function delete_ticket_type(uuid) from public, anon;
grant execute on function delete_ticket_type(uuid) to authenticated;

-- ---- staff: selling, cancelling, checking in ---------------------------------------------------------------
create function staff_sell_tickets(p_property uuid, p_event uuid, p_items jsonb, p_name text, p_email text, p_phone text,
                                   p_method text, p_reference text, p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prop properties%rowtype; v_actor uuid; v_idem record; v_hash text; v_order uuid; o ticket_orders%rowtype; v_pay jsonb; v_result jsonb;
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'event.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'payment.record', 'NOT_FOUND');
  if not exists (select 1 from hotel_events where id = p_event and property_id = p_property) then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_method is null or p_method not in ('cash', 'bank_transfer', 'pos', 'other') then raise exception 'POLICY_VIOLATION: payment method' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', p_property, p_event, p_items::text, coalesce(p_name, ''), coalesce(p_email, ''), coalesce(p_phone, ''), p_method));
  select * into v_idem from idem_begin(v_prop.tenant_id, 'staff_sell_tickets', p_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  v_order := ticket_order_create_internal(p_event, p_items, p_name, p_email, p_phone, 'staff', v_actor);
  select * into o from ticket_orders where id = v_order;
  if o.status = 'pending' then
    v_pay := record_event_payment(null, v_order, o.total_minor, p_method, p_reference, null, 'sell-' || v_order::text);
  end if;
  select * into o from ticket_orders where id = v_order;
  v_result := jsonb_build_object('order_id', v_order, 'reference', o.reference, 'status', o.status, 'total_minor', o.total_minor);
  perform idem_finish(v_prop.tenant_id, 'staff_sell_tickets', p_key, v_result);
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'ticket_order.sold', 'ticket_order', v_order, p_key,
                      jsonb_build_object('reference', o.reference, 'total_minor', o.total_minor, 'method', p_method));
  return v_result;
end $$;
revoke all on function staff_sell_tickets(uuid, uuid, jsonb, text, text, text, text, text, text) from public, anon;
grant execute on function staff_sell_tickets(uuid, uuid, jsonb, text, text, text, text, text, text) to authenticated;

-- Cancels an order and voids its tickets. Money taken stays on the order; the answer says how much, and refund.approve returns it.
create function cancel_ticket_order(p_order uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o ticket_orders%rowtype; v_actor uuid; v_reason text := btrim(coalesce(p_reason, ''));
begin
  select * into o from ticket_orders where id = p_order;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(o.property_id, 'event.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if length(v_reason) not between 1 and 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;
  select * into o from ticket_orders where id = p_order for update;
  if o.status = 'cancelled' then return jsonb_build_object('status', 'cancelled', 'paid_minor', ticket_order_paid(o.id)); end if;
  if exists (select 1 from tickets where order_id = o.id and status = 'used') then raise exception 'INVALID_STATE: used' using errcode = 'P0001'; end if;
  update ticket_orders set status = 'cancelled', cancel_reason = v_reason, hold_expires_at = null where id = o.id;
  update tickets set status = 'void' where order_id = o.id and status = 'valid';
  perform write_audit(o.tenant_id, o.property_id, v_actor, 'ticket_order.cancelled', 'ticket_order', o.id, null,
                      jsonb_build_object('reference', o.reference, 'reason', v_reason, 'paid_minor', ticket_order_paid(o.id)));
  return jsonb_build_object('status', 'cancelled', 'paid_minor', ticket_order_paid(o.id));
end $$;
revoke all on function cancel_ticket_order(uuid, text) from public, anon;
grant execute on function cancel_ticket_order(uuid, text) to authenticated;

-- The door: marks a ticket used. An unknown code is NOT_FOUND, a used or void ticket is INVALID_STATE (used | void | wrong event).
create function ticket_check_in(p_property uuid, p_code text, p_event uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t tickets%rowtype; v_actor uuid; v_code text := upper(btrim(coalesce(p_code, ''))); ev hotel_events%rowtype; o ticket_orders%rowtype; v_type text; v_in integer; v_all integer;
begin
  v_actor := require_permission(p_property, 'event.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into t from tickets where property_id = p_property and code = v_code for update;
  if not found then raise exception 'NOT_FOUND: ticket' using errcode = 'P0001'; end if;
  if p_event is not null and t.event_id <> p_event then raise exception 'INVALID_STATE: wrong event' using errcode = 'P0001'; end if;
  select * into ev from hotel_events where id = t.event_id;
  select * into o from ticket_orders where id = t.order_id;
  if t.status = 'void' or ev.status = 'cancelled' then raise exception 'INVALID_STATE: void' using errcode = 'P0001'; end if;
  if t.status = 'used' then raise exception 'INVALID_STATE: used' using errcode = 'P0001'; end if;
  update tickets set status = 'used', used_at = now(), used_by = v_actor where id = t.id;
  select name into v_type from event_ticket_types where id = t.ticket_type_id;
  select count(*) filter (where status = 'used'), count(*) filter (where status <> 'void') into v_in, v_all from tickets where event_id = t.event_id;
  perform write_audit(t.tenant_id, t.property_id, v_actor, 'ticket.checked_in', 'ticket', t.id, null, jsonb_build_object('event', ev.title, 'code', t.code));
  return jsonb_build_object('status', 'ok', 'event', ev.title, 'ticket_type', v_type, 'buyer', o.buyer_name, 'checked_in', v_in, 'tickets', v_all);
end $$;
revoke all on function ticket_check_in(uuid, text, uuid) from public, anon;
grant execute on function ticket_check_in(uuid, text, uuid) to authenticated;

-- ---- the backstop sweep also lapses unpaid ticket orders ---------------------------------------------------
create or replace function expire_lapsed_event_holds() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer; m integer;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  update venue_bookings set status = 'expired' where status = 'tentative' and hold_expires_at <= now();
  get diagnostics n = row_count;
  update ticket_orders set status = 'expired' where status = 'pending' and hold_expires_at <= now();
  get diagnostics m = row_count;
  return n + m;
end $$;
revoke all on function expire_lapsed_event_holds() from public, anon, authenticated;
grant execute on function expire_lapsed_event_holds() to service_role;
