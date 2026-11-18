import { classifyEventError, EVENT_TYPES, isUuid, parseLocalDateTime, type EventType } from "@/lib/staff/events";
import type { GuestError } from "./errors";

/** What a guest is told when the database refuses an events request. Never the database's own words. */
export function guestEventError(message: string): GuestError {
  if (/POLICY_VIOLATION: (too far|not bookable online)/.test(message)) {
    return { code: "ev_when", message: "That date cannot be booked online. Send the hotel an enquiry instead." };
  }
  if (/NOT_FOUND/.test(message)) return { code: "ev_gone", message: "That venue or event is no longer available." };
  switch (classifyEventError(message)) {
    case "ev_unavailable":
      return { code: "ev_unavailable", message: "Sorry, that venue was just taken for part of that time. Please choose another time." };
    case "ev_sold_out":
      return { code: "ev_sold_out", message: "Sorry, there are not enough tickets left of that type." };
    case "ev_capacity":
      return { code: "ev_capacity", message: "That is more people than the venue holds." };
    case "ev_past":
      return {
        code: "ev_past",
        message: "That is too soon for online booking, which needs at least 48 hours' notice. Send the hotel an enquiry instead.",
      };
    case "ev_too_many":
      return { code: "ev_too_many", message: "That is more tickets than one order may hold for this event." };
    case "ev_limit":
      return {
        code: "ev_limit",
        message: "You already have several open requests with this hotel. Please wait for the hotel, or pay for one of them first.",
      };
    case "ev_not_on_sale":
      return { code: "ev_not_on_sale", message: "Tickets for this event are not on sale." };
    case "ev_contact":
    case "ev_invalid":
      return { code: "ev_invalid", message: "Please check your details: the dates and times, your name, email address and the numbers." };
    default:
      return { code: "unknown", message: "Something went wrong. Please try again, or contact the hotel." };
  }
}

export type VenueRequest = {
  venueId: string;
  startsAt: string;
  endsAt: string;
  eventType: EventType;
  title: string;
  name: string;
  email: string;
  phone: string;
  attendees: number;
  note: string;
  mode: "enquiry" | "book";
};

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The website's venue form. The database checks everything again (lead time, capacity, overlaps). */
export function parseVenueRequest(raw: Record<string, unknown>): { ok: true; value: VenueRequest } | { ok: false } {
  const venueId = text(raw.venueId);
  const startsAt = parseLocalDateTime(raw.startsAt);
  const endsAt = parseLocalDateTime(raw.endsAt);
  const eventType = text(raw.eventType) || "other";
  const attendeesRaw = text(raw.attendees);
  const attendees = /^\d{1,6}$/.test(attendeesRaw) ? Number(attendeesRaw) : 0;
  const name = text(raw.name);
  const email = text(raw.email);
  const phone = text(raw.phone);
  const title = text(raw.title);
  const note = text(raw.note);
  const mode = text(raw.mode);
  if (!isUuid(venueId) || !startsAt || !endsAt || startsAt >= endsAt || attendees < 1) return { ok: false };
  if (!(EVENT_TYPES as readonly string[]).includes(eventType)) return { ok: false };
  if (mode !== "enquiry" && mode !== "book") return { ok: false };
  if (name.length < 1 || name.length > 80 || title.length > 80 || note.length > 500 || phone.length > 40) return { ok: false };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 120) return { ok: false };
  return {
    ok: true,
    value: { venueId, startsAt, endsAt, eventType: eventType as EventType, title, name, email, phone, attendees, note, mode },
  };
}

export type TicketOrderForm = {
  eventId: string;
  items: { ticket_type_id: string; quantity: number }[];
  name: string;
  email: string;
  phone: string;
};

/** The website's ticket form: fields qty_<ticket type id>. At most 5 types, at least one ticket. */
export function parseTicketOrder(raw: Record<string, unknown>): { ok: true; value: TicketOrderForm } | { ok: false } {
  const eventId = text(raw.eventId);
  const name = text(raw.name);
  const email = text(raw.email);
  const phone = text(raw.phone);
  if (!isUuid(eventId) || name.length < 1 || name.length > 80 || phone.length > 40) return { ok: false };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 120) return { ok: false };
  const items: { ticket_type_id: string; quantity: number }[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith("qty_")) continue;
    const id = key.slice(4);
    const q = text(value);
    if (q === "" || q === "0") continue;
    if (!isUuid(id) || !/^\d{1,2}$/.test(q) || Number(q) < 1 || Number(q) > 50) return { ok: false };
    items.push({ ticket_type_id: id, quantity: Number(q) });
  }
  if (items.length < 1 || items.length > 5) return { ok: false };
  return { ok: true, value: { eventId, items, name, email, phone } };
}

const SAMPLES = [
  "VENUE_UNAVAILABLE",
  "SOLD_OUT",
  "POLICY_VIOLATION: venue capacity",
  "POLICY_VIOLATION: too soon",
  "POLICY_VIOLATION: too many tickets",
  "POLICY_VIOLATION: too many open",
  "INVALID_STATE: not on sale",
  "POLICY_VIOLATION: email",
  "POLICY_VIOLATION: too far",
  "NOT_FOUND",
  "other",
];
const OWN: Record<string, string> = {
  bad_request: "Please check your details and try again.",
  rate_limited: "You have tried that a few times. Please wait a little and try again.",
  payment_unavailable: "Payment could not be opened just now. Please try again in a moment.",
};

/** The words for a code carried in a redirect URL. Unknown codes are not echoed back. */
export function eventNotice(code: string | undefined): string | null {
  if (!code) return null;
  if (code in OWN) return OWN[code]!;
  for (const s of SAMPLES) {
    const e = guestEventError(s);
    if (e.code === code) return e.message;
  }
  return null;
}
