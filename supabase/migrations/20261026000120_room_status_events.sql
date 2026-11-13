-- 120 Who changed a room's status, and when.
--
-- The staff Room Details page (prototype "Physical Room Details") shows a status history: Dirty to Cleaning, who did it, when.
-- housekeeping_status was only audited by set_housekeeping_status (018); check-out, task completion and the transfer functions
-- change it without that entry, and audit_logs needs audit.view to read. This adds one place every change lands, whatever made it.
--
--   * room_status_events: a row each time a room's housekeeping_status or operational_status changes, with the old and new value
--     and the person (auth.uid() inside the change; null when no one is signed in, such as the server finishing a job). Append-only.
--     Nobody reads or writes it directly; clients go through room_status_history.
--   * room_status_history(room, limit): newest first, for a person with room.view or housekeeping.view at the room's property.
--     It returns the person's name (their profile name, else their email) so a front desk user needs no staff list to read it.
--     A room the caller cannot see, or one that does not exist, gives no rows, the same answer. 1 to 50 rows; 20 by default.

create table room_status_events (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  property_id    uuid not null,
  room_id        uuid not null references rooms (id) on delete cascade,
  field          text not null check (field in ('housekeeping_status', 'operational_status')),
  from_value     text,
  to_value       text not null,
  actor_user_id  uuid,
  created_at     timestamptz not null default now()
);
create index on room_status_events (room_id, created_at desc);

alter table room_status_events enable row level security;
revoke all on room_status_events from authenticated, anon;

create function room_status_events_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from rooms where id = old.room_id) then return old; end if;  -- the room itself was deleted
  raise exception 'room_status_events is append-only' using errcode = '23514';
end $$;
create trigger room_status_events_no_change before update or delete on room_status_events
  for each row execute function room_status_events_append_only();

create function rooms_record_status_events() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.housekeeping_status is distinct from old.housekeeping_status then
    insert into room_status_events (tenant_id, property_id, room_id, field, from_value, to_value, actor_user_id)
    values (new.tenant_id, new.property_id, new.id, 'housekeeping_status', old.housekeeping_status, new.housekeeping_status, auth.uid());
  end if;
  if new.operational_status is distinct from old.operational_status then
    insert into room_status_events (tenant_id, property_id, room_id, field, from_value, to_value, actor_user_id)
    values (new.tenant_id, new.property_id, new.id, 'operational_status', old.operational_status, new.operational_status, auth.uid());
  end if;
  return null;
end $$;
revoke all on function rooms_record_status_events() from public, anon, authenticated;

create trigger rooms_status_events after update of housekeeping_status, operational_status on rooms
  for each row
  when (old.housekeeping_status is distinct from new.housekeeping_status or old.operational_status is distinct from new.operational_status)
  execute function rooms_record_status_events();

create function room_status_history(p_room uuid, p_limit integer default 20)
returns table (changed_at timestamptz, field text, from_value text, to_value text, actor_name text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_property uuid;
begin
  select r.property_id into v_property from rooms r where r.id = p_room;
  if v_property is null or not (has_permission(v_property, 'room.view') or has_permission(v_property, 'housekeeping.view')) then
    return;
  end if;
  return query
    select e.created_at, e.field, e.from_value, e.to_value,
           case when m.user_id is null then null else coalesce(nullif(btrim(up.full_name), ''), u.email, 'Unnamed') end
      from room_status_events e
      left join tenant_memberships m on m.user_id = e.actor_user_id and m.tenant_id = e.tenant_id
      left join auth.users u on u.id = m.user_id
      left join user_profiles up on up.id = m.user_id
     where e.room_id = p_room
     order by e.created_at desc, e.id
     limit least(greatest(coalesce(p_limit, 20), 1), 50);
end $$;

revoke all on function room_status_history(uuid, integer) from public, anon;
grant execute on function room_status_history(uuid, integer) to authenticated;
