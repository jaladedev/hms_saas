-- 185 Housekeeping changes made offline keep the time they were made (TODO "Offline step 2a", known limitation).
--
-- Until now `start_housekeeping_task` and `complete_housekeeping_task` stamped `now()`, so a room cleaned at 10:42 on a laptop with no
-- connection and sent at 11:20 showed 11:20. Each of the three task functions now takes an optional last argument `p_at`, the time the
-- person actually made the change:
--   * null (every existing caller, and every change made online) behaves exactly as before: the time is now();
--   * otherwise the time is p_at, kept inside bounds the database trusts, because the clock on a hotel laptop is not trustworthy:
--       - never later than now() (a clock that runs ahead is treated as "just now");
--       - never more than two days before now() (a change cannot be backdated further than the queue can plausibly have waited);
--       - never before the task existed, and for a completion never before the task was started.
--     A value outside the bounds is moved to the nearest bound; the change is not refused, since the person did the work and a refusal
--     would leave the room looking dirty.
-- Used for `started_at` (start) and `started_at`/`completed_at` (complete). A claim stores no time on the task row, so there `p_at` only
-- appears in the audit entry. Every audit entry written with a `p_at` also records `made_at` (the time used) and `received_at` (when the
-- database got it), so the history shows both. Sending the same change twice is still harmless: the repeat paths return the task unchanged
-- before any time is used.
--
-- The old one-argument and two-argument signatures are dropped, so the API has one function of each name (PostgREST cannot choose between
-- overloads that differ only by a defaulted argument). Callers that omit `p_at` keep working through its default. Grants are as in 023:
-- authenticated only, no anon.

-- ---- the time a change is recorded at ----------------------------------------------------
create function hk_effective_time(p_at timestamptz, p_floor timestamptz) returns timestamptz
language sql stable set search_path = public as $$
  select case
           when p_at is null then now()
           else least(now(), greatest(p_at, now() - interval '2 days', coalesce(p_floor, '-infinity'::timestamptz)))
         end
$$;
revoke all on function hk_effective_time(timestamptz, timestamptz) from public, anon, authenticated;

-- ---- claim ---------------------------------------------------------------------------------
drop function claim_housekeeping_task(uuid);
create function claim_housekeeping_task(p_task_id uuid, p_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t housekeeping_tasks%rowtype; v_actor uuid; v_at timestamptz;
begin
  select * into t from housekeeping_tasks where id = p_task_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := hk_require(t.property_id, 'housekeeping.update');

  perform 1 from rooms where id = t.room_id for update;
  select * into t from housekeeping_tasks where id = p_task_id for update;
  if t.status not in ('open', 'in_progress') then raise exception 'INVALID_STATE: task %', t.status using errcode = 'P0001'; end if;
  if t.assigned_to = v_actor then return hk_task_json(t); end if;
  if t.assigned_to is not null then raise exception 'FORBIDDEN: assigned to someone else' using errcode = 'P0001'; end if;

  v_at := hk_effective_time(p_at, t.created_at);
  update housekeeping_tasks set assigned_to = v_actor where id = t.id returning * into t;
  perform write_audit(t.tenant_id, t.property_id, v_actor, 'housekeeping.task_assigned', 'housekeeping_task', t.id, null,
                      jsonb_build_object('room_id', t.room_id, 'from', null, 'to', v_actor, 'claimed', true)
                      || case when p_at is null then '{}'::jsonb else jsonb_build_object('made_at', v_at, 'received_at', now()) end);
  return hk_task_json(t);
end $$;

-- ---- start ---------------------------------------------------------------------------------
drop function start_housekeeping_task(uuid);
create function start_housekeeping_task(p_task_id uuid, p_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t housekeeping_tasks%rowtype; rm rooms%rowtype; v_actor uuid; v_at timestamptz;
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

  v_at := hk_effective_time(p_at, t.created_at);
  update housekeeping_tasks
     set status = 'in_progress', started_at = v_at, assigned_to = coalesce(assigned_to, v_actor)
   where id = t.id returning * into t;
  perform write_audit(t.tenant_id, t.property_id, v_actor, 'housekeeping.task_started', 'housekeeping_task', t.id, null,
                      jsonb_build_object('room_id', t.room_id, 'assigned_to', t.assigned_to)
                      || case when p_at is null then '{}'::jsonb else jsonb_build_object('made_at', v_at, 'received_at', now()) end);

  if t.task_type = 'cleaning' and rm.operational_status <> 'retired' and rm.housekeeping_status = 'dirty' then
    update rooms set housekeeping_status = 'in_progress' where id = rm.id;
    perform write_audit(rm.tenant_id, rm.property_id, v_actor, 'room.housekeeping_set', 'room', rm.id, null,
                        jsonb_build_object('from', 'dirty', 'to', 'in_progress', 'task_id', t.id));
  end if;
  return hk_task_json(t);
end $$;

-- ---- complete ------------------------------------------------------------------------------
drop function complete_housekeeping_task(uuid, text);
create function complete_housekeeping_task(p_task_id uuid, p_note text default null, p_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t housekeeping_tasks%rowtype; rm rooms%rowtype; v_actor uuid; v_note text := nullif(btrim(p_note), ''); v_at timestamptz;
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

  v_at := hk_effective_time(p_at, coalesce(t.started_at, t.created_at));
  update housekeeping_tasks
     set status = 'done', started_at = coalesce(started_at, v_at), completed_at = v_at, completed_by = v_actor,
         completion_note = v_note, assigned_to = coalesce(assigned_to, v_actor)
   where id = t.id returning * into t;
  perform write_audit(t.tenant_id, t.property_id, v_actor, 'housekeeping.task_completed', 'housekeeping_task', t.id, null,
                      jsonb_build_object('room_id', t.room_id, 'task_type', t.task_type)
                      || case when p_at is null then '{}'::jsonb else jsonb_build_object('made_at', v_at, 'received_at', now()) end);

  if t.task_type = 'cleaning' and rm.operational_status <> 'retired' and rm.housekeeping_status in ('dirty', 'in_progress') then
    update rooms set housekeeping_status = 'clean' where id = rm.id;
    perform write_audit(rm.tenant_id, rm.property_id, v_actor, 'room.housekeeping_set', 'room', rm.id, null,
                        jsonb_build_object('from', rm.housekeeping_status, 'to', 'clean', 'task_id', t.id));
  end if;
  return hk_task_json(t);
end $$;

revoke all on function claim_housekeeping_task(uuid, timestamptz), start_housekeeping_task(uuid, timestamptz),
  complete_housekeeping_task(uuid, text, timestamptz) from public, anon;
grant execute on function claim_housekeeping_task(uuid, timestamptz), start_housekeeping_task(uuid, timestamptz),
  complete_housekeeping_task(uuid, text, timestamptz) to authenticated;
