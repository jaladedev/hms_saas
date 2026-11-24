-- 189 Repair changes made offline keep the time they were made (the same fix migration 185 made for housekeeping tasks).
--
-- `start_maintenance_request` and `resolve_maintenance_request` stamped now(), so a tap made at 10:42 on a laptop with no connection and
-- sent at 11:20 showed 11:20 (TODO "Offline step 2d", known limitation). Each of the three repair functions that staff run from the
-- list now takes an optional last argument `p_at`, the time the person actually made the change:
--   * null (every existing caller, and every change made online) behaves exactly as before: the time is now();
--   * otherwise the time is p_at, kept inside bounds the database trusts, by the same helper as housekeeping (hk_effective_time, 185):
--       - never later than now(); never more than two days before now();
--       - never before the request was reported, and for a resolve never before it was started.
--     A value outside the bounds is moved to the nearest bound; the change is not refused.
-- Used for `started_at` (start) and `started_at`/`resolved_at` (resolve). A claim stores no time on the row, so there `p_at` only appears
-- in the audit entry. Every audit entry written with a `p_at` also records `made_at` (the time used) and `received_at` (when the database
-- got it). Sending the same change twice is still harmless: the repeat paths return the request unchanged before any time is used.
--
-- The old signatures are dropped so the API has one function of each name (PostgREST cannot choose between overloads that differ only by a
-- defaulted argument). Callers that omit `p_at` keep working through its default. Grants as in 026: authenticated only, no anon.

-- ---- claim ---------------------------------------------------------------------------------
drop function claim_maintenance_request(uuid);
create function claim_maintenance_request(p_request_id uuid, p_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r maintenance_requests%rowtype; v_actor uuid; v_at timestamptz;
begin
  select * into r from maintenance_requests where id = p_request_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := hk_require(r.property_id, 'maintenance.manage');

  select * into r from maintenance_requests where id = p_request_id for update;
  if r.status not in ('open', 'in_progress') then raise exception 'INVALID_STATE: request %', r.status using errcode = 'P0001'; end if;
  if r.assigned_to = v_actor then return mt_request_json(r); end if;
  if r.assigned_to is not null then raise exception 'FORBIDDEN: assigned to someone else' using errcode = 'P0001'; end if;

  v_at := hk_effective_time(p_at, r.created_at);
  update maintenance_requests set assigned_to = v_actor where id = r.id returning * into r;
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'maintenance.request_assigned', 'maintenance_request', r.id, null,
                      jsonb_build_object('from', null, 'to', v_actor, 'claimed', true)
                      || case when p_at is null then '{}'::jsonb else jsonb_build_object('made_at', v_at, 'received_at', now()) end);
  return mt_request_json(r);
end $$;

-- ---- start ---------------------------------------------------------------------------------
drop function start_maintenance_request(uuid);
create function start_maintenance_request(p_request_id uuid, p_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r maintenance_requests%rowtype; v_actor uuid; v_at timestamptz;
begin
  select * into r from maintenance_requests where id = p_request_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := hk_require(r.property_id, 'maintenance.manage');

  select * into r from maintenance_requests where id = p_request_id for update;
  if r.status in ('resolved', 'cancelled') then raise exception 'INVALID_STATE: request %', r.status using errcode = 'P0001'; end if;
  if r.status = 'in_progress' then return mt_request_json(r); end if;

  v_at := hk_effective_time(p_at, r.created_at);
  update maintenance_requests set status = 'in_progress', started_at = v_at, assigned_to = coalesce(assigned_to, v_actor)
   where id = r.id returning * into r;
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'maintenance.request_started', 'maintenance_request', r.id, null,
                      jsonb_build_object('assigned_to', r.assigned_to)
                      || case when p_at is null then '{}'::jsonb else jsonb_build_object('made_at', v_at, 'received_at', now()) end);
  return mt_request_json(r);
end $$;

-- ---- resolve -------------------------------------------------------------------------------
drop function resolve_maintenance_request(uuid, text);
create function resolve_maintenance_request(p_request_id uuid, p_note text default null, p_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r maintenance_requests%rowtype; v_actor uuid; v_note text := nullif(btrim(p_note), ''); v_block_active boolean := false; v_at timestamptz;
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

  v_at := hk_effective_time(p_at, coalesce(r.started_at, r.created_at));
  update maintenance_requests
     set status = 'resolved', started_at = coalesce(started_at, v_at), resolved_at = v_at, resolved_by = v_actor,
         resolution_note = v_note, assigned_to = coalesce(assigned_to, v_actor)
   where id = r.id returning * into r;
  select exists (select 1 from room_inventory_claims c where c.id = r.room_block_id and c.status = 'active' and c.end_date > property_today(r.property_id))
    into v_block_active;
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'maintenance.request_resolved', 'maintenance_request', r.id, null,
                      jsonb_build_object('room_id', r.room_id, 'block_still_active', v_block_active)
                      || case when p_at is null then '{}'::jsonb else jsonb_build_object('made_at', v_at, 'received_at', now()) end);
  return mt_request_json(r) || jsonb_build_object('block_still_active', v_block_active);
end $$;

revoke all on function claim_maintenance_request(uuid, timestamptz), start_maintenance_request(uuid, timestamptz),
  resolve_maintenance_request(uuid, text, timestamptz) from public, anon;
grant execute on function claim_maintenance_request(uuid, timestamptz), start_maintenance_request(uuid, timestamptz),
  resolve_maintenance_request(uuid, text, timestamptz) to authenticated;
