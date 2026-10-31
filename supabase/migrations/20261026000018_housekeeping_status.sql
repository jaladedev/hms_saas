-- 018 Housekeeping status.
--
-- rooms.housekeeping_status was only ever changed by check_out (dirty). Housekeepers do not have
-- property.configure, which the rooms table needs for direct writes, so they get one door:
-- set_housekeeping_status(room, status), requiring housekeeping.update at the room's property.
-- It changes nothing but the cleaning status, refuses retired rooms, and is audited. Setting the
-- status it already has is accepted and leaves the audit log alone, so a double tap writes nothing.

create function set_housekeeping_status(p_room_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare rm rooms%rowtype; v_actor uuid;
begin
  select * into rm from rooms where id = p_room_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(rm.property_id, 'housekeeping.update', 'NOT_FOUND');
  if p_status is null or p_status not in ('clean', 'dirty', 'in_progress', 'inspected') then
    raise exception 'POLICY_VIOLATION: housekeeping status' using errcode = 'P0001';
  end if;
  if rm.operational_status = 'retired' then
    raise exception 'INVALID_STATE: room retired' using errcode = 'P0001';
  end if;
  if rm.housekeeping_status <> p_status then
    update rooms set housekeeping_status = p_status where id = rm.id;
    perform write_audit(rm.tenant_id, rm.property_id, v_actor, 'room.housekeeping_set', 'room', rm.id, null,
                        jsonb_build_object('from', rm.housekeeping_status, 'to', p_status));
  end if;
  return jsonb_build_object('room_id', rm.id, 'housekeeping_status', p_status);
end $$;

revoke all on function set_housekeeping_status(uuid, text) from public, anon;
grant execute on function set_housekeeping_status(uuid, text) to authenticated;
