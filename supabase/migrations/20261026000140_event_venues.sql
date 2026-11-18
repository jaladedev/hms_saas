-- 140 Events, part 1: venues a hotel hires out (a hall, a lawn, a meeting room), the hotel's event terms, and venue bookings with a quote,
-- a deposit and a balance. Part 2 (141) is ticketed events, part 3 (142) is online booking and Paystack deposits, part 4 (143) is the report.
--
-- What a venue booking is. A client (a wedding, a conference, a birthday) books one venue for a start and an end. The slot is a local
-- date and time of the hotel (timestamp, no zone). Money is bigint kobo. Status:
--   enquiry    asked for, nothing held. Staff build the quote while the slot is still open to others.
--   tentative  quoted and the slot is held until hold_expires_at. The exclusion constraint below is the referee.
--   confirmed  the deposit is paid (or staff waived it, audited). The slot is held for good.
--   completed  the event took place (set by staff). cancelled | expired | declined end a booking and free the slot.
-- A hold that has run out is released inside the transaction that needs the slot (release_expired_venue_holds); an exclusion constraint
-- cannot use now(), so the maintenance sweep (expire_lapsed_event_holds) is only a backstop, as with room holds (004).
--
-- Terms. event_settings is one row a hotel may set: tax and service charge percentages (data, never constants; they default to 0 until
-- the hotel and its adviser set them), the deposit percentage (default 30) and how many hours a hold lasts (default 48). A booking copies
-- the terms when it is made and while it is still an enquiry; once it is held or confirmed the copy is frozen.
--   service = round(subtotal * service% / 100)       tax = round((subtotal + service) * tax% / 100)       total = subtotal + service + tax
--   deposit = ceil(total * deposit% / 100)
--
-- Permissions: event.view (read), event.manage (create, quote, hold, confirm, cancel, link rooms). Venue setup and settings are
-- property.configure, like the rest of the hotel's setup. Recording money is payment.record and returning money is refund.approve,
-- so the person who takes a deposit cannot also give it back. Reading the money lines needs can_view_money.

-- ---- permissions ----------------------------------------------------------------------------
insert into permissions (key) values ('event.view'), ('event.manage');
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
 where p.key = 'event.view' and r.key in ('owner', 'general_manager', 'front_desk', 'reservations_officer', 'accountant');
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
 where p.key = 'event.manage' and r.key in ('owner', 'general_manager', 'front_desk', 'reservations_officer');

create function property_local_now(p_property uuid) returns timestamp
language sql stable security definer set search_path = public as $$
  select now() at time zone timezone from properties where id = p_property
$$;
revoke all on function property_local_now(uuid) from public, anon, authenticated;

-- ---- terms ----------------------------------------------------------------------------------
create table event_settings (
  property_id     uuid primary key references properties(id),
  tenant_id       uuid not null,
  tax_percent     numeric(5, 2) not null default 0 check (tax_percent between 0 and 100),
  service_percent numeric(5, 2) not null default 0 check (service_percent between 0 and 100),
  deposit_percent integer not null default 30 check (deposit_percent between 0 and 100),
  hold_hours      integer not null default 48 check (hold_hours between 1 and 720),
  updated_at      timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id)
);
alter table event_settings enable row level security;
create policy event_settings_select on event_settings for select to authenticated
  using (has_permission(property_id, 'event.view') or has_permission(property_id, 'property.configure'));
revoke insert, update, delete on event_settings from authenticated, anon;

-- The settings of a property with the defaults filled in, for the functions below and the staff screens.
create function event_terms(p_property uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'tax_percent', coalesce(s.tax_percent, 0), 'service_percent', coalesce(s.service_percent, 0),
    'deposit_percent', coalesce(s.deposit_percent, 30), 'hold_hours', coalesce(s.hold_hours, 48))
    from properties p left join event_settings s on s.property_id = p.id where p.id = p_property
$$;
revoke all on function event_terms(uuid) from public, anon, authenticated;

create function event_terms_get(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_permission(p_property, 'event.view', 'NOT_FOUND');
  return event_terms(p_property);
end $$;
revoke all on function event_terms_get(uuid) from public, anon;
grant execute on function event_terms_get(uuid) to authenticated;

create function save_event_settings(p_property uuid, p_tax numeric, p_service numeric, p_deposit integer, p_hold_hours integer)
returns void language plpgsql security definer set search_path = public as $$
declare v_prop properties%rowtype; v_actor uuid;
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_tax is null or p_tax not between 0 and 100 then raise exception 'POLICY_VIOLATION: tax' using errcode = 'P0001'; end if;
  if p_service is null or p_service not between 0 and 100 then raise exception 'POLICY_VIOLATION: service' using errcode = 'P0001'; end if;
  if p_deposit is null or p_deposit not between 0 and 100 then raise exception 'POLICY_VIOLATION: deposit' using errcode = 'P0001'; end if;
  if p_hold_hours is null or p_hold_hours not between 1 and 720 then raise exception 'POLICY_VIOLATION: hold hours' using errcode = 'P0001'; end if;
  insert into event_settings (property_id, tenant_id, tax_percent, service_percent, deposit_percent, hold_hours)
  values (p_property, v_prop.tenant_id, p_tax, p_service, p_deposit, p_hold_hours)
  on conflict (property_id) do update
    set tax_percent = excluded.tax_percent, service_percent = excluded.service_percent,
        deposit_percent = excluded.deposit_percent, hold_hours = excluded.hold_hours, updated_at = now();
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'event_settings.saved', 'property', p_property, null,
                      jsonb_build_object('tax_percent', p_tax, 'service_percent', p_service, 'deposit_percent', p_deposit, 'hold_hours', p_hold_hours));
end $$;
revoke all on function save_event_settings(uuid, numeric, numeric, integer, integer) from public, anon;
grant execute on function save_event_settings(uuid, numeric, numeric, integer, integer) to authenticated;

-- ---- venues ---------------------------------------------------------------------------------
create table hotel_venues (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  property_id       uuid not null,
  name              text not null check (length(btrim(name)) between 1 and 60),
  body              text not null default '' check (length(body) <= 200),
  capacity          integer not null check (capacity between 1 and 100000),
  hourly_rate_minor bigint check (hourly_rate_minor is null or hourly_rate_minor between 1 and 1000000000),
  day_rate_minor    bigint check (day_rate_minor is null or day_rate_minor between 1 and 1000000000),
  bookable_online   boolean not null default false,
  is_active         boolean not null default true,
  sort_order        integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  unique (tenant_id, property_id, id),
  check (hourly_rate_minor is not null or day_rate_minor is not null)
);
create index hotel_venues_property_idx on hotel_venues (property_id, sort_order, created_at);
alter table hotel_venues enable row level security;
create policy hotel_venues_select on hotel_venues for select to authenticated
  using (has_permission(property_id, 'event.view') or has_permission(property_id, 'property.configure'));
