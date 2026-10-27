-- 008 Reservation operations: cancel_reservation, check_in, check_out, transfer_room,
-- create_room_block, release_room_block, plus shared helpers. Money side effects (invoice
-- credit, refund request, balance checks at check-out) arrive with the money tables.
-- Functions addressed by id answer NOT_FOUND to callers without permission, so one hotel
-- cannot learn whether another hotel's ids exist.

alter table reservations
  add column cancellation_charge_minor bigint not null default 0 check (cancellation_charge_minor >= 0),
  add column cancel_reason text;
alter table reservation_rooms
  add column checked_in_at timestamptz,
  add column checked_out_at timestamptz;

-- ---- helpers ------------------------------------------------------------------------
create function require_permission(p_property uuid, p_permission text, p_deny_as text default 'FORBIDDEN')
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then
    if is_system_caller() then return null; end if;
    raise exception '%', p_deny_as using errcode = 'P0001';
  end if;
  if not has_permission(p_property, p_permission) then
    raise exception '%', p_deny_as using errcode = 'P0001';
  end if;
  return v_actor;
end $$;

create function property_today(p_property uuid) returns date
language sql stable security definer set search_path = public as $$
  select (now() at time zone timezone)::date from properties where id = p_property
$$;

create function idem_begin(p_tenant uuid, p_operation text, p_key text, p_hash text,
                           out out_is_new boolean, out out_response jsonb)
language plpgsql security definer set search_path = public as $$
declare v record;
begin
  if p_key is null or length(p_key) = 0 then
    raise exception 'POLICY_VIOLATION: idempotency key required' using errcode = 'P0001';
  end if;
  insert into idempotency_keys (tenant_id, operation, idempotency_key, request_hash)
  values (p_tenant, p_operation, p_key, p_hash)
  on conflict (tenant_id, operation, idempotency_key) do nothing;
  if found then out_is_new := true; return; end if;
  select k.request_hash, k.response into v from idempotency_keys k
   where k.tenant_id = p_tenant and k.operation = p_operation and k.idempotency_key = p_key;
  if v.request_hash <> p_hash then raise exception 'IDEMPOTENCY_MISMATCH' using errcode = 'P0001'; end if;
  out_is_new := false; out_response := v.response;
end $$;

create function idem_finish(p_tenant uuid, p_operation text, p_key text, p_response jsonb) returns void
language sql security definer set search_path = public as $$
  update idempotency_keys set response = p_response
   where tenant_id = p_tenant and operation = p_operation and idempotency_key = p_key
$$;

create function write_audit(p_tenant uuid, p_property uuid, p_actor uuid, p_action text,
                            p_entity_type text, p_entity uuid, p_request text, p_meta jsonb) returns void
language sql security definer set search_path = public as $$
  insert into audit_logs (tenant_id, property_id, actor_user_id, action, entity_type, entity_id, request_id, metadata)
  values (p_tenant, p_property, p_actor, p_action, p_entity_type, p_entity, p_request, coalesce(p_meta, '{}'::jsonb))
$$;

revoke all on function require_permission(uuid, text, text), property_today(uuid),
  idem_begin(uuid, text, text, text), idem_finish(uuid, text, text, jsonb),
  write_audit(uuid, uuid, uuid, text, text, uuid, text, jsonb) from public, anon, authenticated;

