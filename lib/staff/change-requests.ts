/** Reading the guest change-request queue (migration 069). Pure, so it can be tested. */
export type ChangeRequestRow = {
  id: string; property_id: string; reservation_id: string; kind: "dates" | "room" | "other";
  requested_arrival: string | null; requested_departure: string | null; message: string | null;
  status: "open" | "done" | "declined" | "withdrawn"; resolution_note: string | null; created_at: string; resolved_at: string | null;
  reservations: { booking_reference: string; arrival_date: string; departure_date: string } | null;
};

export const CHANGE_REQUEST_COLUMNS =
  "id, property_id, reservation_id, kind, requested_arrival, requested_departure, message, status, resolution_note, created_at, resolved_at, reservations(booking_reference, arrival_date, departure_date)";

export type RequestView = "open" | "answered";
export const parseRequestView = (v: unknown): RequestView => (v === "answered" ? "answered" : "open");

export function kindLabel(kind: ChangeRequestRow["kind"]): string {
  return kind === "dates" ? "Different dates" : kind === "room" ? "Different room" : "Message";
}

/** What the guest asked for, in one line: "Different dates: 12 Nov to 15 Nov (now 12 Nov to 14 Nov)". */
export function askText(r: ChangeRequestRow, fmt: (iso: string) => string): string {
  if (r.kind === "dates" && r.requested_arrival && r.requested_departure) {
    const now = r.reservations ? ` (booked ${fmt(r.reservations.arrival_date)} to ${fmt(r.reservations.departure_date)})` : "";
    return `Different dates: ${fmt(r.requested_arrival)} to ${fmt(r.requested_departure)}${now}`;
  }
  return kindLabel(r.kind);
}

export function statusLabel(s: ChangeRequestRow["status"]): string {
  return s === "open" ? "Waiting" : s === "done" ? "Dealt with" : s === "declined" ? "Declined" : "Withdrawn by the guest";
}

export function parseRequests(data: unknown): ChangeRequestRow[] {
  return Array.isArray(data) ? (data as ChangeRequestRow[]).filter((r) => r && typeof r.id === "string") : [];
}
