-- 023 Housekeeping tasks: who cleans which room, in what order, and what was done.
--
-- Until now cleaning was only a status on the room (018). This adds task records on top of it:
--   * a task per room to clean, with priority, an optional due time and an optional assignee;
--   * history: every task keeps its own timestamps, and every change is written to audit_logs.
--
-- How tasks and the room status fit together (the room status stays the source of truth for "is it ready"):
--   * a room becoming dirty (check_out does this, so does set_housekeeping_status) opens a 'cleaning' task,
--     at priority 'high' when a guest is due to arrive in that room today. A room has at most one live
--     task of each type, so a repeated check or tap never piles up duplicates.
--   * the room going to in_progress starts the open cleaning task; going to clean or inspected completes it.
--   * the room being retired cancels its live tasks.
--   * completing a cleaning task through complete_housekeeping_task sets the room to clean. That touches the
--     cleaning status only: occupancy and availability live in room_inventory_claims and are never changed here.
--   Other task types (deep_clean, inspection, other) are tracked but have no effect on the room status.
--
-- Clients read tasks under row-level security and change them only through the functions below. Rows are never
-- deleted, and a finished or cancelled row never changes again. Functions that touch both a room and its tasks
-- lock the room first (the same order the room trigger takes), so they cannot deadlock one another.

-- ---- a permission to hand out work -------------------------------------------------------
-- housekeeping.update (everyone who cleans, plus front desk) is enough to start and finish work and to claim an
-- unassigned task. Giving a task to someone else, creating one for someone else and cancelling one needs
-- housekeeping.assign: the owner, general manager and front desk.
insert into permissions (key) values ('housekeeping.assign');
insert into role_permissions (role_id, permission_id)
select r.id, p.id
  from roles r, permissions p
 where p.key = 'housekeeping.assign' and r.key in ('owner', 'general_manager', 'front_desk');