-- Checked-out and cancelled rooms may have shortened or released claims.
create or replace function check_claim_tiling() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_arr date; v_dep date; v_nights integer; v_min date; v_max date; v_cnt integer; v_status text;
begin
  if new.reservation_room_id is null or new.claim_type = 'block' then return null; end if;
  select rr.room_status, r.arrival_date, r.departure_date into v_status, v_arr, v_dep
    from reservation_rooms rr join reservations r on r.id = rr.reservation_id
   where rr.id = new.reservation_room_id;
  if v_status in ('checked_out', 'cancelled') then return null; end if;
  select count(*), coalesce(sum(end_date - start_date), 0), min(start_date), max(end_date)
    into v_cnt, v_nights, v_min, v_max
    from room_inventory_claims
   where reservation_room_id = new.reservation_room_id
     and status = 'active' and claim_type in ('stay','hold');
  if v_cnt = 0 then return null; end if;
  if v_min <> v_arr or v_max <> v_dep or v_nights <> (v_dep - v_arr) then
    raise exception 'CLAIM_TILING: claims for reservation room % do not cover % to %',
      new.reservation_room_id, v_arr, v_dep using errcode = '23514';
  end if;
  return null;
end $$;

-- ---- cancel_reservation ---------------------------------------------------------------
-- Cancellation rules live in the reservation's policy snapshot, for example
--   "cancellation_rules": [ {"within_hours": 48, "charge": {"type": "nights", "value": 1}},
--                           {"within_hours": 0,  "charge": {"type": "percent", "value": 100}} ]
-- The rule with the smallest within_hours that is still >= hours until arrival applies;
-- no matching rule means free cancellation. Charge types: percent of total, first N nights
-- of every room, or a fixed kobo amount. The charge is capped at the reservation total.
create function cancel_reservation(p_reservation_id uuid, p_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r reservations%rowtype; v_prop record; v_actor uuid; v_idem record; v_hash text;
  v_hours numeric; v_rule jsonb; v_type text; v_val numeric; v_charge bigint := 0; v_result jsonb;
  v_checkin time;
begin
  select * into r from reservations where id = p_reservation_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(r.property_id, 'reservation.cancel', 'NOT_FOUND');
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'POLICY_VIOLATION: reason required' using errcode = 'P0001';
  end if;

  v_hash := md5(concat_ws('|', p_reservation_id, p_reason));
  select * into v_idem from idem_begin(r.tenant_id, 'cancel_reservation', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  select * into r from reservations where id = p_reservation_id for update;
  if r.reservation_status not in ('pending', 'confirmed')
     or exists (select 1 from reservation_rooms where reservation_id = r.id and room_status in ('checked_in','checked_out')) then
    raise exception 'INVALID_STATE: %', r.reservation_status using errcode = 'P0001';
  end if;

  select timezone, check_in_time into v_prop from properties where id = r.property_id;
  v_checkin := coalesce((r.policy_snapshot ->> 'check_in_time')::time, v_prop.check_in_time);
  v_hours := extract(epoch from (((r.arrival_date + v_checkin) at time zone v_prop.timezone) - now())) / 3600;

  select rule into v_rule
    from jsonb_array_elements(coalesce(r.policy_snapshot -> 'cancellation_rules', '[]'::jsonb)) rule
   where (rule ->> 'within_hours')::numeric >= v_hours
   order by (rule ->> 'within_hours')::numeric asc limit 1;

  if v_rule is not null then
    v_type := v_rule -> 'charge' ->> 'type';
    v_val  := (v_rule -> 'charge' ->> 'value')::numeric;
    if v_type = 'percent' then
      v_charge := round(r.total_minor * v_val / 100)::bigint;
    elsif v_type = 'nights' then
      select coalesce(sum(x.rate_minor + x.tax_minor), 0)::bigint into v_charge from (
        select n.rate_minor, n.tax_minor,
               row_number() over (partition by n.reservation_room_id order by n.night_date) as rn
          from reservation_nights n join reservation_rooms rr on rr.id = n.reservation_room_id
         where rr.reservation_id = r.id) x
       where x.rn <= v_val;
    elsif v_type = 'fixed' then
      v_charge := round(v_val)::bigint;
    else
      raise exception 'POLICY_VIOLATION: unknown charge type %', v_type using errcode = 'P0001';
    end if;
    v_charge := least(v_charge, r.total_minor);
  end if;

  update room_inventory_claims set status = 'released'
   where status = 'active' and reservation_room_id in (select id from reservation_rooms where reservation_id = r.id);
  update reservation_rooms set room_status = 'cancelled' where reservation_id = r.id;
  update reservations set reservation_status = 'cancelled', cancelled_at = now(),
         cancellation_charge_minor = v_charge, cancel_reason = p_reason
   where id = r.id;

  v_result := jsonb_build_object('reservation_id', r.id, 'status', 'cancelled', 'cancellation_charge_minor', v_charge,
                                 'hours_before_arrival', round(v_hours, 1));
  perform idem_finish(r.tenant_id, 'cancel_reservation', p_idempotency_key, v_result);
  perform write_audit(r.tenant_id, r.property_id, v_actor, 'reservation.cancelled', 'reservation', r.id,
                      p_idempotency_key, jsonb_build_object('reason', p_reason, 'charge_minor', v_charge));
  return v_result;
end $$;

-- ---- check_in ---------------------------------------------------------------------------
-- Early check-in (before the arrival date) is not supported yet: it needs a claim that starts
-- earlier. A dirty room blocks check-in unless an override reason is given. If the booking policy
-- sets "checkin_payment": "full", the reservation must be paid unless a caller with payment.verify
-- gives an override reason.
create function check_in(p_reservation_room_id uuid, p_override_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  rr reservation_rooms%rowtype; r reservations%rowtype; v_actor uuid; v_today date;
  v_room rooms%rowtype; v_claim room_inventory_claims%rowtype;
begin
  select * into rr from reservation_rooms where id = p_reservation_room_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(rr.property_id, 'reservation.checkin', 'NOT_FOUND');

  select * into r from reservations where id = rr.reservation_id for update;
  select * into rr from reservation_rooms where id = p_reservation_room_id for update;
  v_today := property_today(r.property_id);

  if r.reservation_status not in ('confirmed', 'checked_in') or rr.room_status <> 'booked' then
    raise exception 'INVALID_STATE: reservation % room %', r.reservation_status, rr.room_status using errcode = 'P0001';
  end if;
  if v_today < r.arrival_date then
    raise exception 'POLICY_VIOLATION: EARLY_CHECKIN_NOT_SUPPORTED' using errcode = 'P0001';
  end if;
  if v_today >= r.departure_date then
    raise exception 'INVALID_STATE: stay already ended' using errcode = 'P0001';
  end if;

  select * into v_claim from room_inventory_claims
   where reservation_room_id = rr.id and status = 'active' and claim_type = 'stay'
     and start_date <= v_today and end_date > v_today;
  if not found then raise exception 'INVALID_STATE: no stay claim for today' using errcode = 'P0001'; end if;

  select * into v_room from rooms where id = v_claim.room_id;
  if v_room.operational_status <> 'active' then
    raise exception 'INVALID_STATE: ROOM_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  if v_room.housekeeping_status not in ('clean', 'inspected')
     and (p_override_reason is null or length(trim(p_override_reason)) = 0) then
    raise exception 'INVALID_STATE: ROOM_NOT_READY' using errcode = 'P0001';
  end if;
  if r.policy_snapshot ->> 'checkin_payment' = 'full' and r.payment_status <> 'paid' then
    if p_override_reason is null or length(trim(p_override_reason)) = 0
       or not (v_actor is null or has_permission(r.property_id, 'payment.verify')) then
      raise exception 'POLICY_VIOLATION: PAYMENT_REQUIRED' using errcode = 'P0001';
    end if;
  end if;

  update reservation_rooms set room_status = 'checked_in', checked_in_at = now() where id = rr.id;
  update reservations set reservation_status = 'checked_in' where id = r.id and reservation_status = 'confirmed';

  perform write_audit(r.tenant_id, r.property_id, v_actor, 'reservation.checked_in', 'reservation', r.id, null,
                      jsonb_build_object('reservation_room_id', rr.id, 'room_id', v_room.id,
                                         'override_reason', p_override_reason));
  return jsonb_build_object('reservation_id', r.id, 'reservation_room_id', rr.id, 'room_id', v_room.id, 'status', 'checked_in');
end $$;

-- ---- check_out --------------------------------------------------------------------------
-- Leaving before the departure date shortens the stay: the claim containing today is cut back to
-- today and later claims are released, so the room can be sold again. Billing adjustments for the
-- unused nights and the settlement check arrive with the money tables.
create function check_out(p_reservation_room_id uuid, p_override_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  rr reservation_rooms%rowtype; r reservations%rowtype; v_actor uuid; v_today date;
  v_early boolean; v_room uuid;
begin
  select * into rr from reservation_rooms where id = p_reservation_room_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(rr.property_id, 'reservation.checkout', 'NOT_FOUND');

  select * into r from reservations where id = rr.reservation_id for update;
  select * into rr from reservation_rooms where id = p_reservation_room_id for update;
  v_today := property_today(r.property_id);

  if rr.room_status <> 'checked_in' then
    raise exception 'INVALID_STATE: room %', rr.room_status using errcode = 'P0001';
  end if;
  v_early := v_today < r.departure_date;

  -- the room the guest is in tonight, for housekeeping
  select room_id into v_room from room_inventory_claims
   where reservation_room_id = rr.id and status = 'active' and claim_type = 'stay'
   order by (start_date <= v_today and end_date > v_today) desc, end_date desc limit 1;

  update reservation_rooms set room_status = 'checked_out', checked_out_at = now() where id = rr.id;

  if v_early then
    update room_inventory_claims set status = 'released'
     where reservation_room_id = rr.id and status = 'active' and start_date >= v_today;
    update room_inventory_claims set end_date = v_today
     where reservation_room_id = rr.id and status = 'active' and start_date < v_today and end_date > v_today;
  end if;

  if v_room is not null then
    update rooms set housekeeping_status = 'dirty' where id = v_room;
  end if;

  if not exists (select 1 from reservation_rooms where reservation_id = r.id and room_status in ('booked', 'checked_in')) then
    update reservations set reservation_status = 'checked_out' where id = r.id;
  end if;

  perform write_audit(r.tenant_id, r.property_id, v_actor, 'reservation.checked_out', 'reservation', r.id, null,
                      jsonb_build_object('reservation_room_id', rr.id, 'early_departure', v_early,
                                         'override_reason', p_override_reason));
  return jsonb_build_object('reservation_id', r.id, 'reservation_room_id', rr.id, 'status', 'checked_out',
                            'early_departure', v_early);
end $$;

-- ---- transfer (internal) and transfer_room ---------------------------------------------
-- Moves the part of a stay from p_effective to the end of the claim containing that date into
-- another room. The old claim is shortened first (or released when it starts that day), then the
-- new claim is made, so the reservation room never holds two rooms on one night. If the new room
-- is taken, ROOM_UNAVAILABLE rolls the whole transaction back and the guest keeps the old room.
create function transfer_claim_internal(p_reservation_room_id uuid, p_effective date, p_new_room uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  rr reservation_rooms%rowtype; r reservations%rowtype; o room_inventory_claims%rowtype;
  v_old_room uuid; v_end date; v_new uuid; v_claim uuid; cand record; v_done boolean := false;
begin
  select * into rr from reservation_rooms where id = p_reservation_room_id;
  select * into r from reservations where id = rr.reservation_id;
  if rr.room_status not in ('booked', 'checked_in') then
    raise exception 'INVALID_STATE: room %', rr.room_status using errcode = 'P0001';
  end if;
  select * into o from room_inventory_claims
   where reservation_room_id = rr.id and status = 'active' and claim_type in ('stay','hold')
     and start_date <= p_effective and end_date > p_effective for update;
  if not found then raise exception 'POLICY_VIOLATION: effective date is outside the stay' using errcode = 'P0001'; end if;
  v_old_room := o.room_id; v_end := o.end_date;

  perform lock_room_types(rr.property_id, array[rr.room_type_id,
            (select room_type_id from rooms where id = coalesce(p_new_room, v_old_room))]);

  if o.start_date = p_effective then
    update room_inventory_claims set status = 'released' where id = o.id;
  else
    update room_inventory_claims set end_date = p_effective where id = o.id;
  end if;

  if p_new_room is not null then
    if p_new_room = v_old_room or not exists (select 1 from rooms where id = p_new_room and property_id = rr.property_id) then
      raise exception 'POLICY_VIOLATION: invalid target room' using errcode = 'P0001';
    end if;
    v_claim := claim_room(rr.property_id, null, p_new_room, p_effective, v_end, o.claim_type, rr.id, o.hold_expires_at, null, o.created_by);
  else
    for cand in
      select id from rooms where property_id = rr.property_id and room_type_id = rr.room_type_id
         and operational_status = 'active' and id <> v_old_room order by room_number
    loop
      begin
        v_claim := claim_room(rr.property_id, null, cand.id, p_effective, v_end, o.claim_type, rr.id, o.hold_expires_at, null, o.created_by);
        v_done := true; exit;
      exception when sqlstate 'P0001' then
        if sqlerrm <> 'ROOM_UNAVAILABLE' then raise; end if;
      end;
    end loop;
    if not v_done then raise exception 'ROOM_UNAVAILABLE' using errcode = 'P0001'; end if;
  end if;

  select room_id into v_new from room_inventory_claims where id = v_claim;
  if rr.room_status = 'checked_in' then update rooms set housekeeping_status = 'dirty' where id = v_old_room; end if;
  return jsonb_build_object('reservation_room_id', rr.id, 'from_room_id', v_old_room, 'to_room_id', v_new,
                            'effective', p_effective, 'until', v_end);
end $$;

create function transfer_room(p_reservation_room_id uuid, p_new_room_id uuid, p_effective date,
                              p_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rr reservation_rooms%rowtype; v_actor uuid; v_idem record; v_result jsonb; v_hash text; v_today date;
begin
  select * into rr from reservation_rooms where id = p_reservation_room_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(rr.property_id, 'room.assign', 'NOT_FOUND');
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'POLICY_VIOLATION: reason required' using errcode = 'P0001';
  end if;
  v_hash := md5(concat_ws('|', p_reservation_room_id, p_new_room_id, p_effective, p_reason));
  select * into v_idem from idem_begin(rr.tenant_id, 'transfer_room', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  v_today := property_today(rr.property_id);
  if p_effective < v_today then
    raise exception 'POLICY_VIOLATION: effective date is in the past' using errcode = 'P0001';
  end if;

  v_result := transfer_claim_internal(p_reservation_room_id, p_effective, p_new_room_id);
  perform idem_finish(rr.tenant_id, 'transfer_room', p_idempotency_key, v_result);
  perform write_audit(rr.tenant_id, rr.property_id, v_actor, 'room.transferred', 'reservation', rr.reservation_id,
                      p_idempotency_key, v_result || jsonb_build_object('reason', p_reason));
  return v_result;
end $$;

-- ---- room blocks -------------------------------------------------------------------------
-- Returns {"created": true, "block_id": ...} or {"created": false, "conflicts": [...]}.
-- p_resolution 'fail' only reports conflicts. 'move' transfers every conflicting stay or hold to
-- another room of the same type first; if any cannot move, nothing changes. Moving never
-- touches a conflicting block, and blocks cannot start in the past.
create function create_room_block(p_room_id uuid, p_start date, p_end date, p_reason text,
                                  p_resolution text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  rm rooms%rowtype; v_actor uuid; v_idem record; v_hash text; v_conf jsonb; v_has_block boolean;
  mv record; v_block uuid; v_result jsonb; v_moved jsonb := '[]'::jsonb;
begin
  select * into rm from rooms where id = p_room_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(rm.property_id, 'room.block', 'NOT_FOUND');
  if p_reason is null or length(trim(p_reason)) = 0 or p_start >= p_end or p_resolution not in ('fail', 'move') then
    raise exception 'POLICY_VIOLATION: invalid block request' using errcode = 'P0001';
  end if;
  if p_start < property_today(rm.property_id) then
    raise exception 'POLICY_VIOLATION: block cannot start in the past' using errcode = 'P0001';
  end if;
  v_hash := md5(concat_ws('|', p_room_id, p_start, p_end, p_reason, p_resolution));
  select * into v_idem from idem_begin(rm.tenant_id, 'create_room_block', p_idempotency_key, v_hash);
  if not v_idem.out_is_new then return v_idem.out_response; end if;

  perform lock_room_types(rm.property_id, array[rm.room_type_id]);

  select coalesce(jsonb_agg(jsonb_build_object(
           'claim_id', cl.id, 'claim_type', cl.claim_type, 'start', cl.start_date, 'end', cl.end_date,
           'reservation_id', r.id, 'booking_reference', r.booking_reference)), '[]'::jsonb),
         coalesce(bool_or(cl.claim_type = 'block'), false)
    into v_conf, v_has_block
    from room_inventory_claims cl
    left join reservation_rooms rr on rr.id = cl.reservation_room_id
    left join reservations r on r.id = rr.reservation_id
   where cl.room_id = p_room_id and cl.status = 'active'
     and daterange(cl.start_date, cl.end_date, '[)') && daterange(p_start, p_end, '[)');

  if jsonb_array_length(v_conf) > 0 then
    if p_resolution = 'fail' or v_has_block then
      v_result := jsonb_build_object('created', false, 'conflicts', v_conf);
      perform idem_finish(rm.tenant_id, 'create_room_block', p_idempotency_key, v_result);
      return v_result;
    end if;
    for mv in
      select cl.reservation_room_id, greatest(cl.start_date, p_start) as eff
        from room_inventory_claims cl
       where cl.room_id = p_room_id and cl.status = 'active' and cl.claim_type in ('stay','hold')
         and daterange(cl.start_date, cl.end_date, '[)') && daterange(p_start, p_end, '[)')
       order by cl.start_date
    loop
      v_moved := v_moved || transfer_claim_internal(mv.reservation_room_id, mv.eff, null);
    end loop;
  end if;

  v_block := claim_room(rm.property_id, null, p_room_id, p_start, p_end, 'block', null, null, p_reason, v_actor);
  v_result := jsonb_build_object('created', true, 'block_id', v_block, 'moved', v_moved);
  perform idem_finish(rm.tenant_id, 'create_room_block', p_idempotency_key, v_result);
  perform write_audit(rm.tenant_id, rm.property_id, v_actor, 'room.blocked', 'room', rm.id, p_idempotency_key,
                      jsonb_build_object('start', p_start, 'end', p_end, 'reason', p_reason, 'moved', jsonb_array_length(v_moved)));
  return v_result;
end $$;

create function release_room_block(p_block_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b room_inventory_claims%rowtype; v_actor uuid;
begin
  select * into b from room_inventory_claims where id = p_block_id and claim_type = 'block';
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(b.property_id, 'room.block', 'NOT_FOUND');
  update room_inventory_claims set status = 'released' where id = b.id and status = 'active';
  perform write_audit(b.tenant_id, b.property_id, v_actor, 'room.block_released', 'room', b.room_id, null,
                      jsonb_build_object('block_id', b.id));
  return jsonb_build_object('block_id', b.id, 'status', 'released');
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'cancel_reservation(uuid, text, text)', 'check_in(uuid, text)', 'check_out(uuid, text)',
    'transfer_room(uuid, uuid, date, text, text)', 'create_room_block(uuid, date, date, text, text, text)',
    'release_room_block(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke all on function transfer_claim_internal(uuid, date, uuid) from public, anon, authenticated;
