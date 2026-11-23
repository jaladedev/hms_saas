/** The hotel's own note on a booking (migration 188). Not the guest's "special requests" (`guest_note`). Same limit as the database. */
export const MAX_STAFF_NOTE = 1000;

/** Same check as set_reservation_note, so a mistake is explained before the round trip. The database still decides. */
export function checkStaffNote(note: string): "staff_note" | null {
  return note.replace(/\r\n?/g, "\n").trim().length > MAX_STAFF_NOTE ? "staff_note" : null;
}
