-- 188 A staff note on a booking. `guest_note` is what the GUEST typed under "Special requests"; this is the hotel's own note ("late
-- arrival, will call from the airport", "paying by transfer on the day"). Rules, in one place:
--   * where: a column on reservations. Staff who may see the booking read it with the booking; it is NOT in any guest function, email,
--     document, the API or the channel feed (those name their columns, and none names this one).
--   * who writes: reservation.modify at the property, through set_reservation_note, in any booking status (a note on a cancelled or
--     finished booking is still useful). No direct table write: the table is read-only for clients.
--   * limits: up to 1000 characters, trimmed, line breaks kept; blank clears it.
--   * audit: `reservation.note_set` / `reservation.note_cleared`, with the length only, never the text.
alter table reservations add column staff_note text check (staff_note is null or char_length(staff_note) <= 1000);

create function set_reservation_note(p_reservation uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r reservations%rowtype; v_actor uuid := auth.uid();
  v_note text := nullif(btrim(replace(replace(coalesce(p_note, ''), E'\r\n', E'\n'), E'\r', E'\n')), '');
begin
  select * into r from reservations where id = p_reservation for update;
  if not found or v_actor is null or not has_permission(r.property_id, 'reservation.modify') then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  if length(coalesce(v_note, '')) > 1000 then raise exception 'POLICY_VIOLATION: staff note' using errcode = 'P0001'; end if;
  if r.staff_note is not distinct from v_note then return jsonb_build_object('reservation_id', r.id, 'changed', false); end if;
  update reservations set staff_note = v_note where id = r.id;
  perform write_audit(r.tenant_id, r.property_id, v_actor, case when v_note is null then 'reservation.note_cleared' else 'reservation.note_set' end,
                      'reservation', r.id, null, jsonb_build_object('length', coalesce(length(v_note), 0)));
  return jsonb_build_object('reservation_id', r.id, 'changed', true);
end $$;
revoke all on function set_reservation_note(uuid, text) from public, anon;
grant execute on function set_reservation_note(uuid, text) to authenticated;
