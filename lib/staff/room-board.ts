/** Works out what each room is doing today for the room board. Pure functions, so they can be tested. */

export type BoardRoom = {
  id: string; property_id: string; room_type_id: string; room_number: string; floor: number | null;
  operational_status: string; housekeeping_status: string;
};
export type BoardClaim = {
  room_id: string; claim_type: string; start_date: string; end_date: string;
  reservation_room_id: string | null; block_reason: string | null;
};

export type RoomState = "retired" | "out_of_service" | "occupied" | "arriving" | "held" | "blocked" | "vacant";

export type RoomView = {
  room: BoardRoom;
  state: RoomState;
  /** The claim that decides the state today (the stay, hold or block covering today). */
  current: BoardClaim | null;
  /** The next stay, hold or block that starts after today, for vacant rooms. */
  next: BoardClaim | null;
};

export const STATE_LABEL: Record<RoomState, string> = {
  retired: "Retired", out_of_service: "Out of service", occupied: "Occupied", arriving: "Booked tonight",
  held: "On hold", blocked: "Blocked", vacant: "Vacant",
};

/**
 * `checkedIn` holds the reservation-room ids whose guest has checked in. A stay claim covering today is
 * "occupied" when its guest is in the room and "arriving" when they have yet to check in. Room status
 * outranks claims: an out-of-service room is shown that way even if a stay is booked on it, because
 * that booking needs moving.
 */
export function roomViews(rooms: BoardRoom[], claims: BoardClaim[], checkedIn: Set<string>, today: Map<string, string>): RoomView[] {
  const byRoom = new Map<string, BoardClaim[]>();
  for (const c of claims) byRoom.set(c.room_id, [...(byRoom.get(c.room_id) ?? []), c]);

  return rooms.map((room): RoomView => {
    const mine = (byRoom.get(room.id) ?? []).sort((a, b) => a.start_date.localeCompare(b.start_date));
    const t = today.get(room.property_id) ?? "";
    const current = mine.find((c) => c.start_date <= t && c.end_date > t) ?? null;
    const next = mine.find((c) => c.start_date > t) ?? null;
    if (room.operational_status === "retired") return { room, state: "retired", current, next };
    if (room.operational_status === "out_of_service") return { room, state: "out_of_service", current, next };
    if (!current) return { room, state: "vacant", current: null, next };
    if (current.claim_type === "block") return { room, state: "blocked", current, next };
    if (current.claim_type === "hold") return { room, state: "held", current, next };
    const inHouse = current.reservation_room_id !== null && checkedIn.has(current.reservation_room_id);
    return { room, state: inHouse ? "occupied" : "arriving", current, next };
  });
}

export type StateCounts = Record<RoomState, number>;
export function countStates(views: RoomView[]): StateCounts {
  const c: StateCounts = { retired: 0, out_of_service: 0, occupied: 0, arriving: 0, held: 0, blocked: 0, vacant: 0 };
  for (const v of views) c[v.state] += 1;
  return c;
}

/** Natural order for room numbers: 2 before 10, 101 before 101A. */
export function compareRoomNumbers(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}
