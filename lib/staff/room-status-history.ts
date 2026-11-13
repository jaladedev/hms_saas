import { formatShort } from "./housekeeping-tasks";

/** One row of room_status_history (migration 120). */
export type StatusEvent = { changed_at: string; field: string; from_value: string | null; to_value: string; actor_name: string | null };

const HOUSEKEEPING: Record<string, string> = { clean: "Clean", dirty: "Dirty", in_progress: "Being cleaned", inspected: "Inspected" };
const OPERATIONAL: Record<string, string> = { active: "In service", out_of_service: "Out of service", retired: "Retired" };

const word = (map: Record<string, string>, v: string | null) => (v === null ? "Not set" : (map[v] ?? v.replace(/_/g, " ")));

/**
 * One line of a room's status history, as the prototype shows it: "Dirty to Being cleaned", then who and when. A change made
 * with nobody signed in (the server finishing a job) has no name and reads "the system".
 */
export function statusEventLine(e: StatusEvent, timeZone: string): { title: string; detail: string } {
  const housekeeping = e.field === "housekeeping_status";
  const map = housekeeping ? HOUSEKEEPING : OPERATIONAL;
  const what = housekeeping ? "Housekeeping" : "Room";
  return {
    title: `${what}: ${word(map, e.from_value)} to ${word(map, e.to_value)}`,
    detail: `${e.actor_name ?? "the system"} · ${formatShort(e.changed_at, timeZone)}`,
  };
}
