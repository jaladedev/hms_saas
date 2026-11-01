-- 026 Maintenance requests: something is broken, who is fixing it, and what was done.
--
-- A request is a record of a fault (a leaking tap in 204, the lift, the generator). It is NOT a room restriction:
--   * opening, working on, resolving or cancelling a request never changes a room's status or its availability;
--   * a request can point at a room block (room_inventory_claims, claim_type 'block') to say "this room is out of
--     sale because of this". Resolving the request does not release that block. Whoever holds room.block decides
--     when the room goes back on sale, because another restriction may still apply (UI spec, page 27).
--     resolve_maintenance_request says whether a linked block is still active so the screen can tell the person.
--
-- Who can do what:
--   * maintenance.view (new: owner, general manager, front desk, housekeeping, maintenance): read all requests at the
--     property and report a new one. Housekeepers and front desk see faults first, so they are the people reporting.
--   * maintenance.manage (already existed: owner, general manager, maintenance): everything else. Give a request to
--     someone, take it, start it, resolve it, cancel it, change its priority, link a block.
--   Clients read under row-level security and change data only through the functions below. Rows are never deleted,
--   and a resolved or cancelled row never changes again. A request holds a room number or a place and some words, never
--   a guest or a price, so everyone who may view maintenance may read all of its requests.
--   Every function here touches only the request row (a block is only read), so there is no lock order to keep.

-- ---- a permission to see and report ------------------------------------------------------
insert into permissions (key) values ('maintenance.view');
insert into role_permissions (role_id, permission_id)
select r.id, p.id
  from roles r, permissions p
 where p.key = 'maintenance.view'
   and r.key in ('owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance');

