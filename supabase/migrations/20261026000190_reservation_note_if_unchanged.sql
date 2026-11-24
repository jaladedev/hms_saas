-- 190 A staff note saved offline is applied only if nobody changed the note meanwhile (offline step 2b, booking notes).
--
-- A staff note REPLACES the whole text (188). A charge or a payment made offline only adds something, but a note replayed an hour
-- later from an old copy of the page could silently wipe out a newer note another person saved in the meantime. So a note that waited
-- for the connection is sent with the text it replaced (`p_expected`, what the page showed when the person started typing) and the
-- database applies it only while the booking's note is still that text:
--   * the note is already the new text         -> nothing to do (changed = false); this also makes sending it twice harmless;
--   * the note is still `p_expected`           -> saved, audited as in 188;
--   * anything else (someone else changed it) -> 'CONFLICT: staff note changed', nothing written. The app keeps the person's text and
--     shows it, so nothing typed is lost.
-- `p_expected` is cleaned the same way as a note (trimmed, line breaks normalised, blank is "no note"), so an empty page and a null note
-- match. `p_at` is the time the person saved it, kept inside the bounds of migration 185 (hk_effective_time); the audit records
-- `made_at` and `received_at` when it is sent. set_reservation_note (188) is unchanged: an online save is still the person's decision
-- on a page they are looking at.
-- Same permission as 188: reservation.modify at the property, any booking status. Authenticated only.
create function set_reservation_note_if_unchanged(p_reservation uuid, p_note text, p_expected text, p_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r reservations%rowtype; v_actor uuid := auth.uid(); v_at timestamptz;
  v_note text := nullif(btrim(replace(replace(coalesce(p_note, ''), E'\r\n', E'\n'), E'\r', E'\n')), '');
  v_expected text := nullif(btrim(replace(replace(coalesce(p_expected, ''), E'\r\n', E'\n'), E'\r', E'\n')), '');
begin
  select * into r from reservations where id = p_reservation for update;
  if not found or v_actor is null or not has_permission(r.property_id, 'reservation.modify') then
    raise exception 'NOT_FOUND' using errcode = 'P0001';
  end if;
  if length(coalesce(v_note, '')) > 1000 then raise exception 'POLICY_VIOLATION: staff note' using errcode = 'P0001'; end if;
  if r.staff_note is not distinct from v_note then return jsonb_build_object('reservation_id', r.id, 'changed', false); end if;
  if r.staff_note is distinct from v_expected then raise exception 'CONFLICT: staff note changed' using errcode = 'P0001'; end if;

  v_at := hk_effective_time(p_at, r.created_at);
  update reservations set staff_note = v_note where id = r.id;
  perform write_audit(r.tenant_id, r.property_id, v_actor, case when v_note is null then 'reservation.note_cleared' else 'reservation.note_set' end,
                      'reservation', r.id, null,
                      jsonb_build_object('length', coalesce(length(v_note), 0))
                      || case when p_at is null then '{}'::jsonb else jsonb_build_object('made_at', v_at, 'received_at', now()) end);
  return jsonb_build_object('reservation_id', r.id, 'changed', true);
end $$;
revoke all on function set_reservation_note_if_unchanged(uuid, text, text, timestamptz) from public, anon;
grant execute on function set_reservation_note_if_unchanged(uuid, text, text, timestamptz) to authenticated;
