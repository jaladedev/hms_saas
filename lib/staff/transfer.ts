/** Rules for moving a booked guest to another room. Pure functions; the database enforces the same rules. */

import { compareRoomNumbers } from "./room-board";

/** YYYY-MM-DD plus n days, calendar arithmetic in UTC so it never shifts with a timezone. */
export function addDays(iso: string, n: number): string {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/**
 * Whether to offer the move: the person may assign rooms, the booking is still live, and this room has
 * not been checked out or cancelled. (transfer_room itself also accepts a held, unpaid online booking.)
 */
export function canTransfer(roomStatus: string, reservationStatus: string, mayAssign: boolean): boolean {
  return mayAssign
    && (roomStatus === "booked" || roomStatus === "checked_in")
    && (reservationStatus === "pending" || reservationStatus === "confirmed" || reservationStatus === "checked_in");
}

export type TransferWindow = { min: string; max: string; initial: string };

/**
 * The dates a move can start on: from today (or the arrival date if the stay has not begun) to the last
 * night. The database refuses the past and anything outside the stay. Null when no night is left.
 */
export function transferWindow(arrival: string, departure: string, today: string): TransferWindow | null {
  const min = today > arrival ? today : arrival;
  const max = addDays(departure, -1);
  return min > max ? null : { min, max, initial: min };
}

export type CandidateRoom = { id: string; room_number: string; room_type_id: string; operational_status: string };
export type ClaimSpan = { room_id: string; start_date: string; end_date: string };
export type RoomOption = { id: string; room_number: string; busy: boolean };

/**
 * Rooms the guest could move to: the same type, in service, not the room they are in. Moving to another type
 * would change what the guest gets without changing the price, so that is not offered. `busy` says the room
 * is claimed (stay, hold or block) for some of the nights from `from` to `until`; it is shown, not hidden,
 * because the person may choose a later start date on which the room is free. The database has the last word.
 */
export function candidateRooms(
  rooms: CandidateRoom[], typeId: string, exclude: Set<string>, from: string, until: string, claims: ClaimSpan[],
): RoomOption[] {
  return rooms
    .filter((r) => r.room_type_id === typeId && r.operational_status === "active" && !exclude.has(r.id))
    .sort((a, b) => compareRoomNumbers(a.room_number, b.room_number))
    .map((r) => ({
      id: r.id, room_number: r.room_number,
      busy: claims.some((c) => c.room_id === r.id && c.start_date < until && c.end_date > from),
    }));
}
