-- 003 Room inventory: room types and physical rooms.

create table room_types (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  property_id    uuid not null,
  name           text not null,
  code           text not null,
  slug           text not null,
  description    text,
  bed_config     jsonb not null default '[]'::jsonb,
  max_adults     smallint not null check (max_adults > 0),
  max_children   smallint not null default 0 check (max_children >= 0),
  max_occupancy  smallint not null check (max_occupancy > 0),
  base_rate_minor bigint not null check (base_rate_minor >= 0),
  currency       char(3) not null default 'NGN',
  is_public      boolean not null default true,
  status         text not null default 'active' check (status in ('active','inactive')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  unique (tenant_id, property_id, id),
  unique (property_id, code),
  unique (property_id, slug),
  check (max_occupancy <= max_adults + max_children)
);

create table rooms (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  property_id        uuid not null,
  room_type_id       uuid not null,
  room_number        text not null,
  floor              smallint,
  operational_status text not null default 'active'
                     check (operational_status in ('active','out_of_service','retired')),
  housekeeping_status text not null default 'clean'
                     check (housekeeping_status in ('clean','dirty','in_progress','inspected')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  foreign key (tenant_id, property_id, room_type_id) references room_types (tenant_id, property_id, id),
  unique (tenant_id, property_id, id),
  unique (property_id, room_number)
);

create trigger room_types_updated before update on room_types for each row execute function set_updated_at();
create trigger rooms_updated before update on rooms for each row execute function set_updated_at();

create index on rooms (property_id, room_type_id, operational_status);

alter table room_types enable row level security;
alter table rooms      enable row level security;

create policy room_types_select on room_types for select to authenticated
  using (has_permission(property_id, 'reservation.view')
      or has_permission(property_id, 'rate.view')
      or has_permission(property_id, 'property.configure'));
-- room_types carries base rates, so housekeeping and maintenance do not read it directly;
-- they get a purpose-built room board view later (see System Design section 6.2).
create policy room_types_write on room_types for all to authenticated
  using (has_permission(property_id, 'property.configure'))
  with check (has_permission(property_id, 'property.configure'));

create policy rooms_select on rooms for select to authenticated
  using (has_permission(property_id, 'room.view'));
create policy rooms_write on rooms for all to authenticated
  using (has_permission(property_id, 'property.configure'))
  with check (has_permission(property_id, 'property.configure'));

-- Rooms and room types are never hard-deleted by clients once referenced.
revoke delete on room_types, rooms from authenticated, anon;
