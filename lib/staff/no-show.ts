/** The no-show form and when to offer it (migration 037). The database decides again: it also needs check-in time to have passed. */
import type { ErrorCode } from "./refunds";

export const NOTE_MAX = 200;

/** Offered to someone who may cancel, for a confirmed booking with nobody in the room, from the arrival date on. */
export function canMarkNoShow(a: {
  reservationStatus: string;
  rooms: { room_status: string }[];
  canCancel: boolean;
  today: string;
  arrival: string;
}): boolean {
  return (
    a.canCancel &&
    a.reservationStatus === "confirmed" &&
    a.rooms.length > 0 &&
    a.rooms.every((r) => r.room_status === "booked") &&
    a.today >= a.arrival
  );
}

export type NoShowForm = { note: string | null; waive: boolean };

export function parseNoShowForm(raw: Record<string, unknown>): { ok: true; value: NoShowForm } | { ok: false; code: ErrorCode } {
  const note = typeof raw.note === "string" ? raw.note.trim() : "";
  if (note.length > NOTE_MAX) return { ok: false, code: "ns_note" };
  return { ok: true, value: { note: note || null, waive: raw.waive === "on" } };
}