-- ---- table -------------------------------------------------------------------------------
create table maintenance_requests (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  property_id     uuid not null,
  room_id         uuid,              -- null for a fault that is not in a room (lobby, lift, generator): then location is set
  location        text check (location is null or length(location) between 1 and 100),
  title           text not null check (length(title) between 1 and 120),
  description     text check (description is null or length(description) <= 2000),
  priority        text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status          text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'cancelled')),
  assigned_to     uuid references auth.users (id) on delete set null,
  due_at          timestamptz,
  room_block_id   uuid references room_inventory_claims (id),
  reported_by     uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  resolved_at     timestamptz,
  resolved_by     uuid references auth.users (id) on delete set null,
  resolution_note text check (resolution_note is null or length(resolution_note) <= 1000),
  cancelled_at    timestamptz,
  cancel_reason   text check (cancel_reason is null or length(cancel_reason) <= 200),
  updated_at      timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  foreign key (tenant_id, property_id, room_id) references rooms (tenant_id, property_id, id),
  check (room_id is not null or location is not null),
  check ((status = 'resolved') = (resolved_at is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check (status <> 'cancelled' or cancel_reason is not null),
  check (status <> 'open' or started_at is null),
  check (status not in ('in_progress', 'resolved') or started_at is not null),
  check (room_block_id is null or room_id is not null)
);

-- The dashboard (spec: property, status, priority), a room's history, and "my requests".
create index on maintenance_requests (property_id, status, priority);
create index on maintenance_requests (room_id, created_at desc) where room_id is not null;
create index on maintenance_requests (assigned_to, status) where status in ('open', 'in_progress');
create index on maintenance_requests (room_block_id) where room_block_id is not null;

create trigger maintenance_requests_updated before update on maintenance_requests
  for each row execute function set_updated_at();

-- Requests are history. Nothing is deleted, the place a request belongs to never changes, and a resolved or
-- cancelled request is frozen. The one exception is a person's id becoming null when their login is deleted
-- (the foreign keys above do that with an update).
create function maintenance_requests_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'maintenance_requests rows are kept as history' using errcode = '23514';
  end if;
  if new.tenant_id <> old.tenant_id or new.property_id <> old.property_id
     or new.room_id is distinct from old.room_id or new.location is distinct from old.location
     or new.created_at <> old.created_at then
    raise exception 'maintenance request place cannot change' using errcode = '23514';
  end if;
  if old.status in ('resolved', 'cancelled')
     and (to_jsonb(new) - 'updated_at' - 'assigned_to' - 'reported_by' - 'resolved_by')
         is distinct from (to_jsonb(old) - 'updated_at' - 'assigned_to' - 'reported_by' - 'resolved_by') then
    raise exception 'a finished maintenance request cannot change' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger maintenance_requests_guard_trg before update or delete on maintenance_requests
  for each row execute function maintenance_requests_guard();

revoke all on function maintenance_requests_guard() from public, anon, authenticated;

-- ---- row-level security ------------------------------------------------------------------
alter table maintenance_requests enable row level security;

create policy maintenance_requests_select on maintenance_requests for select to authenticated
  using (has_permission(property_id, 'maintenance.view') or has_permission(property_id, 'maintenance.manage'));

revoke insert, update, delete on maintenance_requests from authenticated, anon;

-- ---- internal helper ---------------------------------------------------------------------
create function mt_request_json(r maintenance_requests) returns jsonb language sql immutable as $$
  select jsonb_build_object('request_id', r.id, 'room_id', r.room_id, 'status', r.status, 'priority', r.priority,
                            'assigned_to', r.assigned_to, 'room_block_id', r.room_block_id)
$$;
revoke all on function mt_request_json(maintenance_requests) from public, anon, authenticated;
-- (hk_require and hk_user_can from 023 are generic: they check a permission for the caller, or for another user.)

-- ---- functions clients call --------------------------------------------------------------
-- Errors: NOT_FOUND (no such request, no permission, or another hotel: they look the same), FORBIDDEN (the caller can
-- see the request but may not do this), POLICY_VIOLATION (bad input), INVALID_STATE (the request is not in a state
-- that allows it). Repeating an action that already happened answers with the current request and writes nothing.

-- Report a fault. A room or a place is needed. The idempotency key makes a double tap on "Report" one request.
-- Setting a due time or an assignee at the start needs maintenance.manage.
create function report_maintenance_request(
  p_property_id     uuid,
  p_room_id         uuid,
  p_location        text,
  p_title           text,
  p_description     text,
  p_priority        text,
  p_due_at          timestamptz,
  p_assigned_to     uuid,
  p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  prop properties%rowtype; rm rooms%rowtype; r maintenance_requests%rowtype; v_actor uuid; v_idem record; v_hash text;
  v_location text := nullif(btrim(p_location), ''); v_title text := btrim(p_title);
  v_desc text := nullif(btrim(p_description), ''); v_result jsonb;
begin
  select * into prop from properties where id = p_property_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := hk_require(prop.id, 'maintenance.view');

  if v_title is null or length(v_title) not between 1 and 120 then raise exception 'POLICY_VIOLATION: title' using errcode = 'P0001'; end if;
  if length(v_desc) > 2000 then raise exception 'POLICY_VIOLATION: description too long' using errcode = 'P0001'; end if;
  if length(v_location) > 100 then raise exception 'POLICY_VIOLATION: location too long' using errcode = 'P0001'; end if;
  if p_priority is null or p_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'POLICY_VIOLATION: priority' using errcode = 'P0001';
  end if;
  if p_room_id is null and v_location is null then raise exception 'POLICY_VIOLATION: a room or a place is needed' using errcode = 'P0001'; end if;
  if p_room_id is not null then
    select * into rm from rooms where id = p_room_id and property_id = prop.id;
    if not found then raise exception 'POLICY_VIOLATION: room' using errcode = 'P0001'; end if;
  end if;
  if p_due_at is not null or p_assigned_to is not null then
    if not has_permission(prop.id, 'maintenance.manage') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  end if;
  if p_assigned_to is not null and not hk_user_can(p_assigned_to, prop.id, 'maintenance.manage') then
    raise exception 'POLICY_VIOLATION: assignee' using errcode = 'P0001';
  end if;

  v_hash := md5(concat_ws('|', p_property_id, p_room_id, v_location, v_title, v_desc, p_priority, p_due_at, p_assigned_to));
  select * into v_idem from idem_begin(prop.tenant_id, 'report_maintenance_request', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  insert into maintenance_requests (tenant_id, property_id, room_id, location, title, description, priority, due_at, assigned_to, reported_by)
  values (prop.tenant_id, prop.id, p_room_id, v_location, v_title, v_desc, p_priority, p_due_at, p_assigned_to, v_actor)
  returning * into r;
  v_result := mt_request_json(r);
  perform idem_finish(prop.tenant_id, 'report_maintenance_request', p_idempotency_key, v_result);
  perform write_audit(prop.tenant_id, prop.id, v_actor, 'maintenance.request_created', 'maintenance_request', r.id, p_idempotency_key,
                      jsonb_build_object('room_id', r.room_id, 'location', r.location, 'priority', r.priority, 'assigned_to', r.assigned_to));
  return v_result;
end $$;

-- Take an unassigned request for yourself.
create function claim_maintenance_request(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r maintenance_requests%rowtype; v_actor uuid;
begin
  select * into r from maintenance_requests where id = p_request_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := hk_require(r.property_id, 'maintenance.manage');

  select * into r from maintenance_requests where id = p_request_id for update;
  if r.status not in ('open', 'in_progress') then raise exception 'INVALID_STATE: request %', r.status using errcode = 'P0001'; end if;
  if r.assigned_to = v_actor then return mt_request_json(r); end if;
  if r.assigned_to is not null then raise exception 'FORBIDDEN: assigned to someone else' using errcode = 'P0001'; end if;

  update maintenance_requests set assigned_to = v_actor where id = r.id returning * into r;
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'maintenance.request_assigned', 'maintenance_request', r.id, null,
                      jsonb_build_object('from', null, 'to', v_actor, 'claimed', true));
  return mt_request_json(r);
end $$;

-- Give a request to someone, or take it back (null). The person must hold maintenance.manage at the property.
create function assign_maintenance_request(p_request_id uuid, p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r maintenance_requests%rowtype; v_actor uuid; v_from uuid;
begin
  select * into r from maintenance_requests where id = p_request_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := hk_require(r.property_id, 'maintenance.manage');
  if p_user_id is not null and not hk_user_can(p_user_id, r.property_id, 'maintenance.manage') then
    raise exception 'POLICY_VIOLATION: assignee' using errcode = 'P0001';
  end if;

  select * into r from maintenance_requests where id = p_request_id for update;
  if r.status not in ('open', 'in_progress') then raise exception 'INVALID_STATE: request %', r.status using errcode = 'P0001'; end if;
  if r.assigned_to is not distinct from p_user_id then return mt_request_json(r); end if;

  v_from := r.assigned_to;
  update maintenance_requests set assigned_to = p_user_id where id = r.id returning * into r;
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'maintenance.request_assigned', 'maintenance_request', r.id, null,
                      jsonb_build_object('from', v_from, 'to', p_user_id));
  return mt_request_json(r);
end $$;

-- Start work. Takes the request for the caller when nobody has it.
create function start_maintenance_request(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r maintenance_requests%rowtype; v_actor uuid;
begin
  select * into r from maintenance_requests where id = p_request_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := hk_require(r.property_id, 'maintenance.manage');

  select * into r from maintenance_requests where id = p_request_id for update;
  if r.status in ('resolved', 'cancelled') then raise exception 'INVALID_STATE: request %', r.status using errcode = 'P0001'; end if;
  if r.status = 'in_progress' then return mt_request_json(r); end if;

  update maintenance_requests set status = 'in_progress', started_at = now(), assigned_to = coalesce(assigned_to, v_actor)
   where id = r.id returning * into r;
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'maintenance.request_started', 'maintenance_request', r.id, null,
                      jsonb_build_object('assigned_to', r.assigned_to));
  return mt_request_json(r);
end $$;

-- Mark it fixed, with an optional note. Never releases a linked room block: the answer says whether one is still active.
create function resolve_maintenance_request(p_request_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r maintenance_requests%rowtype; v_actor uuid; v_note text := nullif(btrim(p_note), ''); v_block_active boolean := false;
begin
  select * into r from maintenance_requests where id = p_request_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := hk_require(r.property_id, 'maintenance.manage');
  if length(v_note) > 1000 then raise exception 'POLICY_VIOLATION: note too long' using errcode = 'P0001'; end if;

  select * into r from maintenance_requests where id = p_request_id for update;
  if r.status = 'cancelled' then raise exception 'INVALID_STATE: request cancelled' using errcode = 'P0001'; end if;
  if r.status = 'resolved' then
    -- repeating is a no-op, but the block may have been released since: report it as it stands now
    select exists (select 1 from room_inventory_claims c where c.id = r.room_block_id and c.status = 'active' and c.end_date > property_today(r.property_id))
      into v_block_active;
    return mt_request_json(r) || jsonb_build_object('block_still_active', v_block_active);
  end if;

  update maintenance_requests
     set status = 'resolved', started_at = coalesce(started_at, now()), resolved_at = now(), resolved_by = v_actor,
         resolution_note = v_note, assigned_to = coalesce(assigned_to, v_actor)
   where id = r.id returning * into r;
  select exists (select 1 from room_inventory_claims c where c.id = r.room_block_id and c.status = 'active' and c.end_date > property_today(r.property_id))
    into v_block_active;
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'maintenance.request_resolved', 'maintenance_request', r.id, null,
                      jsonb_build_object('room_id', r.room_id, 'block_still_active', v_block_active));
  return mt_request_json(r) || jsonb_build_object('block_still_active', v_block_active);
end $$;

-- Call a request off (reported by mistake, a duplicate, fixed on its own), with a reason.
create function cancel_maintenance_request(p_request_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r maintenance_requests%rowtype; v_actor uuid; v_reason text := nullif(btrim(p_reason), '');
begin
  select * into r from maintenance_requests where id = p_request_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := hk_require(r.property_id, 'maintenance.manage');
  if v_reason is null or length(v_reason) > 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;

  select * into r from maintenance_requests where id = p_request_id for update;
  if r.status = 'cancelled' then return mt_request_json(r); end if;
  if r.status = 'resolved' then raise exception 'INVALID_STATE: request resolved' using errcode = 'P0001'; end if;

  update maintenance_requests set status = 'cancelled', cancelled_at = now(), cancel_reason = v_reason
   where id = r.id returning * into r;
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'maintenance.request_cancelled', 'maintenance_request', r.id, null,
                      jsonb_build_object('reason', v_reason));
  return mt_request_json(r);
end $$;

-- Raise or lower the priority of an open request.
create function set_maintenance_priority(p_request_id uuid, p_priority text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r maintenance_requests%rowtype; v_actor uuid; v_from text;
begin
  select * into r from maintenance_requests where id = p_request_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := hk_require(r.property_id, 'maintenance.manage');
  if p_priority is null or p_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'POLICY_VIOLATION: priority' using errcode = 'P0001';
  end if;

  select * into r from maintenance_requests where id = p_request_id for update;
  if r.status not in ('open', 'in_progress') then raise exception 'INVALID_STATE: request %', r.status using errcode = 'P0001'; end if;
  if r.priority = p_priority then return mt_request_json(r); end if;

  v_from := r.priority;
  update maintenance_requests set priority = p_priority where id = r.id returning * into r;
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'maintenance.priority_set', 'maintenance_request', r.id, null,
                      jsonb_build_object('from', v_from, 'to', p_priority));
  return mt_request_json(r);
end $$;

-- Point the request at the room block that took the room out of sale because of it, or clear the link (null).
-- The block must be one of this room's blocks. This only records the link: it neither creates nor releases a block
-- (that needs room.block, through create_room_block and release_room_block).
create function link_maintenance_block(p_request_id uuid, p_block_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r maintenance_requests%rowtype; v_actor uuid; v_from uuid;
begin
  select * into r from maintenance_requests where id = p_request_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := hk_require(r.property_id, 'maintenance.manage');
  if p_block_id is not null then
    if r.room_id is null then raise exception 'POLICY_VIOLATION: a request with no room has no block' using errcode = 'P0001'; end if;
    if not exists (select 1 from room_inventory_claims c
                    where c.id = p_block_id and c.claim_type = 'block' and c.room_id = r.room_id and c.property_id = r.property_id) then
      raise exception 'POLICY_VIOLATION: block' using errcode = 'P0001';
    end if;
  end if;

  select * into r from maintenance_requests where id = p_request_id for update;
  if r.status not in ('open', 'in_progress') then raise exception 'INVALID_STATE: request %', r.status using errcode = 'P0001'; end if;
  if r.room_block_id is not distinct from p_block_id then return mt_request_json(r); end if;

  v_from := r.room_block_id;
  update maintenance_requests set room_block_id = p_block_id where id = r.id returning * into r;
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'maintenance.block_linked', 'maintenance_request', r.id, null,
                      jsonb_build_object('from', v_from, 'to', p_block_id));
  return mt_request_json(r);
end $$;

-- The people a request can be given to at a property, for the assignment picker.
create function list_maintenance_staff(p_property uuid) returns table (user_id uuid, full_name text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform hk_require(p_property, 'maintenance.manage');
  return query
    select distinct m.user_id, coalesce(nullif(btrim(up.full_name), ''), u.email, 'Unnamed')
      from tenant_memberships m
      join properties pr on pr.id = p_property and pr.tenant_id = m.tenant_id
      join auth.users u on u.id = m.user_id
      left join user_profiles up on up.id = m.user_id
     where m.status = 'active' and hk_user_can(m.user_id, p_property, 'maintenance.manage')
     order by 2, 1;
end $$;

revoke all on function
  report_maintenance_request(uuid, uuid, text, text, text, text, timestamptz, uuid, text),
  claim_maintenance_request(uuid), assign_maintenance_request(uuid, uuid), start_maintenance_request(uuid),
  resolve_maintenance_request(uuid, text), cancel_maintenance_request(uuid, text),
  set_maintenance_priority(uuid, text), link_maintenance_block(uuid, uuid), list_maintenance_staff(uuid)
  from public, anon;
grant execute on function
  report_maintenance_request(uuid, uuid, text, text, text, text, timestamptz, uuid, text),
  claim_maintenance_request(uuid), assign_maintenance_request(uuid, uuid), start_maintenance_request(uuid),
  resolve_maintenance_request(uuid, text), cancel_maintenance_request(uuid, text),
  set_maintenance_priority(uuid, text), link_maintenance_block(uuid, uuid), list_maintenance_staff(uuid)
  to authenticated;
