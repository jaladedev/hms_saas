-- 004 Inventory claims: stays, holds and blocks share one table so one exclusion
-- constraint prevents any overlap on a room. See HMS System Design, section 3.
-- reservation_room_id has no foreign key yet; it is added when reservation_rooms exists.

create table room_inventory_claims (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  property_id         uuid not null,
  room_id             uuid not null,
  claim_type          text not null check (claim_type in ('stay','hold','block')),
  status              text not null default 'active' check (status in ('active','released','expired')),
  start_date          date not null,
  end_date            date not null,          -- exclusive: the departure day stays free
  reservation_room_id uuid,
  hold_expires_at     timestamptz,
  block_reason        text,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (start_date < end_date),
  check (claim_type <> 'hold'  or hold_expires_at is not null),
  check (claim_type <> 'block' or block_reason is not null),
  check (claim_type = 'block' or reservation_room_id is not null),
  foreign key (tenant_id, property_id, room_id) references rooms (tenant_id, property_id, id),

  constraint no_room_overlap exclude using gist (
    room_id with =,
    daterange(start_date, end_date, '[)') with &&
  ) where (status = 'active'),

  constraint no_self_overlap exclude using gist (
    reservation_room_id with =,
    daterange(start_date, end_date, '[)') with &&
  ) where (status = 'active' and claim_type in ('stay','hold'))
);

create trigger claims_updated before update on room_inventory_claims
  for each row execute function set_updated_at();

create index on room_inventory_claims (property_id, start_date) where status = 'active';
create index on room_inventory_claims (reservation_room_id) where reservation_room_id is not null;

alter table room_inventory_claims enable row level security;

create policy claims_select on room_inventory_claims for select to authenticated
  using (has_permission(property_id, 'room.view'));
-- Writes only through the functions below and the operation functions that call them.
revoke insert, update, delete on room_inventory_claims from authenticated, anon;

-- Mark overlapping holds whose time has passed as expired, inside the caller's transaction.
create function release_expired_holds(p_property_id uuid, p_start date, p_end date)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update room_inventory_claims
     set status = 'expired'
   where property_id = p_property_id
     and claim_type = 'hold' and status = 'active'
     and hold_expires_at <= now()
     and daterange(start_date, end_date, '[)') && daterange(p_start, p_end, '[)');
  get diagnostics n = row_count;
  return n;
end $$;

-- Claim one room for a date range. Picks the first free active room of the type (or the
-- requested room). The exclusion constraint is the referee: if another transaction wins
-- the room, try the next candidate. Raises ROOM_UNAVAILABLE when none can be claimed.
create function claim_room(
  p_property_id         uuid,
  p_room_type_id        uuid,
  p_requested_room_id   uuid,
  p_start               date,
  p_end                 date,
  p_claim_type          text,
  p_reservation_room_id uuid,
  p_hold_expires_at     timestamptz default null,
  p_block_reason        text default null,
  p_created_by          uuid default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_room   record;
  v_id     uuid;
begin
  select tenant_id into v_tenant from properties where id = p_property_id;
  if v_tenant is null then
    raise exception 'NOT_FOUND: property' using errcode = 'P0002';
  end if;

  perform release_expired_holds(p_property_id, p_start, p_end);

  for v_room in
    select r.id from rooms r
     where r.property_id = p_property_id
       and (p_room_type_id is null or r.room_type_id = p_room_type_id)
       and (p_requested_room_id is null or r.id = p_requested_room_id)
       and r.operational_status = 'active'
       and not exists (
         select 1 from room_inventory_claims c
          where c.room_id = r.id and c.status = 'active'
            and daterange(c.start_date, c.end_date, '[)') && daterange(p_start, p_end, '[)'))
     order by r.room_number
  loop
    begin
      insert into room_inventory_claims
        (tenant_id, property_id, room_id, claim_type, start_date, end_date,
         reservation_room_id, hold_expires_at, block_reason, created_by)
      values
        (v_tenant, p_property_id, v_room.id, p_claim_type, p_start, p_end,
         p_reservation_room_id, p_hold_expires_at, p_block_reason, p_created_by)
      returning id into v_id;
      return v_id;
    exception when exclusion_violation then
      continue;   -- another transaction took this room first
    end;
  end loop;

  raise exception 'ROOM_UNAVAILABLE' using errcode = 'P0001';
end $$;

revoke all on function release_expired_holds(uuid, date, date) from public, anon, authenticated;
revoke all on function claim_room(uuid, uuid, uuid, date, date, text, uuid, timestamptz, text, uuid)
  from public, anon, authenticated;