-- ---- table -------------------------------------------------------------------------------
create table housekeeping_tasks (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  property_id     uuid not null,
  room_id         uuid not null,
  task_type       text not null default 'cleaning' check (task_type in ('cleaning', 'deep_clean', 'inspection', 'other')),
  status          text not null default 'open' check (status in ('open', 'in_progress', 'done', 'cancelled')),
  priority        text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  assigned_to     uuid references auth.users (id) on delete set null,
  due_at          timestamptz,
  notes           text check (notes is null or length(notes) <= 500),
  completion_note text check (completion_note is null or length(completion_note) <= 500),
  cancel_reason   text check (cancel_reason is null or length(cancel_reason) <= 200),
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  completed_at    timestamptz,
  completed_by    uuid references auth.users (id) on delete set null,
  cancelled_at    timestamptz,
  updated_at      timestamptz not null default now(),
  foreign key (tenant_id, property_id) references properties (tenant_id, id),
  foreign key (tenant_id, property_id, room_id) references rooms (tenant_id, property_id, id),
  check ((status = 'done') = (completed_at is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check (status <> 'cancelled' or cancel_reason is not null),
  check (status <> 'open' or started_at is null),
  check (status not in ('in_progress', 'done') or started_at is not null)
);

-- The to-do list (spec: property, status, due time), a room's history, and "my tasks".
create index on housekeeping_tasks (property_id, status, due_at);
create index on housekeeping_tasks (room_id, created_at desc);
create index on housekeeping_tasks (assigned_to, status) where status in ('open', 'in_progress');
-- One live task per room and type (except 'other', where several notes for one room are fine).
create unique index housekeeping_tasks_one_live on housekeeping_tasks (room_id, task_type)
  where status in ('open', 'in_progress') and task_type <> 'other';

create trigger housekeeping_tasks_updated before update on housekeeping_tasks
  for each row execute function set_updated_at();

-- Tasks are history. Nothing is deleted, the place a task belongs to never changes, and a finished or
-- cancelled task is frozen. The one exception is a person's id becoming null when their login is deleted
-- (the foreign keys above do that with an update).
create function housekeeping_tasks_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'housekeeping_tasks rows are kept as history' using errcode = '23514';
  end if;
  if new.tenant_id <> old.tenant_id or new.property_id <> old.property_id or new.room_id <> old.room_id
     or new.task_type <> old.task_type or new.created_at <> old.created_at then
    raise exception 'housekeeping task place and type cannot change' using errcode = '23514';
  end if;
  if old.status in ('done', 'cancelled')
     and (to_jsonb(new) - 'updated_at' - 'assigned_to' - 'created_by' - 'completed_by')
         is distinct from (to_jsonb(old) - 'updated_at' - 'assigned_to' - 'created_by' - 'completed_by') then
    raise exception 'a finished housekeeping task cannot change' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger housekeeping_tasks_guard_trg before update or delete on housekeeping_tasks
  for each row execute function housekeeping_tasks_guard();

-- ---- row-level security ------------------------------------------------------------------
-- A task names a room and a person, never a guest, a booking or a price, so everyone who may see housekeeping
-- at the property may read all its tasks. Writes go through the functions below only.
alter table housekeeping_tasks enable row level security;

create policy housekeeping_tasks_select on housekeeping_tasks for select to authenticated
  using (has_permission(property_id, 'housekeeping.view'));

revoke insert, update, delete on housekeeping_tasks from authenticated, anon;

-- ---- internal helpers (not callable by clients) ------------------------------------------
-- Like require_permission, but a task action always needs a signed-in person (it records who did it).
create function hk_require(p_property uuid, p_permission text, p_deny_as text default 'NOT_FOUND') returns uuid
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := require_permission(p_property, p_permission, p_deny_as);
begin
  if v_actor is null then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  return v_actor;
end $$;

-- Whether some other user holds a permission at a property (has_permission only answers for the caller).
create function hk_user_can(p_user uuid, p_property uuid, p_permission text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from tenant_memberships m
      join membership_roles mr on mr.membership_id = m.id
      join role_permissions rp on rp.role_id = mr.role_id
      join permissions p on p.id = rp.permission_id
      join properties pr on pr.id = p_property and pr.tenant_id = m.tenant_id
     where m.user_id = p_user and m.status = 'active' and p.key = p_permission
       and (mr.property_id is null or mr.property_id = p_property))
$$;

create function hk_task_json(t housekeeping_tasks) returns jsonb language sql immutable as $$
  select jsonb_build_object('task_id', t.id, 'room_id', t.room_id, 'task_type', t.task_type, 'status', t.status,
                            'priority', t.priority, 'assigned_to', t.assigned_to)
$$;

revoke all on function hk_require(uuid, text, text), hk_user_can(uuid, uuid, text), hk_task_json(housekeeping_tasks),
  housekeeping_tasks_guard() from public, anon, authenticated;

-- ---- the room drives its tasks -----------------------------------------------------------
create function hk_sync_from_room() returns trigger language plpgsql security definer set search_path = public as $$
declare v_actor uuid := auth.uid(); v_id uuid; v_priority text := 'normal';
begin
  if new.operational_status = 'retired' then
    if old.operational_status <> 'retired' then
      for v_id in
        with u as (
          update housekeeping_tasks
             set status = 'cancelled', cancelled_at = now(), cancel_reason = 'room retired'
           where room_id = new.id and status in ('open', 'in_progress')
          returning id)
        select id from u
      loop
        perform write_audit(new.tenant_id, new.property_id, v_actor, 'housekeeping.task_cancelled', 'housekeeping_task',
                            v_id, null, jsonb_build_object('room_id', new.id, 'reason', 'room retired', 'via', 'room_status'));
      end loop;
    end if;
    return new;
  end if;

  if new.housekeeping_status = 'dirty' and (old.housekeeping_status <> 'dirty' or old.operational_status = 'retired') then
    if exists (select 1 from room_inventory_claims c
                where c.room_id = new.id and c.status = 'active' and c.claim_type = 'stay'
                  and c.start_date = property_today(new.property_id)) then
      v_priority := 'high';
    end if;
    v_id := null;
    insert into housekeeping_tasks (tenant_id, property_id, room_id, task_type, priority, created_by)
    values (new.tenant_id, new.property_id, new.id, 'cleaning', v_priority, v_actor)
    on conflict do nothing
    returning id into v_id;
    if v_id is not null then
      perform write_audit(new.tenant_id, new.property_id, v_actor, 'housekeeping.task_created', 'housekeeping_task',
                          v_id, null, jsonb_build_object('room_id', new.id, 'task_type', 'cleaning', 'priority', v_priority,
                                                         'via', 'room_status'));
    end if;

  elsif new.housekeeping_status = 'in_progress' and old.housekeeping_status <> 'in_progress' then
    for v_id in
      with u as (
        update housekeeping_tasks set status = 'in_progress', started_at = now()
         where room_id = new.id and task_type = 'cleaning' and status = 'open'
        returning id)
      select id from u
    loop
      perform write_audit(new.tenant_id, new.property_id, v_actor, 'housekeeping.task_started', 'housekeeping_task',
                          v_id, null, jsonb_build_object('room_id', new.id, 'via', 'room_status'));
    end loop;

  elsif new.housekeeping_status in ('clean', 'inspected') and old.housekeeping_status not in ('clean', 'inspected') then
    for v_id in
      with u as (
        update housekeeping_tasks
           set status = 'done', started_at = coalesce(started_at, now()), completed_at = now(), completed_by = v_actor
         where room_id = new.id and task_type = 'cleaning' and status in ('open', 'in_progress')
        returning id)
      select id from u
    loop
      perform write_audit(new.tenant_id, new.property_id, v_actor, 'housekeeping.task_completed', 'housekeeping_task',
                          v_id, null, jsonb_build_object('room_id', new.id, 'via', 'room_status'));
    end loop;
  end if;
  return new;
end $$;

revoke all on function hk_sync_from_room() from public, anon, authenticated;

create trigger rooms_sync_housekeeping_tasks after update of housekeeping_status, operational_status on rooms
  for each row
  when (old.housekeeping_status is distinct from new.housekeeping_status
        or old.operational_status is distinct from new.operational_status)
  execute function hk_sync_from_room();

-- ---- functions clients call --------------------------------------------------------------
-- Errors: NOT_FOUND (no such task, no permission, or another hotel: they look the same), FORBIDDEN (the caller can
-- see the task but may not do this), POLICY_VIOLATION (bad input), INVALID_STATE (the task is not in a state that
-- allows it). Repeating an action that already happened answers with the current task and writes nothing.

create function create_housekeeping_task(
  p_room_id     uuid,
  p_task_type   text        default 'cleaning',
  p_priority    text        default 'normal',
  p_due_at      timestamptz default null,
  p_notes       text        default null,
  p_assigned_to uuid        default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  rm rooms%rowtype; t housekeeping_tasks%rowtype; v_actor uuid; v_notes text := nullif(btrim(p_notes), '');
begin
  select * into rm from rooms where id = p_room_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := hk_require(rm.property_id, 'housekeeping.update');

  if p_task_type is null or p_task_type not in ('cleaning', 'deep_clean', 'inspection', 'other') then
    raise exception 'POLICY_VIOLATION: task type' using errcode = 'P0001';
  end if;
  if p_priority is null or p_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'POLICY_VIOLATION: priority' using errcode = 'P0001';
  end if;
  if length(v_notes) > 500 then raise exception 'POLICY_VIOLATION: notes too long' using errcode = 'P0001'; end if;
  if p_assigned_to is not null then
    if not has_permission(rm.property_id, 'housekeeping.assign') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
    if not hk_user_can(p_assigned_to, rm.property_id, 'housekeeping.update') then
      raise exception 'POLICY_VIOLATION: assignee' using errcode = 'P0001';
    end if;
  end if;

  select * into rm from rooms where id = p_room_id for update;   -- room first, as everywhere
  if rm.operational_status = 'retired' then raise exception 'INVALID_STATE: room retired' using errcode = 'P0001'; end if;

  if p_task_type <> 'other' then
    select * into t from housekeeping_tasks
     where room_id = rm.id and task_type = p_task_type and status in ('open', 'in_progress');
    if found then return hk_task_json(t) || jsonb_build_object('created', false); end if;
  end if;

  insert into housekeeping_tasks (tenant_id, property_id, room_id, task_type, priority, due_at, notes, assigned_to, created_by)
  values (rm.tenant_id, rm.property_id, rm.id, p_task_type, p_priority, p_due_at, v_notes, p_assigned_to, v_actor)
  returning * into t;
  perform write_audit(rm.tenant_id, rm.property_id, v_actor, 'housekeeping.task_created', 'housekeeping_task', t.id, null,
                      jsonb_build_object('room_id', rm.id, 'task_type', t.task_type, 'priority', t.priority,
                                         'assigned_to', t.assigned_to));
  return hk_task_json(t) || jsonb_build_object('created', true);
end $$;

-- Take an unassigned task for yourself.
create function claim_housekeeping_task(p_task_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t housekeeping_tasks%rowtype; v_actor uuid;
begin
  select * into t from housekeeping_tasks where id = p_task_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := hk_require(t.property_id, 'housekeeping.update');

  perform 1 from rooms where id = t.room_id for update;
  select * into t from housekeeping_tasks where id = p_task_id for update;
  if t.status not in ('open', 'in_progress') then raise exception 'INVALID_STATE: task %', t.status using errcode = 'P0001'; end if;
  if t.assigned_to = v_actor then return hk_task_json(t); end if;
  if t.assigned_to is not null then raise exception 'FORBIDDEN: assigned to someone else' using errcode = 'P0001'; end if;

  update housekeeping_tasks set assigned_to = v_actor where id = t.id returning * into t;
  perform write_audit(t.tenant_id, t.property_id, v_actor, 'housekeeping.task_assigned', 'housekeeping_task', t.id, null,
                      jsonb_build_object('room_id', t.room_id, 'from', null, 'to', v_actor, 'claimed', true));
  return hk_task_json(t);
end $$;

-- Give a task to someone, or take it back (null). The person must be able to do housekeeping at the property.
create function assign_housekeeping_task(p_task_id uuid, p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t housekeeping_tasks%rowtype; v_actor uuid; v_from uuid;
begin
  select * into t from housekeeping_tasks where id = p_task_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := hk_require(t.property_id, 'housekeeping.update');
  if not has_permission(t.property_id, 'housekeeping.assign') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if p_user_id is not null and not hk_user_can(p_user_id, t.property_id, 'housekeeping.update') then
    raise exception 'POLICY_VIOLATION: assignee' using errcode = 'P0001';
  end if;

  perform 1 from rooms where id = t.room_id for update;
  select * into t from housekeeping_tasks where id = p_task_id for update;
  if t.status not in ('open', 'in_progress') then raise exception 'INVALID_STATE: task %', t.status using errcode = 'P0001'; end if;
  if t.assigned_to is not distinct from p_user_id then return hk_task_json(t); end if;

  v_from := t.assigned_to;
  update housekeeping_tasks set assigned_to = p_user_id where id = t.id returning * into t;
  perform write_audit(t.tenant_id, t.property_id, v_actor, 'housekeeping.task_assigned', 'housekeeping_task', t.id, null,
                      jsonb_build_object('room_id', t.room_id, 'from', v_from, 'to', p_user_id));
  return hk_task_json(t);
end $$;

-- Start work. Takes the task for the caller when nobody has it. A cleaning task also moves a dirty room to
-- in_progress.
create function start_housekeeping_task(p_task_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t housekeeping_tasks%rowtype; rm rooms%rowtype; v_actor uuid;
begin
  select * into t from housekeeping_tasks where id = p_task_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := hk_require(t.property_id, 'housekeeping.update');

  select * into rm from rooms where id = t.room_id for update;
  select * into t from housekeeping_tasks where id = p_task_id for update;
  if t.status in ('done', 'cancelled') then raise exception 'INVALID_STATE: task %', t.status using errcode = 'P0001'; end if;
  if t.assigned_to is not null and t.assigned_to <> v_actor and not has_permission(t.property_id, 'housekeeping.assign') then
    raise exception 'FORBIDDEN: assigned to someone else' using errcode = 'P0001';
  end if;
  if t.status = 'in_progress' then return hk_task_json(t); end if;

  update housekeeping_tasks
     set status = 'in_progress', started_at = now(), assigned_to = coalesce(assigned_to, v_actor)
   where id = t.id returning * into t;
  perform write_audit(t.tenant_id, t.property_id, v_actor, 'housekeeping.task_started', 'housekeeping_task', t.id, null,
                      jsonb_build_object('room_id', t.room_id, 'assigned_to', t.assigned_to));

  if t.task_type = 'cleaning' and rm.operational_status <> 'retired' and rm.housekeeping_status = 'dirty' then
    update rooms set housekeeping_status = 'in_progress' where id = rm.id;
    perform write_audit(rm.tenant_id, rm.property_id, v_actor, 'room.housekeeping_set', 'room', rm.id, null,
                        jsonb_build_object('from', 'dirty', 'to', 'in_progress', 'task_id', t.id));
  end if;
  return hk_task_json(t);
end $$;

-- Finish work, with an optional note. A cleaning task also sets a dirty or in-progress room to clean (an
-- inspected room stays inspected). Nothing about occupancy changes.
create function complete_housekeeping_task(p_task_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t housekeeping_tasks%rowtype; rm rooms%rowtype; v_actor uuid; v_note text := nullif(btrim(p_note), '');
begin
  select * into t from housekeeping_tasks where id = p_task_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := hk_require(t.property_id, 'housekeeping.update');
  if length(v_note) > 500 then raise exception 'POLICY_VIOLATION: note too long' using errcode = 'P0001'; end if;

  select * into rm from rooms where id = t.room_id for update;
  select * into t from housekeeping_tasks where id = p_task_id for update;
  if t.status = 'cancelled' then raise exception 'INVALID_STATE: task cancelled' using errcode = 'P0001'; end if;
  if t.assigned_to is not null and t.assigned_to <> v_actor and not has_permission(t.property_id, 'housekeeping.assign') then
    raise exception 'FORBIDDEN: assigned to someone else' using errcode = 'P0001';
  end if;
  if t.status = 'done' then return hk_task_json(t); end if;

  update housekeeping_tasks
     set status = 'done', started_at = coalesce(started_at, now()), completed_at = now(), completed_by = v_actor,
         completion_note = v_note, assigned_to = coalesce(assigned_to, v_actor)
   where id = t.id returning * into t;
  perform write_audit(t.tenant_id, t.property_id, v_actor, 'housekeeping.task_completed', 'housekeeping_task', t.id, null,
                      jsonb_build_object('room_id', t.room_id, 'task_type', t.task_type));

  if t.task_type = 'cleaning' and rm.operational_status <> 'retired' and rm.housekeeping_status in ('dirty', 'in_progress') then
    update rooms set housekeeping_status = 'clean' where id = rm.id;
    perform write_audit(rm.tenant_id, rm.property_id, v_actor, 'room.housekeeping_set', 'room', rm.id, null,
                        jsonb_build_object('from', rm.housekeeping_status, 'to', 'clean', 'task_id', t.id));
  end if;
  return hk_task_json(t);
end $$;

-- Call a task off, with a reason. A cleaning task that is cancelled leaves the room's status as it is.
create function cancel_housekeeping_task(p_task_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t housekeeping_tasks%rowtype; v_actor uuid; v_reason text := nullif(btrim(p_reason), '');
begin
  select * into t from housekeeping_tasks where id = p_task_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := hk_require(t.property_id, 'housekeeping.update');
  if not has_permission(t.property_id, 'housekeeping.assign') then raise exception 'FORBIDDEN' using errcode = 'P0001'; end if;
  if v_reason is null or length(v_reason) > 200 then raise exception 'POLICY_VIOLATION: reason' using errcode = 'P0001'; end if;

  perform 1 from rooms where id = t.room_id for update;
  select * into t from housekeeping_tasks where id = p_task_id for update;
  if t.status = 'cancelled' then return hk_task_json(t); end if;
  if t.status = 'done' then raise exception 'INVALID_STATE: task done' using errcode = 'P0001'; end if;

  update housekeeping_tasks set status = 'cancelled', cancelled_at = now(), cancel_reason = v_reason
   where id = t.id returning * into t;
  perform write_audit(t.tenant_id, t.property_id, v_actor, 'housekeeping.task_cancelled', 'housekeeping_task', t.id, null,
                      jsonb_build_object('room_id', t.room_id, 'reason', v_reason));
  return hk_task_json(t);
end $$;

-- The people a task can be given to at a property, for the assignment picker. Housekeepers cannot read the staff
-- tables, so this is how a supervisor gets names.
create function list_housekeeping_staff(p_property uuid) returns table (user_id uuid, full_name text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform hk_require(p_property, 'housekeeping.assign');
  return query
    select distinct m.user_id, coalesce(nullif(btrim(up.full_name), ''), u.email, 'Unnamed')
      from tenant_memberships m
      join properties pr on pr.id = p_property and pr.tenant_id = m.tenant_id
      join auth.users u on u.id = m.user_id
      left join user_profiles up on up.id = m.user_id
     where m.status = 'active' and hk_user_can(m.user_id, p_property, 'housekeeping.update')
     order by 2, 1;
end $$;

revoke all on function create_housekeeping_task(uuid, text, text, timestamptz, text, uuid),
  claim_housekeeping_task(uuid), assign_housekeeping_task(uuid, uuid), start_housekeeping_task(uuid),
  complete_housekeeping_task(uuid, text), cancel_housekeeping_task(uuid, text), list_housekeeping_staff(uuid)
  from public, anon;
grant execute on function create_housekeeping_task(uuid, text, text, timestamptz, text, uuid),
  claim_housekeeping_task(uuid), assign_housekeeping_task(uuid, uuid), start_housekeeping_task(uuid),
  complete_housekeeping_task(uuid, text), cancel_housekeeping_task(uuid, text), list_housekeeping_staff(uuid)
  to authenticated;
