-- 006 Guests and reservations: guests, reservations, reservation_rooms, reservation_nights,
-- the claims foreign key, and the deferred tiling check. Reservation writes happen only in
-- operation functions (see 007); client roles can read according to permission.

create function has_tenant_permission(p_tenant uuid, p_permission text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from tenant_memberships m
      join membership_roles mr on mr.membership_id = m.id
      join role_permissions rp on rp.role_id = mr.role_id
      join permissions p on p.id = rp.permission_id
     where m.user_id = (select auth.uid()) and m.tenant_id = p_tenant
       and m.status = 'active' and p.key = p_permission
  )
$$;
revoke all on function has_tenant_permission(uuid, text) from public;
grant execute on function has_tenant_permission(uuid, text) to authenticated;

create table guests (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id),
  full_name    text not null check (length(trim(full_name)) > 0),
  email        text,
  phone        text,
  address      text,
  country_code char(2),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id)
);
create index on guests (tenant_id, lower(full_name));

create table reservations (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  property_id       uuid not null,
  booking_reference text not null,
  primary_guest_id  uuid not null,
  source            text not null check (source in ('website','walk_in','phone','staff_entry','partner')),
  reservation_status text not null default 'pending'
    check (reservation_status in ('pending','confirmed','checked_in','checked_out','cancelled','no_show','expired')),
  payment_status    text not null default 'unpaid'
    check (payment_status in ('unpaid','partially_paid','paid','partially_refunded','refunded','payment_failed')),
  arrival_date      date not null,
  departure_date    date not null,
  currency          char(3) not null default 'NGN',
  subtotal_minor    bigint not null default 0 check (subtotal_minor >= 0),
  tax_minor         bigint not null default 0 check (tax_minor >= 0),
  discount_minor    bigint not null default 0 check (discount_minor >= 0),
  total_minor       bigint not null default 0 check (total_minor >= 0),
  policy_snapshot   jsonb not null default '{}'::jsonb,
  attention_reason  text,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  cancelled_at      timestamptz,
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  foreign key (tenant_id, primary_guest_id) references guests (tenant_id, id),
  unique (tenant_id, booking_reference),
  unique (tenant_id, property_id, id),
  check (departure_date > arrival_date),
  check (total_minor = subtotal_minor + tax_minor - discount_minor)
);
create index on reservations (property_id, arrival_date, departure_date);
create index on reservations (property_id, reservation_status, arrival_date);

create table reservation_rooms (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  property_id      uuid not null,
  reservation_id   uuid not null,
  room_type_id     uuid not null,
  requested_room_id uuid,
  rate_plan_id     uuid not null,
  adults           smallint not null check (adults >= 1),
  children         smallint not null default 0 check (children >= 0),
  room_status      text not null default 'booked'
    check (room_status in ('booked','checked_in','checked_out','cancelled')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (tenant_id, property_id, reservation_id) references reservations (tenant_id, property_id, id),
  foreign key (tenant_id, property_id, room_type_id) references room_types (tenant_id, property_id, id),
  foreign key (tenant_id, property_id, requested_room_id) references rooms (tenant_id, property_id, id),
  foreign key (tenant_id, property_id, rate_plan_id) references rate_plans (tenant_id, property_id, id),
  unique (id)
);
create index on reservation_rooms (reservation_id);

create table reservation_nights (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id),
  reservation_room_id uuid not null references reservation_rooms(id),
  night_date          date not null,
  rate_minor          bigint not null check (rate_minor > 0),
  tax_minor           bigint not null default 0 check (tax_minor >= 0),
  rate_source         text not null,
  unique (reservation_room_id, night_date)
);

create trigger guests_updated before update on guests for each row execute function set_updated_at();
create trigger reservations_updated before update on reservations for each row execute function set_updated_at();
create trigger reservation_rooms_updated before update on reservation_rooms for each row execute function set_updated_at();

-- Claims now point at real reservation rooms.
alter table room_inventory_claims
  add constraint claims_reservation_room_fk foreign key (reservation_room_id)
  references reservation_rooms (id);

-- Tiling: a reservation room's active stay/hold claims must cover [arrival, departure) exactly.
-- Overlaps are already impossible (no_self_overlap), so equal total length plus matching
-- first and last dates proves there are no gaps. Checked at commit so a transfer may shrink
-- one claim and add another in the same transaction.
create function check_claim_tiling() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_arr date; v_dep date; v_nights integer; v_min date; v_max date; v_cnt integer;
begin
  if new.reservation_room_id is null or new.claim_type = 'block' then return null; end if;
  select count(*), coalesce(sum(end_date - start_date), 0), min(start_date), max(end_date)
    into v_cnt, v_nights, v_min, v_max
    from room_inventory_claims
   where reservation_room_id = new.reservation_room_id
     and status = 'active' and claim_type in ('stay','hold');
  if v_cnt = 0 then return null; end if;          -- fully released or expired: fine
  select r.arrival_date, r.departure_date into v_arr, v_dep
    from reservation_rooms rr join reservations r on r.id = rr.reservation_id
   where rr.id = new.reservation_room_id;
  if v_min <> v_arr or v_max <> v_dep or v_nights <> (v_dep - v_arr) then
    raise exception 'CLAIM_TILING: claims for reservation room % do not cover % to %',
      new.reservation_room_id, v_arr, v_dep using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger claims_tiling after insert or update on room_inventory_claims
  deferrable initially deferred for each row execute function check_claim_tiling();

-- RLS: reads by permission, writes only through operation functions.
alter table guests            enable row level security;
alter table reservations      enable row level security;
alter table reservation_rooms enable row level security;
alter table reservation_nights enable row level security;

create policy guests_select on guests for select to authenticated
  using (has_tenant_permission(tenant_id, 'guest.view'));
create policy guests_insert on guests for insert to authenticated
  with check (has_tenant_permission(tenant_id, 'guest.manage'));
create policy guests_update on guests for update to authenticated
  using (has_tenant_permission(tenant_id, 'guest.manage'))
  with check (has_tenant_permission(tenant_id, 'guest.manage'));

create policy reservations_select on reservations for select to authenticated
  using (has_permission(property_id, 'reservation.view'));
create policy reservation_rooms_select on reservation_rooms for select to authenticated
  using (has_permission(property_id, 'reservation.view'));
create policy reservation_nights_select on reservation_nights for select to authenticated
  using (exists (select 1 from reservation_rooms rr
                  where rr.id = reservation_room_id and has_permission(rr.property_id, 'reservation.view')));

revoke insert, update, delete on reservations, reservation_rooms, reservation_nights from authenticated, anon;
revoke delete on guests from authenticated, anon;