revoke insert, update, delete on hotel_venues from authenticated, anon;

create function save_hotel_venue(p_property uuid, p_venue uuid, p_name text, p_body text, p_capacity integer, p_hourly bigint,
                                 p_day bigint, p_online boolean, p_active boolean, p_sort integer default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prop properties%rowtype; v_actor uuid; v_id uuid; v_name text := btrim(coalesce(p_name, '')); v_body text := btrim(coalesce(p_body, ''));
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'property.configure', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if length(v_name) not between 1 and 60 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if length(v_body) > 200 then raise exception 'POLICY_VIOLATION: text' using errcode = 'P0001'; end if;
  if p_capacity is null or p_capacity not between 1 and 100000 then raise exception 'POLICY_VIOLATION: capacity' using errcode = 'P0001'; end if;
  if p_hourly is not null and p_hourly not between 1 and 1000000000 then raise exception 'POLICY_VIOLATION: price' using errcode = 'P0001'; end if;
  if p_day is not null and p_day not between 1 and 1000000000 then raise exception 'POLICY_VIOLATION: price' using errcode = 'P0001'; end if;
  if p_hourly is null and p_day is null then raise exception 'POLICY_VIOLATION: price' using errcode = 'P0001'; end if;

  if p_venue is null then
    if (select count(*) from hotel_venues where property_id = p_property) >= 12 then raise exception 'POLICY_VIOLATION: limit' using errcode = 'P0001'; end if;
    insert into hotel_venues (tenant_id, property_id, name, body, capacity, hourly_rate_minor, day_rate_minor, bookable_online, is_active, sort_order)
    values (v_prop.tenant_id, p_property, v_name, v_body, p_capacity, p_hourly, p_day, coalesce(p_online, false), coalesce(p_active, true), coalesce(p_sort, 0))
    returning id into v_id;
  else
    update hotel_venues set name = v_name, body = v_body, capacity = p_capacity, hourly_rate_minor = p_hourly, day_rate_minor = p_day,
           bookable_online = coalesce(p_online, false), is_active = coalesce(p_active, true), sort_order = coalesce(p_sort, sort_order), updated_at = now()
     where id = p_venue and property_id = p_property
     returning id into v_id;
    if v_id is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  end if;
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'hotel_venue.saved', 'hotel_venue', v_id, null,
                      jsonb_build_object('name', v_name, 'capacity', p_capacity, 'hourly_rate_minor', p_hourly, 'day_rate_minor', p_day,
                                         'bookable_online', coalesce(p_online, false), 'active', coalesce(p_active, true), 'created', p_venue is null));
  return jsonb_build_object('venue_id', v_id);
end $$;
revoke all on function save_hotel_venue(uuid, uuid, text, text, integer, bigint, bigint, boolean, boolean, integer) from public, anon;
grant execute on function save_hotel_venue(uuid, uuid, text, text, integer, bigint, bigint, boolean, boolean, integer) to authenticated;

-- ---- venue bookings -------------------------------------------------------------------------
create table venue_bookings (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  property_id       uuid not null,
  venue_id          uuid not null,
  reference         text not null,
  status            text not null default 'enquiry' check (status in ('enquiry', 'tentative', 'confirmed', 'completed', 'cancelled', 'expired', 'declined')),
  source            text not null default 'staff' check (source in ('staff', 'website', 'ticketed_event')),
  event_type        text not null default 'other' check (event_type in ('wedding', 'conference', 'meeting', 'birthday', 'party', 'ticketed', 'other')),
  title             text not null default '' check (length(title) <= 80),
  contact_name      text not null check (length(btrim(contact_name)) between 1 and 80),
  contact_email     text check (contact_email is null or (length(contact_email) <= 120 and contact_email ~ '^[^@ ]+@[^@ ]+\.[^@ ]+$')),
  contact_phone     text check (contact_phone is null or length(contact_phone) between 5 and 40),
  attendees         integer not null check (attendees between 1 and 100000),
  starts_at         timestamp not null,
  ends_at           timestamp not null,
  hold_expires_at   timestamptz,
  note              text check (note is null or length(note) <= 500),
  currency          char(3) not null,
  tax_percent       numeric(5, 2) not null default 0,
  service_percent   numeric(5, 2) not null default 0,
  deposit_percent   integer not null default 30,
  subtotal_minor    bigint not null default 0 check (subtotal_minor >= 0),
  service_minor     bigint not null default 0 check (service_minor >= 0),
  tax_minor         bigint not null default 0 check (tax_minor >= 0),
  total_minor       bigint not null default 0 check (total_minor >= 0),
  deposit_minor     bigint not null default 0 check (deposit_minor >= 0),
  deposit_waived    boolean not null default false,
  attention_reason  text,
  cancel_reason     text check (cancel_reason is null or length(cancel_reason) <= 200),
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  foreign key (tenant_id, property_id, venue_id) references hotel_venues (tenant_id, property_id, id),
  unique (tenant_id, property_id, id),
  unique (property_id, reference),
  check (starts_at < ends_at and ends_at <= starts_at + interval '14 days'),
  check (status <> 'tentative' or hold_expires_at is not null),
  check (total_minor = subtotal_minor + service_minor + tax_minor),
  check (deposit_minor <= total_minor),
  constraint no_venue_overlap exclude using gist (
    venue_id with =,
    tsrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('tentative', 'confirmed'))
);
create index venue_bookings_calendar_idx on venue_bookings (property_id, starts_at);
create index venue_bookings_open_idx on venue_bookings (property_id, status, created_at) where status in ('enquiry', 'tentative');
create trigger venue_bookings_updated before update on venue_bookings for each row execute function set_updated_at();
alter table venue_bookings enable row level security;
create policy venue_bookings_select on venue_bookings for select to authenticated using (has_permission(property_id, 'event.view'));
revoke insert, update, delete on venue_bookings from authenticated, anon;

