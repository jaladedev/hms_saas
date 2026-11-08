-- 068 Blocking a room that has bookings: a third way out, "cancel".
--
-- 'fail' reports the conflicts, 'move' shifts each stay to another room of the same type,
-- and now 'cancel' cancels the conflicting reservations on the hotel's side.
--   * It needs reservation.cancel as well as room.block, because it is a cancellation.
--   * The cancellation charge is waived: the hotel is the one breaking the booking.
--   * Money goes through the ordinary cancellation settlement (the status change fires it), so
--     any amount paid becomes a refund request for the usual two-person approval, and the guest
--     gets the usual "booking cancelled" email.
--   * A reservation cancels as a whole, even when only one of its rooms is the blocked one.
--   * A guest already in the house cannot be cancelled. If any conflict is in-house, nothing
--     changes and the result says so ('in_house': true), so the person can move or release.
--   * Conflicting blocks are never cancelled: they still stop the request.
-- Everything is one transaction: if any step fails, no booking is cancelled and no block exists.
create or replace function create_room_block(p_room_id uuid, p_start date, p_end date, p_reason text,
                                             p_resolution text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  rm rooms%rowtype; v_actor uuid; v_idem record; v_hash text; v_conf jsonb; v_has_block boolean;
  mv record; v_block uuid; v_result jsonb; v_moved jsonb := '[]'::jsonb; v_cancelled jsonb := '[]'::jsonb;
  v_in_house boolean := false; v_ref record; v_res jsonb;
begin
  select * into rm from rooms where id = p_room_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  v_actor := require_permission(rm.property_id, 'room.block', 'NOT_FOUND');
  if p_reason is null or length(trim(p_reason)) = 0 or p_start >= p_end
     or p_resolution not in ('fail', 'move', 'cancel') then
    raise exception 'POLICY_VIOLATION: invalid block request' using errcode = 'P0001';
  end if;
  if p_resolution = 'cancel' and not has_permission(rm.property_id, 'reservation.cancel') then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
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
    if p_resolution = 'cancel' and not v_has_block then
      v_in_house := exists (
        select 1 from room_inventory_claims cl
          join reservation_rooms rr on rr.id = cl.reservation_room_id
         where cl.room_id = p_room_id and cl.status = 'active' and cl.claim_type in ('stay','hold')
           and daterange(cl.start_date, cl.end_date, '[)') && daterange(p_start, p_end, '[)')
           and exists (select 1 from reservation_rooms x where x.reservation_id = rr.reservation_id
                        and x.room_status in ('checked_in', 'checked_out')));
    end if;
    if p_resolution = 'fail' or v_has_block or v_in_house then
      v_result := jsonb_build_object('created', false, 'conflicts', v_conf) ||
                  case when v_in_house then jsonb_build_object('in_house', true) else '{}'::jsonb end;
      perform idem_finish(rm.tenant_id, 'create_room_block', p_idempotency_key, v_result);
      return v_result;
    end if;

    if p_resolution = 'move' then
      for mv in
        select cl.reservation_room_id, greatest(cl.start_date, p_start) as eff
          from room_inventory_claims cl
         where cl.room_id = p_room_id and cl.status = 'active' and cl.claim_type in ('stay','hold')
           and daterange(cl.start_date, cl.end_date, '[)') && daterange(p_start, p_end, '[)')
         order by cl.start_date
      loop
        v_moved := v_moved || transfer_claim_internal(mv.reservation_room_id, mv.eff, null);
      end loop;
    else
      for v_ref in
        select distinct rr.reservation_id
          from room_inventory_claims cl
          join reservation_rooms rr on rr.id = cl.reservation_room_id
         where cl.room_id = p_room_id and cl.status = 'active' and cl.claim_type in ('stay','hold')
           and daterange(cl.start_date, cl.end_date, '[)') && daterange(p_start, p_end, '[)')
         order by rr.reservation_id
      loop
        v_res := cancel_reservation_apply(v_ref.reservation_id, 'Room blocked by the hotel: ' || trim(p_reason),
                                          v_actor, 'staff', p_idempotency_key || ':' || v_ref.reservation_id, null, true);
        v_cancelled := v_cancelled || jsonb_build_array(v_res);
      end loop;
    end if;
  end if;

  v_block := claim_room(rm.property_id, null, p_room_id, p_start, p_end, 'block', null, null, p_reason, v_actor);
  v_result := jsonb_build_object('created', true, 'block_id', v_block, 'moved', v_moved, 'cancelled', v_cancelled);
  perform idem_finish(rm.tenant_id, 'create_room_block', p_idempotency_key, v_result);
  perform write_audit(rm.tenant_id, rm.property_id, v_actor, 'room.blocked', 'room', rm.id, p_idempotency_key,
                      jsonb_build_object('start', p_start, 'end', p_end, 'reason', p_reason,
                                         'moved', jsonb_array_length(v_moved), 'cancelled', jsonb_array_length(v_cancelled)));
  return v_result;
end $$;
