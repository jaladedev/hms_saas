/** Words and input rules for the guest "change my booking" page (migration 069). Pure, so it can be tested. The database decides again. */
import type { ChangeOptions } from "./server";

export type ChangeKind = "dates" | "room" | "other";
export type ChangeInput = { kind: ChangeKind; arrival: string | null; departure: string | null; message: string | null };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (v: string) => ISO.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** A request as the form sent it, or null when it cannot be one. Dates are only read for a dates request. */
export function parseChangeRequest(raw: { kind?: unknown; arrival?: unknown; departure?: unknown; message?: unknown }): ChangeInput | null {
  const kind = raw.kind;
  if (kind !== "dates" && kind !== "room" && kind !== "other") return null;
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (message.length > 500) return null;
  if (kind !== "dates") return message ? { kind, arrival: null, departure: null, message } : null;
  const arrival = typeof raw.arrival === "string" ? raw.arrival.trim() : "";
  const departure = typeof raw.departure === "string" ? raw.departure.trim() : "";
  if (!validDate(arrival) || !validDate(departure) || departure <= arrival) return null;
  return { kind, arrival, departure, message: message || null };
}

/** A phone number the way the database accepts it: digits, spaces and + ( ) - . only, 6 to 30 characters. */
export function parsePhone(raw: unknown): string | null {
  const v = typeof raw === "string" ? raw.trim() : "";
  return /^[0-9+()\-. ]{6,30}$/.test(v) ? v : null;
}

export function notAllowedChangeText(why: ChangeOptions["why_not"], status?: string): string {
  switch (why) {
    case "disabled": return "This hotel does not take booking changes online. Please contact the hotel.";
    case "started": return "Your stay has started, so it can no longer be changed online. Please talk to the front desk.";
    case "status": return status === "cancelled" ? "This booking was cancelled, so it cannot be changed." : "Only a confirmed booking can be changed online. Please contact the hotel.";
    default: return "";
  }
}

export function describeRequest(r: NonNullable<ChangeOptions["open_request"]>, formatDate: (iso: string) => string): string {
  if (r.kind === "dates" && r.arrival && r.departure) return `New dates: ${formatDate(r.arrival)} to ${formatDate(r.departure)}.`;
  return r.kind === "room" ? "A different room." : "A message to the hotel.";
}

export function answerText(a: NonNullable<ChangeOptions["last_answer"]>): string {
  return a.status === "done"
    ? `The hotel has dealt with your last request.${a.note ? ` They said: ${a.note}` : " Check your booking above for what changed."}`
    : `The hotel could not do your last request.${a.note ? ` They said: ${a.note}` : ""}`;
}