create table venue_booking_lines (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  property_id       uuid not null,
  booking_id        uuid not null,
  kind              text not null check (kind in ('venue', 'catering', 'equipment', 'decor', 'other')),
  description       text not null check (length(btrim(description)) between 1 and 120),
  quantity          integer not null check (quantity between 1 and 10000),
  unit_amount_minor bigint not null check (unit_amount_minor between 0 and 1000000000),
  line_total_minor  bigint generated always as (quantity::bigint * unit_amount_minor) stored,
  sort_order        integer not null default 0,
  foreign key (tenant_id, property_id, booking_id) references venue_bookings (tenant_id, property_id, id)
);
create index venue_booking_lines_booking_idx on venue_booking_lines (booking_id, sort_order);
alter table venue_booking_lines enable row level security;
create policy venue_booking_lines_select on venue_booking_lines for select to authenticated using (has_permission(property_id, 'event.view'));
revoke insert, update, delete on venue_booking_lines from authenticated, anon;

-- ---- money: one ledger for venue bookings and ticket orders (141) ---------------------------------
-- Rows are never edited. A deposit that goes back is a 'refund' row, so the history shows both. Ticket orders (141) share this table,
-- which is why the target is "exactly one of" the two columns; the second foreign key is added in 141.
create table event_payments (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  property_id        uuid not null,
  venue_booking_id   uuid,
  ticket_order_id    uuid,
  payment_kind       text not null default 'payment' check (payment_kind in ('payment', 'refund')),
  payment_provider   text not null default 'manual' check (payment_provider in ('manual', 'paystack')),
  payment_method     text not null check (payment_method in ('cash', 'bank_transfer', 'pos', 'other', 'card', 'bank', 'ussd', 'qr', 'mobile_money', 'eft')),
  provider_reference text,
  internal_reference text not null,
  amount_minor       bigint not null check (amount_minor > 0),
  currency           char(3) not null,
  note               text check (note is null or length(note) <= 200),
  attempt_id         uuid,
  received_at        timestamptz not null default now(),
  recorded_by        uuid,
  created_at         timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  foreign key (tenant_id, property_id, venue_booking_id) references venue_bookings (tenant_id, property_id, id),
  unique (tenant_id, internal_reference),
  check ((venue_booking_id is null) <> (ticket_order_id is null)),
  check (payment_kind = 'payment' or payment_provider = 'manual')
);
create index event_payments_booking_idx on event_payments (venue_booking_id) where venue_booking_id is not null;
create index event_payments_order_idx on event_payments (ticket_order_id) where ticket_order_id is not null;
create unique index event_payments_one_per_provider_reference on event_payments (payment_provider, provider_reference)
  where payment_provider <> 'manual' and provider_reference is not null;
create function event_payments_immutable() returns trigger language plpgsql as $$
begin raise exception 'event payments cannot be changed or deleted' using errcode = '23514'; end $$;
create trigger event_payments_no_change before update or delete on event_payments for each row execute function event_payments_immutable();
alter table event_payments enable row level security;
create policy event_payments_select on event_payments for select to authenticated using (can_view_money(property_id));
revoke insert, update, delete on event_payments from authenticated, anon;

-- What a venue booking has taken so far: payments less refunds.
create function venue_booking_paid(p_booking uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(case payment_kind when 'payment' then amount_minor else -amount_minor end), 0)::bigint
    from event_payments where venue_booking_id = p_booking
$$;
revoke all on function venue_booking_paid(uuid) from public, anon, authenticated;

-- ---- room blocks and linked stays -------------------------------------------------------------------
-- A block holds real rooms for the event's guests: each room is a 'block' claim (004), so the room calendar and online search both see it.
create table event_room_blocks (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  property_id   uuid not null,
  booking_id    uuid not null,
  room_type_id  uuid not null,
  rooms         integer not null check (rooms between 1 and 50),
  start_date    date not null,
  end_date      date not null,
  status        text not null default 'active' check (status in ('active', 'released')),
  claim_ids     uuid[] not null,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  released_at   timestamptz,
  foreign key (tenant_id, property_id, booking_id) references venue_bookings (tenant_id, property_id, id),
  check (start_date < end_date and end_date - start_date <= 30),
  check (array_length(claim_ids, 1) = rooms)
);
create index event_room_blocks_booking_idx on event_room_blocks (booking_id);
alter table event_room_blocks enable row level security;
create policy event_room_blocks_select on event_room_blocks for select to authenticated using (has_permission(property_id, 'event.view'));
revoke insert, update, delete on event_room_blocks from authenticated, anon;

create table event_reservation_links (
  booking_id     uuid not null,
  reservation_id uuid not null,
  tenant_id      uuid not null,
  property_id    uuid not null,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  primary key (booking_id, reservation_id),
  foreign key (tenant_id, property_id, booking_id) references venue_bookings (tenant_id, property_id, id),
  foreign key (tenant_id, property_id, reservation_id) references reservations (tenant_id, property_id, id)
);
create index event_reservation_links_reservation_idx on event_reservation_links (reservation_id);
alter table event_reservation_links enable row level security;
create policy event_reservation_links_select on event_reservation_links for select to authenticated
  using (has_permission(property_id, 'event.view') and has_permission(property_id, 'reservation.view'));
revoke insert, update, delete on event_reservation_links from authenticated, anon;

