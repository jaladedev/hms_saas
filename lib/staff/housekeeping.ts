/**
 * The housekeeping worklist: which rooms need cleaning, in what order. Pure functions, so they can be tested.
 * It uses only rooms and their inventory claims, which housekeeping staff may read; it never needs guest or
 * booking details.
 */
import { compareRoomNumbers, type BoardClaim, type BoardRoom } from "./room-board";

export type WorkItem = {
  room: BoardRoom;
  /** A guest is due to arrive today: the room should be ready first. */
  arrivesToday: boolean;
  /** A stay on this room ends today. */
  departsToday: boolean;
  /** Someone has the room tonight (a booking covers today). */
  bookedTonight: boolean;
  /** Blocked for maintenance or similar today. */
  blockedToday: boolean;
};

export type Worklist = {
  /** Dirty and a guest arrives today: do these first. */
  urgent: WorkItem[];
  /** Dirty, nobody arriving today. */
  toClean: WorkItem[];
  /** Being cleaned right now. */
  inProgress: WorkItem[];
  /** Clean or inspected, for the summary line. */
  ready: number;
  /** Rooms left out because they are retired or out of service. */
  skipped: number;
};

const byFloorThenNumber = (a: WorkItem, b: WorkItem) =>
  (a.room.floor ?? Number.MAX_SAFE_INTEGER) - (b.room.floor ?? Number.MAX_SAFE_INTEGER) ||
  compareRoomNumbers(a.room.room_number, b.room.room_number);

/** `today` maps property id to its own YYYY-MM-DD; a room of an unknown property is treated as having no activity. */
export function buildWorklist(rooms: BoardRoom[], claims: BoardClaim[], today: Map<string, string>): Worklist {
  const byRoom = new Map<string, BoardClaim[]>();
  for (const c of claims) byRoom.set(c.room_id, [...(byRoom.get(c.room_id) ?? []), c]);

  const out: Worklist = { urgent: [], toClean: [], inProgress: [], ready: 0, skipped: 0 };
  for (const room of rooms) {
    if (room.operational_status !== "active") {
      out.skipped += 1;
      continue;
    }
    const t = today.get(room.property_id) ?? "";
    const mine = byRoom.get(room.id) ?? [];
    const stays = mine.filter((c) => c.claim_type === "stay" || c.claim_type === "hold");
    const item: WorkItem = {
      room,
      arrivesToday: t !== "" && stays.some((c) => c.start_date === t),
      departsToday: t !== "" && stays.some((c) => c.end_date === t),
      bookedTonight: t !== "" && stays.some((c) => c.start_date <= t && c.end_date > t),
      blockedToday: t !== "" && mine.some((c) => c.claim_type === "block" && c.start_date <= t && c.end_date > t),
    };
    if (room.housekeeping_status === "dirty") (item.arrivesToday ? out.urgent : out.toClean).push(item);
    else if (room.housekeeping_status === "in_progress") out.inProgress.push(item);
    else out.ready += 1;
  }
  out.urgent.sort(byFloorThenNumber);
  out.toClean.sort(byFloorThenNumber);
  out.inProgress.sort(byFloorThenNumber);
  return out;
}

/** The one sensible next status for a room, or null when there is nothing for a cleaner to do. */
export function nextStatus(status: string): { to: "in_progress" | "clean"; label: string } | null {
  if (status === "dirty") return { to: "in_progress", label: "Start cleaning" };
  if (status === "in_progress") return { to: "clean", label: "Mark clean" };
  return null;
}
