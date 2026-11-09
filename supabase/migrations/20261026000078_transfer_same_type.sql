-- 078 Room transfers stay within the booking's room type.
--
-- transfer_claim_internal (008) accepted any room of the property as an explicit target. The staff screens only offer rooms of
-- the same type, and say so ("Same room type only, so the price stays the same"), but nothing in the database enforced it, so
-- transfer_room called directly (or the calendar's move action posted by hand) could move a booking into a room of another
-- type: the booking keeps its type and price while the claim holds a different type's room.
-- Replaced with exactly its 008 body plus one check, made before any claim is released: a target room of another type in the
-- same property is refused with POLICY_VIOLATION. A target outside the property still gets the existing "invalid target room"
-- refusal, and a null target (first free room of the booking's type) is unchanged, which is how block resolution and stay
-- edits call it. Grants are kept by CREATE OR REPLACE.

create or replace function transfer_claim_internal(p_reservation_room_id uuid, p_effective date, p_new_room uuid)
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

  -- 078: an explicit target must be a room of the booking's own type. The booking page and the room calendar only offer
  -- same-type rooms ("so the price stays the same"), but this was enforced nowhere below them: a direct call could put a
  -- Standard booking in the only Solo Suite at the Standard price and break the per-type availability counts. Checked
  -- before anything is released, so a refusal changes nothing. A null target already searches the booking's own type.
  if p_new_room is not null and exists (select 1 from rooms where id = p_new_room and property_id = rr.property_id and room_type_id <> rr.room_type_id) then
    raise exception 'POLICY_VIOLATION: the new room must be of the same type as the booking' using errcode = 'P0001';
  end if;

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