-- ---- internal helpers -----------------------------------------------------------------------------
create function release_expired_venue_holds(p_venue uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update venue_bookings set status = 'expired' where venue_id = p_venue and status = 'tentative' and hold_expires_at <= now();
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function release_expired_venue_holds(uuid) from public, anon, authenticated;

-- Totals from the lines and the booking's own copy of the terms. A held or confirmed booking keeps its terms; an enquiry takes the
-- hotel's current ones first.
create function venue_booking_recalc(p_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b venue_bookings%rowtype; t jsonb; v_sub bigint; v_service bigint; v_tax bigint; v_total bigint;
begin
  select * into b from venue_bookings where id = p_booking;
  if b.status = 'enquiry' then
    t := event_terms(b.property_id);
    b.tax_percent := (t ->> 'tax_percent')::numeric; b.service_percent := (t ->> 'service_percent')::numeric;
    b.deposit_percent := (t ->> 'deposit_percent')::integer;
  end if;
  select coalesce(sum(line_total_minor), 0) into v_sub from venue_booking_lines where booking_id = p_booking;
  v_service := round(v_sub * b.service_percent / 100)::bigint;
  v_tax := round((v_sub + v_service) * b.tax_percent / 100)::bigint;
  v_total := v_sub + v_service + v_tax;
  update venue_bookings
     set tax_percent = b.tax_percent, service_percent = b.service_percent, deposit_percent = b.deposit_percent,
         subtotal_minor = v_sub, service_minor = v_service, tax_minor = v_tax, total_minor = v_total,
         deposit_minor = ceil(v_total * b.deposit_percent / 100.0)::bigint
   where id = p_booking;
end $$;
revoke all on function venue_booking_recalc(uuid) from public, anon, authenticated;

-- The hire price of a venue for a start and an end: the cheaper of by the hour and by the day (every started day counts), and the
-- one that exists when only one is set.
create function venue_hire_amount(p_venue uuid, p_starts timestamp, p_ends timestamp) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v hotel_venues%rowtype; v_hours integer; v_days integer; v_by_hour bigint; v_by_day bigint; v_amount bigint;
begin
  select * into v from hotel_venues where id = p_venue;
  v_hours := ceil(extract(epoch from (p_ends - p_starts)) / 3600.0)::integer;
  v_days := ceil(v_hours / 24.0)::integer;
  v_by_hour := case when v.hourly_rate_minor is null then null else v.hourly_rate_minor * v_hours end;
  v_by_day := case when v.day_rate_minor is null then null else v.day_rate_minor * v_days end;
  v_amount := least(coalesce(v_by_hour, v_by_day), coalesce(v_by_day, v_by_hour));
  return jsonb_build_object('amount_minor', v_amount, 'hours', v_hours, 'days', v_days);
end $$;
revoke all on function venue_hire_amount(uuid, timestamp, timestamp) from public, anon, authenticated;

create function venue_booking_new_reference(p_property uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_ref text;
begin
  loop
    v_ref := 'EVB-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists (select 1 from venue_bookings where property_id = p_property and reference = v_ref);
  end loop;
  return v_ref;
end $$;
revoke all on function venue_booking_new_reference(uuid) from public, anon, authenticated;

-- Holds the slot: enquiry/expired -> tentative. The caller has checked permission and locked the row.
create function venue_booking_hold_internal(p_booking uuid, p_hours integer) returns void
language plpgsql security definer set search_path = public as $$
declare b venue_bookings%rowtype;
begin
  select * into b from venue_bookings where id = p_booking;
  perform release_expired_venue_holds(b.venue_id);
  begin
    update venue_bookings set status = 'tentative', hold_expires_at = now() + make_interval(hours => p_hours), attention_reason = null where id = p_booking;
  exception when exclusion_violation then
    raise exception 'VENUE_UNAVAILABLE' using errcode = 'P0001';
  end;
end $$;
revoke all on function venue_booking_hold_internal(uuid, integer) from public, anon, authenticated;

-- After money moves: a held booking whose deposit is in becomes confirmed. A lapsed hold is revived when the slot is still free.
-- Returns the resulting status. 'slot_lost' means the money is in but the slot went to someone else (the caller flags it).
create function venue_booking_after_payment(p_booking uuid) returns text
language plpgsql security definer set search_path = public as $$
declare b venue_bookings%rowtype; v_paid bigint;
begin
  select * into b from venue_bookings where id = p_booking for update;
  v_paid := venue_booking_paid(p_booking);
  if b.status in ('tentative', 'expired', 'enquiry') and v_paid >= b.deposit_minor and v_paid > 0 then
    perform release_expired_venue_holds(b.venue_id);
    select * into b from venue_bookings where id = p_booking;
    begin
      update venue_bookings set status = 'confirmed', hold_expires_at = null, attention_reason = null where id = p_booking;
      return 'confirmed';
    exception when exclusion_violation then
      update venue_bookings set attention_reason = 'paid_slot_lost' where id = p_booking;
      return 'slot_lost';
    end;
  end if;
  return b.status;
end $$;
revoke all on function venue_booking_after_payment(uuid) from public, anon, authenticated;

-- ---- staff: create, quote, hold, confirm, cancel, complete -----------------------------------------------
create function create_venue_booking(
  p_property uuid, p_venue uuid, p_starts timestamp, p_ends timestamp, p_event_type text, p_title text,
  p_name text, p_email text, p_phone text, p_attendees integer, p_note text, p_hold boolean, p_key text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prop properties%rowtype; v_venue hotel_venues%rowtype; v_actor uuid; v_idem record; v_hash text; v_id uuid; v_ref text; v_t jsonb;
  v_name text := btrim(coalesce(p_name, '')); v_email text := nullif(btrim(coalesce(p_email, '')), ''); v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_title text := btrim(coalesce(p_title, '')); v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_type text := coalesce(nullif(btrim(coalesce(p_event_type, '')), ''), 'other');
  v_amt jsonb; v_result jsonb;
begin
  select * into v_prop from properties where id = p_property;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(p_property, 'event.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into v_venue from hotel_venues where id = p_venue and property_id = p_property and is_active;
  if not found then raise exception 'NOT_FOUND: venue' using errcode = 'P0001'; end if;
  if v_type not in ('wedding', 'conference', 'meeting', 'birthday', 'party', 'other') then raise exception 'POLICY_VIOLATION: event type' using errcode = 'P0001'; end if;
  if length(v_name) not between 1 and 80 then raise exception 'POLICY_VIOLATION: name' using errcode = 'P0001'; end if;
  if length(v_title) > 80 then raise exception 'POLICY_VIOLATION: title' using errcode = 'P0001'; end if;
  if v_email is not null and not (length(v_email) <= 120 and v_email ~ '^[^@ ]+@[^@ ]+\.[^@ ]+$') then raise exception 'POLICY_VIOLATION: email' using errcode = 'P0001'; end if;
  if v_phone is not null and length(v_phone) not between 5 and 40 then raise exception 'POLICY_VIOLATION: phone' using errcode = 'P0001'; end if;
  if v_email is null and v_phone is null then raise exception 'POLICY_VIOLATION: contact' using errcode = 'P0001'; end if;
  if v_note is not null and length(v_note) > 500 then raise exception 'POLICY_VIOLATION: note' using errcode = 'P0001'; end if;
  if p_starts is null or p_ends is null or p_starts >= p_ends or p_ends > p_starts + interval '14 days' then raise exception 'POLICY_VIOLATION: times' using errcode = 'P0001'; end if;
  if p_starts <= property_local_now(p_property) then raise exception 'POLICY_VIOLATION: past' using errcode = 'P0001'; end if;
  if p_attendees is null or p_attendees < 1 or p_attendees > v_venue.capacity then raise exception 'POLICY_VIOLATION: attendees' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', p_property, p_venue, p_starts, p_ends, v_type, v_name, coalesce(v_email, ''), coalesce(v_phone, ''), p_attendees, coalesce(p_hold, false)));
  select * into v_idem from idem_begin(v_prop.tenant_id, 'create_venue_booking', p_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  v_t := event_terms(p_property);
  v_ref := venue_booking_new_reference(p_property);
  insert into venue_bookings (tenant_id, property_id, venue_id, reference, status, source, event_type, title, contact_name, contact_email, contact_phone,
                              attendees, starts_at, ends_at, note, currency, tax_percent, service_percent, deposit_percent, created_by)
  values (v_prop.tenant_id, p_property, p_venue, v_ref, 'enquiry', 'staff', v_type, v_title, v_name, v_email, v_phone, p_attendees, p_starts, p_ends, v_note,
          v_prop.currency, (v_t ->> 'tax_percent')::numeric, (v_t ->> 'service_percent')::numeric, (v_t ->> 'deposit_percent')::integer, v_actor)
  returning id into v_id;

  if coalesce(p_hold, false) then
    v_amt := venue_hire_amount(p_venue, p_starts, p_ends);
    insert into venue_booking_lines (tenant_id, property_id, booking_id, kind, description, quantity, unit_amount_minor)
    values (v_prop.tenant_id, p_property, v_id, 'venue', left('Hire of ' || v_venue.name || ', ' || (v_amt ->> 'hours') || ' hours', 120), 1, (v_amt ->> 'amount_minor')::bigint);
    perform venue_booking_recalc(v_id);
    perform venue_booking_hold_internal(v_id, (v_t ->> 'hold_hours')::integer);
  end if;

  v_result := jsonb_build_object('booking_id', v_id, 'reference', v_ref, 'status', (select status from venue_bookings where id = v_id));
  perform idem_finish(v_prop.tenant_id, 'create_venue_booking', p_key, v_result);
  perform write_audit(v_prop.tenant_id, p_property, v_actor, 'venue_booking.created', 'venue_booking', v_id, p_key,
                      jsonb_build_object('reference', v_ref, 'venue', v_venue.name, 'status', v_result ->> 'status', 'starts_at', p_starts, 'ends_at', p_ends));
  return v_result;
end $$;
revoke all on function create_venue_booking(uuid, uuid, timestamp, timestamp, text, text, text, text, text, integer, text, boolean, text) from public, anon;
grant execute on function create_venue_booking(uuid, uuid, timestamp, timestamp, text, text, text, text, text, integer, text, boolean, text) to authenticated;

-- Replaces the quote lines: [{kind, description, quantity, unit_amount_minor}], 1 to 20 of them.
create function set_venue_booking_lines(p_booking uuid, p_lines jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b venue_bookings%rowtype; v_actor uuid; l jsonb; v_n integer := 0; v_kind text; v_desc text; v_qty integer; v_unit bigint; v_paid bigint;
begin
  select * into b from venue_bookings where id = p_booking;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(b.property_id, 'event.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into b from venue_bookings where id = p_booking for update;
  if b.status not in ('enquiry', 'tentative', 'confirmed') then raise exception 'INVALID_STATE: %', b.status using errcode = 'P0001'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 20 then raise exception 'POLICY_VIOLATION: lines' using errcode = 'P0001'; end if;

  delete from venue_booking_lines where booking_id = p_booking;
  for l in select * from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    v_kind := coalesce(l ->> 'kind', 'other');
    v_desc := btrim(coalesce(l ->> 'description', ''));
    if v_kind not in ('venue', 'catering', 'equipment', 'decor', 'other') then raise exception 'POLICY_VIOLATION: line kind' using errcode = 'P0001'; end if;
    if length(v_desc) not between 1 and 120 then raise exception 'POLICY_VIOLATION: line text' using errcode = 'P0001'; end if;
    if (l ->> 'quantity') is null or (l ->> 'quantity') !~ '^\d{1,5}$' or (l ->> 'quantity')::integer not between 1 and 10000 then raise exception 'POLICY_VIOLATION: line quantity' using errcode = 'P0001'; end if;
    if (l ->> 'unit_amount_minor') is null or (l ->> 'unit_amount_minor') !~ '^\d{1,10}$' or (l ->> 'unit_amount_minor')::bigint > 1000000000 then raise exception 'POLICY_VIOLATION: line amount' using errcode = 'P0001'; end if;
    v_qty := (l ->> 'quantity')::integer; v_unit := (l ->> 'unit_amount_minor')::bigint;
    insert into venue_booking_lines (tenant_id, property_id, booking_id, kind, description, quantity, unit_amount_minor, sort_order)
    values (b.tenant_id, b.property_id, b.id, v_kind, v_desc, v_qty, v_unit, v_n);
  end loop;
  perform venue_booking_recalc(p_booking);

  v_paid := venue_booking_paid(p_booking);
  if (select total_minor from venue_bookings where id = p_booking) < v_paid then raise exception 'POLICY_VIOLATION: total below paid' using errcode = 'P0001'; end if;
  perform write_audit(b.tenant_id, b.property_id, v_actor, 'venue_booking.quoted', 'venue_booking', b.id, null,
                      jsonb_build_object('reference', b.reference, 'lines', v_n, 'total_minor', (select total_minor from venue_bookings where id = p_booking)));
  return jsonb_build_object('booking_id', b.id, 'total_minor', (select total_minor from venue_bookings where id = p_booking),
                            'deposit_minor', (select deposit_minor from venue_bookings where id = p_booking));
end $$;
revoke all on function set_venue_booking_lines(uuid, jsonb) from public, anon;
grant execute on function set_venue_booking_lines(uuid, jsonb) to authenticated;

-- Holds the slot for a quoted enquiry (or revives a lapsed hold) for the hotel's hold hours.
create function hold_venue_booking(p_booking uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b venue_bookings%rowtype; v_actor uuid; v_hours integer;
begin
  select * into b from venue_bookings where id = p_booking;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(b.property_id, 'event.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into b from venue_bookings where id = p_booking for update;
  if b.status = 'tentative' and b.hold_expires_at > now() then return jsonb_build_object('status', 'tentative'); end if;
  if b.status not in ('enquiry', 'tentative', 'expired') then raise exception 'INVALID_STATE: %', b.status using errcode = 'P0001'; end if;
  if b.starts_at <= property_local_now(b.property_id) then raise exception 'POLICY_VIOLATION: past' using errcode = 'P0001'; end if;
  if not exists (select 1 from venue_booking_lines where booking_id = b.id) then raise exception 'INVALID_STATE: no lines' using errcode = 'P0001'; end if;
  if b.status = 'tentative' then update venue_bookings set status = 'expired' where id = b.id; end if;   -- a lapsed hold the sweep has not reached yet
  v_hours := (event_terms(b.property_id) ->> 'hold_hours')::integer;
  perform venue_booking_hold_internal(b.id, v_hours);
  perform write_audit(b.tenant_id, b.property_id, v_actor, 'venue_booking.held', 'venue_booking', b.id, null, jsonb_build_object('reference', b.reference, 'hours', v_hours));
  return jsonb_build_object('status', 'tentative');
end $$;
revoke all on function hold_venue_booking(uuid) from public, anon;
grant execute on function hold_venue_booking(uuid) to authenticated;

-- Confirms a booking whose deposit is in, or waives the deposit (audited, and noted on the booking).
create function confirm_venue_booking(p_booking uuid, p_waive_deposit boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b venue_bookings%rowtype; v_actor uuid; v_paid bigint;
begin
  select * into b from venue_bookings where id = p_booking;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(b.property_id, 'event.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into b from venue_bookings where id = p_booking for update;
  if b.status = 'confirmed' then return jsonb_build_object('status', 'confirmed'); end if;
  if b.status not in ('enquiry', 'tentative', 'expired') then raise exception 'INVALID_STATE: %', b.status using errcode = 'P0001'; end if;
  if b.starts_at <= property_local_now(b.property_id) then raise exception 'POLICY_VIOLATION: past' using errcode = 'P0001'; end if;
  if not exists (select 1 from venue_booking_lines where booking_id = b.id) then raise exception 'INVALID_STATE: no lines' using errcode = 'P0001'; end if;
  v_paid := venue_booking_paid(b.id);
  if v_paid < b.deposit_minor and not coalesce(p_waive_deposit, false) then
    raise exception 'PAYMENT_REQUIRED deposit % paid %', b.deposit_minor, v_paid using errcode = 'P0001';
  end if;
  perform release_expired_venue_holds(b.venue_id);
  if b.status = 'enquiry' then perform venue_booking_recalc(b.id); end if;   -- an enquiry takes the hotel's current terms once more; they freeze on confirming
  begin
    update venue_bookings set status = 'confirmed', hold_expires_at = null, attention_reason = null,
           deposit_waived = (v_paid < b.deposit_minor) where id = b.id;
  exception when exclusion_violation then
    raise exception 'VENUE_UNAVAILABLE' using errcode = 'P0001';
  end;
  perform write_audit(b.tenant_id, b.property_id, v_actor, 'venue_booking.confirmed', 'venue_booking', b.id, null,
                      jsonb_build_object('reference', b.reference, 'paid_minor', v_paid, 'deposit_waived', v_paid < b.deposit_minor));
  return jsonb_build_object('status', 'confirmed');
end $$;
revoke all on function confirm_venue_booking(uuid, boolean) from public, anon;
grant execute on function confirm_venue_booking(uuid, boolean) to authenticated;

-- Cancels (or, for an enquiry nobody held, declines) a booking and gives back its slot and its room blocks. Money already taken stays on
-- the booking; the answer says how much, and a person with refund.approve records the refund.
create function cancel_venue_booking(p_booking uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b venue_bookings%rowtype; v_actor uuid; v_reason text := btrim(coalesce(p_reason, '')); v_new text; blk record; v_paid bigint;
begin
  select * into b from venue_bookings where id = p_booking;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(b.property_id, 'event.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if length(v_reason) not between 1 and 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;
  select * into b from venue_bookings where id = p_booking for update;
  if b.status in ('cancelled', 'declined') then return jsonb_build_object('status', b.status); end if;
  if b.status not in ('enquiry', 'tentative', 'confirmed', 'expired') then raise exception 'INVALID_STATE: %', b.status using errcode = 'P0001'; end if;
  if b.source = 'ticketed_event' then raise exception 'INVALID_STATE: ticketed' using errcode = 'P0001'; end if;
  v_new := case when b.status in ('enquiry', 'expired') and venue_booking_paid(b.id) = 0 then 'declined' else 'cancelled' end;
  update venue_bookings set status = v_new, cancel_reason = v_reason, hold_expires_at = null where id = b.id;
  for blk in select id, claim_ids from event_room_blocks where booking_id = b.id and status = 'active' loop
    update room_inventory_claims set status = 'released' where id = any(blk.claim_ids) and status = 'active';
    update event_room_blocks set status = 'released', released_at = now() where id = blk.id;
  end loop;
  v_paid := venue_booking_paid(b.id);
  perform write_audit(b.tenant_id, b.property_id, v_actor, 'venue_booking.' || v_new, 'venue_booking', b.id, null,
                      jsonb_build_object('reference', b.reference, 'reason', v_reason, 'paid_minor', v_paid));
  return jsonb_build_object('status', v_new, 'paid_minor', v_paid);
end $$;
revoke all on function cancel_venue_booking(uuid, text) from public, anon;
grant execute on function cancel_venue_booking(uuid, text) to authenticated;

create function complete_venue_booking(p_booking uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b venue_bookings%rowtype; v_actor uuid;
begin
  select * into b from venue_bookings where id = p_booking;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(b.property_id, 'event.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  select * into b from venue_bookings where id = p_booking for update;
  if b.status = 'completed' then return jsonb_build_object('status', 'completed'); end if;
  if b.status <> 'confirmed' then raise exception 'INVALID_STATE: %', b.status using errcode = 'P0001'; end if;
  if b.source = 'ticketed_event' then raise exception 'INVALID_STATE: ticketed' using errcode = 'P0001'; end if;
  if b.starts_at > property_local_now(b.property_id) then raise exception 'INVALID_STATE: too early' using errcode = 'P0001'; end if;
  update venue_bookings set status = 'completed' where id = b.id;
  perform write_audit(b.tenant_id, b.property_id, v_actor, 'venue_booking.completed', 'venue_booking', b.id, null, jsonb_build_object('reference', b.reference));
  return jsonb_build_object('status', 'completed');
end $$;
revoke all on function complete_venue_booking(uuid) from public, anon;
grant execute on function complete_venue_booking(uuid) to authenticated;

-- ---- staff: money ---------------------------------------------------------------------------------------
-- One function for a manual payment on a venue booking or a ticket order (141 adds the order side); exactly one target.
create function record_event_payment(p_booking uuid, p_order uuid, p_amount bigint, p_method text, p_reference text, p_note text, p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prop uuid; v_tenant uuid; v_currency char(3); v_actor uuid; v_idem record; v_hash text; v_id uuid := gen_random_uuid(); v_ref text;
  b venue_bookings%rowtype; v_paid bigint; v_total bigint; v_status text; v_result jsonb;
  v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_pref text := nullif(btrim(coalesce(p_reference, '')), '');
begin
  if (p_booking is null) = (p_order is null) then raise exception 'POLICY_VIOLATION: target' using errcode = 'P0001'; end if;
  if p_booking is not null then
    select property_id, tenant_id, currency into v_prop, v_tenant, v_currency from venue_bookings where id = p_booking;
  else
    select property_id, tenant_id, currency into v_prop, v_tenant, v_currency from ticket_orders where id = p_order;
  end if;
  if v_prop is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(v_prop, 'payment.record', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not has_permission(v_prop, 'event.view') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000000000 then raise exception 'POLICY_VIOLATION: amount must be positive' using errcode = 'P0001'; end if;
  if p_method is null or p_method not in ('cash', 'bank_transfer', 'pos', 'other') then raise exception 'POLICY_VIOLATION: payment method' using errcode = 'P0001'; end if;
  if v_note is not null and length(v_note) > 200 then raise exception 'POLICY_VIOLATION: note' using errcode = 'P0001'; end if;
  if v_pref is not null and length(v_pref) > 80 then raise exception 'POLICY_VIOLATION: reference' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', coalesce(p_booking::text, ''), coalesce(p_order::text, ''), p_amount, p_method, coalesce(v_pref, '')));
  select * into v_idem from idem_begin(v_tenant, 'record_event_payment', p_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  if p_booking is not null then
    select * into b from venue_bookings where id = p_booking for update;
    if b.status not in ('tentative', 'confirmed', 'completed') then raise exception 'INVALID_STATE: %', b.status using errcode = 'P0001'; end if;
    v_paid := venue_booking_paid(p_booking); v_total := b.total_minor;
  else
    perform 1 from ticket_orders where id = p_order for update;
    select status into v_status from ticket_orders where id = p_order;
    if v_status not in ('pending', 'paid') then raise exception 'INVALID_STATE: %', v_status using errcode = 'P0001'; end if;
    v_paid := ticket_order_paid(p_order); v_total := (select total_minor from ticket_orders where id = p_order);
  end if;
  if v_paid + p_amount > v_total then raise exception 'OVERPAYMENT outstanding %', greatest(v_total - v_paid, 0) using errcode = 'P0001'; end if;

  loop
    v_ref := 'EVP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    exit when not exists (select 1 from event_payments where tenant_id = v_tenant and internal_reference = v_ref);
  end loop;
  insert into event_payments (id, tenant_id, property_id, venue_booking_id, ticket_order_id, payment_kind, payment_provider, payment_method,
                              provider_reference, internal_reference, amount_minor, currency, note, recorded_by)
  values (v_id, v_tenant, v_prop, p_booking, p_order, 'payment', 'manual', p_method, v_pref, v_ref, p_amount, v_currency, v_note, v_actor);

  if p_booking is not null then v_status := venue_booking_after_payment(p_booking);
  else v_status := ticket_order_after_payment(p_order); end if;

  v_result := jsonb_build_object('payment_id', v_id, 'reference', v_ref, 'status', v_status);
  perform idem_finish(v_tenant, 'record_event_payment', p_key, v_result);
  perform write_audit(v_tenant, v_prop, v_actor, 'event_payment.recorded', 'event_payment', v_id, p_key,
                      jsonb_build_object('venue_booking_id', p_booking, 'ticket_order_id', p_order, 'amount_minor', p_amount, 'method', p_method, 'status', v_status));
  return v_result;
end $$;
revoke all on function record_event_payment(uuid, uuid, bigint, text, text, text, text) from public, anon;
grant execute on function record_event_payment(uuid, uuid, bigint, text, text, text, text) to authenticated;

-- Money going back: a deposit returned after a cancellation, or a ticket refunded. Needs refund.approve, which the person who takes
-- money does not hold at the front desk. It never exceeds what the booking or order has taken. Provider (card) payments are returned
-- through Paystack by a person; this records that it was done.
create function record_event_refund(p_booking uuid, p_order uuid, p_amount bigint, p_method text, p_reference text, p_note text, p_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_prop uuid; v_tenant uuid; v_currency char(3); v_actor uuid; v_idem record; v_hash text; v_id uuid := gen_random_uuid(); v_ref text; v_paid bigint; v_result jsonb;
  v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_pref text := nullif(btrim(coalesce(p_reference, '')), '');
begin
  if (p_booking is null) = (p_order is null) then raise exception 'POLICY_VIOLATION: target' using errcode = 'P0001'; end if;
  if p_booking is not null then
    select property_id, tenant_id, currency into v_prop, v_tenant, v_currency from venue_bookings where id = p_booking;
  else
    select property_id, tenant_id, currency into v_prop, v_tenant, v_currency from ticket_orders where id = p_order;
  end if;
  if v_prop is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(v_prop, 'refund.approve', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if not has_permission(v_prop, 'event.view') then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000000000 then raise exception 'POLICY_VIOLATION: amount must be positive' using errcode = 'P0001'; end if;
  if p_method is null or p_method not in ('cash', 'bank_transfer', 'pos', 'other', 'card') then raise exception 'POLICY_VIOLATION: payment method' using errcode = 'P0001'; end if;
  if v_note is not null and length(v_note) > 200 then raise exception 'POLICY_VIOLATION: note' using errcode = 'P0001'; end if;
  if v_pref is not null and length(v_pref) > 80 then raise exception 'POLICY_VIOLATION: reference' using errcode = 'P0001'; end if;

  v_hash := md5(concat_ws('|', coalesce(p_booking::text, ''), coalesce(p_order::text, ''), p_amount, p_method, coalesce(v_pref, '')));
  select * into v_idem from idem_begin(v_tenant, 'record_event_refund', p_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  if p_booking is not null then perform 1 from venue_bookings where id = p_booking for update; v_paid := venue_booking_paid(p_booking);
  else perform 1 from ticket_orders where id = p_order for update; v_paid := ticket_order_paid(p_order); end if;
  if p_amount > v_paid then raise exception 'REFUND_EXCEEDS_PAYMENT refundable %', greatest(v_paid, 0) using errcode = 'P0001'; end if;

  loop
    v_ref := 'EVR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    exit when not exists (select 1 from event_payments where tenant_id = v_tenant and internal_reference = v_ref);
  end loop;
  insert into event_payments (id, tenant_id, property_id, venue_booking_id, ticket_order_id, payment_kind, payment_provider, payment_method,
                              provider_reference, internal_reference, amount_minor, currency, note, recorded_by)
  values (v_id, v_tenant, v_prop, p_booking, p_order, 'refund', 'manual', p_method, v_pref, v_ref, p_amount, v_currency, v_note, v_actor);

  v_result := jsonb_build_object('payment_id', v_id, 'reference', v_ref, 'refundable_minor', v_paid - p_amount);
  perform idem_finish(v_tenant, 'record_event_refund', p_key, v_result);
  perform write_audit(v_tenant, v_prop, v_actor, 'event_payment.refunded', 'event_payment', v_id, p_key,
                      jsonb_build_object('venue_booking_id', p_booking, 'ticket_order_id', p_order, 'amount_minor', p_amount, 'method', p_method));
  return v_result;
end $$;
revoke all on function record_event_refund(uuid, uuid, bigint, text, text, text, text) from public, anon;
grant execute on function record_event_refund(uuid, uuid, bigint, text, text, text, text) to authenticated;

-- ---- staff: rooms for the event's guests --------------------------------------------------------------
-- Holds N rooms of a type as block claims for the dates, named after the booking. Needs event.manage and room.block. All or nothing:
-- when fewer rooms are free, ROOM_UNAVAILABLE and nothing is held.
create function create_event_room_block(p_booking uuid, p_room_type uuid, p_rooms integer, p_start date, p_end date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b venue_bookings%rowtype; v_actor uuid; v_claims uuid[] := '{}'; v_claim uuid; v_id uuid; i integer;
begin
  select * into b from venue_bookings where id = p_booking;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(b.property_id, 'event.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(b.property_id, 'room.block', 'NOT_FOUND');
  select * into b from venue_bookings where id = p_booking for update;
  if b.status not in ('tentative', 'confirmed') then raise exception 'INVALID_STATE: %', b.status using errcode = 'P0001'; end if;
  if not exists (select 1 from room_types where id = p_room_type and property_id = b.property_id) then raise exception 'NOT_FOUND: room type' using errcode = 'P0001'; end if;
  if p_rooms is null or p_rooms not between 1 and 50 then raise exception 'POLICY_VIOLATION: rooms' using errcode = 'P0001'; end if;
  if p_start is null or p_end is null or p_start >= p_end or p_end - p_start > 30 then raise exception 'POLICY_VIOLATION: dates' using errcode = 'P0001'; end if;
  if p_start < property_today(b.property_id) then raise exception 'POLICY_VIOLATION: block cannot start in the past' using errcode = 'P0001'; end if;
  if (select count(*) from event_room_blocks where booking_id = b.id and status = 'active') >= 5 then raise exception 'POLICY_VIOLATION: block limit' using errcode = 'P0001'; end if;

  for i in 1..p_rooms loop
    v_claim := claim_room(b.property_id, p_room_type, null, p_start, p_end, 'block', null, null, left('Event ' || b.reference, 200), v_actor);
    v_claims := v_claims || v_claim;
  end loop;
  insert into event_room_blocks (tenant_id, property_id, booking_id, room_type_id, rooms, start_date, end_date, claim_ids, created_by)
  values (b.tenant_id, b.property_id, b.id, p_room_type, p_rooms, p_start, p_end, v_claims, v_actor)
  returning id into v_id;
  perform write_audit(b.tenant_id, b.property_id, v_actor, 'event_room_block.created', 'event_room_block', v_id, null,
                      jsonb_build_object('reference', b.reference, 'rooms', p_rooms, 'start', p_start, 'end', p_end));
  return jsonb_build_object('block_id', v_id);
end $$;
revoke all on function create_event_room_block(uuid, uuid, integer, date, date) from public, anon;
grant execute on function create_event_room_block(uuid, uuid, integer, date, date) to authenticated;

create function release_event_room_block(p_block uuid) returns void
language plpgsql security definer set search_path = public as $$
declare k event_room_blocks%rowtype; v_actor uuid;
begin
  select * into k from event_room_blocks where id = p_block;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(k.property_id, 'event.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(k.property_id, 'room.block', 'NOT_FOUND');
  select * into k from event_room_blocks where id = p_block for update;
  if k.status = 'released' then return; end if;
  update room_inventory_claims set status = 'released' where id = any(k.claim_ids) and status = 'active';
  update event_room_blocks set status = 'released', released_at = now() where id = k.id;
  perform write_audit(k.tenant_id, k.property_id, v_actor, 'event_room_block.released', 'event_room_block', k.id, null, jsonb_build_object('rooms', k.rooms));
end $$;
revoke all on function release_event_room_block(uuid) from public, anon;
grant execute on function release_event_room_block(uuid) to authenticated;

-- Links (or unlinks) a guest's reservation to the event, so staff see who is staying for it.
create function set_event_reservation_link(p_booking uuid, p_reservation uuid, p_linked boolean) returns void
language plpgsql security definer set search_path = public as $$
declare b venue_bookings%rowtype; v_actor uuid; r reservations%rowtype;
begin
  select * into b from venue_bookings where id = p_booking;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(b.property_id, 'event.manage', 'NOT_FOUND');
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(b.property_id, 'reservation.view', 'NOT_FOUND');
  select * into r from reservations where id = p_reservation and property_id = b.property_id;
  if not found then raise exception 'NOT_FOUND: reservation' using errcode = 'P0001'; end if;
  if coalesce(p_linked, true) then
    if (select count(*) from event_reservation_links where booking_id = b.id) >= 200 then raise exception 'POLICY_VIOLATION: link limit' using errcode = 'P0001'; end if;
    insert into event_reservation_links (booking_id, reservation_id, tenant_id, property_id, created_by) values (b.id, r.id, b.tenant_id, b.property_id, v_actor)
    on conflict do nothing;
  else
    delete from event_reservation_links where booking_id = b.id and reservation_id = r.id;
  end if;
  perform write_audit(b.tenant_id, b.property_id, v_actor, case when coalesce(p_linked, true) then 'event_reservation.linked' else 'event_reservation.unlinked' end,
                      'venue_booking', b.id, null, jsonb_build_object('reference', b.reference, 'booking_reference', r.booking_reference));
end $$;
revoke all on function set_event_reservation_link(uuid, uuid, boolean) from public, anon;
grant execute on function set_event_reservation_link(uuid, uuid, boolean) to authenticated;

-- ---- backstop sweep -----------------------------------------------------------------------------------
create function expire_lapsed_event_holds() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not is_system_caller() then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  update venue_bookings set status = 'expired' where status = 'tentative' and hold_expires_at <= now();
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function expire_lapsed_event_holds() from public, anon, authenticated;
grant execute on function expire_lapsed_event_holds() to service_role;
