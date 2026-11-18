import { parseNairaToKobo } from "@/lib/platform/hotel";
import type { EventErrorCode } from "./event-messages";

export { EVENT_ERROR_MESSAGES, EVENT_OK_MESSAGES, type EventErrorCode, type EventOkCode } from "./event-messages";

/**
 * Events: the staff side's pure helpers. Forms are read here and checked again by the database, which decides who may do what.
 * Times are the hotel's local date and time (a `datetime-local` field), never converted. Money is kobo.
 */

export const EVENT_TYPES = ["wedding", "conference", "meeting", "birthday", "party", "other"] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const EVENT_TYPE_LABEL: Record<string, string> = {
  wedding: "Wedding",
  conference: "Conference",
  meeting: "Meeting",
  birthday: "Birthday",
  party: "Party",
  ticketed: "Ticketed event",
  other: "Other",
};

export const LINE_KINDS = ["venue", "catering", "equipment", "decor", "other"] as const;
export const LINE_KIND_LABEL: Record<string, string> = {
  venue: "Venue",
  catering: "Catering",
  equipment: "Equipment",
  decor: "Decor",
  other: "Other",
};
export const MAX_QUOTE_LINES = 20;

export const BOOKING_STATUS_LABEL: Record<string, string> = {
  enquiry: "Enquiry",
  tentative: "Held",
  confirmed: "Confirmed",
  completed: "Completed",
  cancelled: "Cancelled",
  expired: "Hold ran out",
  declined: "Declined",
};
export const EVENT_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  on_sale: "On sale",
  closed: "Sales closed",
  cancelled: "Cancelled",
};
export const PAYMENT_METHODS = [
  ["cash", "Cash"],
  ["bank_transfer", "Bank transfer"],
  ["pos", "POS"],
  ["other", "Other"],
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** "2026-12-01T10:00" from a datetime-local field, as "2026-12-01T10:00:00" for the database; null when it is not a real date and time. */
export function parseLocalDateTime(value: unknown): string | null {
  const v = text(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::00)?$/.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || h > 23 || mi > 59) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "1 Dec 2026, 10:00" from a local timestamp the database returns. Anything else is shown as it came. */
export function formatLocal(ts: string | null | undefined): string {
  if (!ts) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(ts);
  if (!m) return ts;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}, ${m[4]}:${m[5]}`;
}
/** The value a datetime-local field takes, from a local timestamp the database returns. */
export function toInputLocal(ts: string | null | undefined): string {
  const m = ts ? /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(ts) : null;
  return m ? `${m[1]}T${m[2]}` : "";
}

/** Hours between two local timestamps, rounded up, for the "10 hours" label. */
export function hoursBetween(a: string, b: string): number {
  const t = (s: string) => Date.parse(`${s.slice(0, 16)}:00Z`);
  return Math.max(0, Math.ceil((t(b) - t(a)) / 3_600_000));
}

// ---- error wording ---------------------------------------------------------------------------------------------------------------------
/** Maps a database refusal to an event error code, or null when it is not an events refusal (the shared classifier then decides). */
export function classifyEventError(message: string): EventErrorCode | null {
  if (/VENUE_UNAVAILABLE/.test(message)) return "ev_unavailable";
  if (/SOLD_OUT/.test(message)) return "ev_sold_out";
  if (/POLICY_VIOLATION: (venue capacity|attendees)/.test(message)) return "ev_capacity";
  if (/INVALID_STATE: no lines/.test(message)) return "ev_no_lines";
  if (/PAYMENT_REQUIRED deposit/.test(message)) return "ev_deposit";
  if (/POLICY_VIOLATION: (past|too soon|block cannot start in the past)/.test(message)) return "ev_past";
  if (/POLICY_VIOLATION: contact/.test(message)) return "ev_contact";
  if (/POLICY_VIOLATION: total below paid/.test(message)) return "ev_below_paid";
  if (/INVALID_STATE: not on sale/.test(message)) return "ev_not_on_sale";
  if (/INVALID_STATE: has orders/.test(message)) return "ev_has_orders";
  if (/INVALID_STATE: no tickets/.test(message)) return "ev_no_tickets";
  if (/POLICY_VIOLATION: too many tickets/.test(message)) return "ev_too_many";
  if (/POLICY_VIOLATION: (limit|block limit|link limit|too many open)/.test(message)) return "ev_limit";
  if (/POLICY_VIOLATION: name taken/.test(message)) return "ev_name_taken";
  if (/POLICY_VIOLATION: below sold/.test(message)) return "ev_below_sold";
  if (/INVALID_STATE: used/.test(message)) return "ev_used";
  if (/INVALID_STATE: too early/.test(message)) return "ev_too_early";
  if (/INVALID_STATE: ticketed/.test(message)) return "ev_ticketed";
  if (/INVALID_STATE: cancelled/.test(message)) return "ev_cancelled";
  if (
    /POLICY_VIOLATION: (title|text|times|name|price|quantity|capacity|event type|email|phone|note|lines|line |rooms|dates|reason|max per order|sales close|items|status|mode|target|amount)/.test(
      message,
    )
  )
    return "ev_invalid";
  return null;
}

// ---- forms ----------------------------------------------------------------------------------------------------------------------------
type Raw = Record<string, unknown>;
export type Parsed<T> = { ok: true; value: T } | { ok: false };
const bad = { ok: false } as const;

/** A whole-number field. Empty is "no value". */
function whole(raw: unknown, min: number, max: number): number | null {
  const v = text(raw);
  if (!/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}
function percent(raw: unknown): number | null {
  const v = text(raw);
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(v)) return null;
  const n = Number(v);
  return n >= 0 && n <= 100 ? n : null;
}
/** Naira typed as 12,500.50 to kobo; null when it is empty or not an amount. */
export function nairaField(raw: unknown): number | null {
  const v = text(raw);
  return v === "" ? null : parseNairaToKobo(v);
}

export type VenueForm = {
  propertyId: string;
  venueId: string | null;
  name: string;
  body: string;
  capacity: number;
  hourlyMinor: number | null;
  dayMinor: number | null;
  online: boolean;
  active: boolean;
  sort: number;
};
export function parseVenueForm(raw: Raw): Parsed<VenueForm> {
  const propertyId = text(raw.propertyId);
  const venueId = text(raw.venueId);
  const name = text(raw.name);
  const body = text(raw.body);
  const capacity = whole(raw.capacity, 1, 100000);
  const hourly = nairaField(raw.hourly);
  const day = nairaField(raw.day);
  const sort = text(raw.sort) === "" ? 0 : Number(text(raw.sort));
  if (!isUuid(propertyId) || (venueId !== "" && !isUuid(venueId))) return bad;
  if (name.length < 1 || name.length > 60 || body.length > 200 || capacity === null) return bad;
  if (text(raw.hourly) !== "" && hourly === null) return bad;
  if (text(raw.day) !== "" && day === null) return bad;
  if ((hourly === null && day === null) || (hourly !== null && (hourly < 1 || hourly > 1e9)) || (day !== null && (day < 1 || day > 1e9)))
    return bad;
  if (!Number.isInteger(sort) || sort < -1000 || sort > 1000) return bad;
  return {
    ok: true,
    value: {
      propertyId,
      venueId: venueId === "" ? null : venueId,
      name,
      body,
      capacity,
      hourlyMinor: hourly,
      dayMinor: day,
      online: raw.online === "on",
      active: raw.active === "on",
      sort,
    },
  };
}

export type TermsForm = { propertyId: string; tax: number; service: number; deposit: number; holdHours: number };
export function parseTermsForm(raw: Raw): Parsed<TermsForm> {
  const propertyId = text(raw.propertyId);
  const tax = percent(raw.tax);
  const service = percent(raw.service);
  const deposit = whole(raw.deposit, 0, 100);
  const holdHours = whole(raw.holdHours, 1, 720);
  if (!isUuid(propertyId) || tax === null || service === null || deposit === null || holdHours === null) return bad;
  return { ok: true, value: { propertyId, tax, service, deposit, holdHours } };
}

export type BookingForm = {
  propertyId: string;
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
  hold: boolean;
};
export function parseBookingForm(raw: Raw): Parsed<BookingForm> {
  const propertyId = text(raw.propertyId);
  const venueId = text(raw.venueId);
  const startsAt = parseLocalDateTime(raw.startsAt);
  const endsAt = parseLocalDateTime(raw.endsAt);
  const eventType = text(raw.eventType) || "other";
  const title = text(raw.title);
  const name = text(raw.name);
  const email = text(raw.email);
  const phone = text(raw.phone);
  const note = text(raw.note);
  const attendees = whole(raw.attendees, 1, 100000);
  if (!isUuid(propertyId) || !isUuid(venueId) || !startsAt || !endsAt || startsAt >= endsAt || attendees === null) return bad;
  if (!(EVENT_TYPES as readonly string[]).includes(eventType)) return bad;
  if (name.length < 1 || name.length > 80 || title.length > 80 || note.length > 500) return bad;
  if (email === "" && phone === "") return bad;
  return {
    ok: true,
    value: {
      propertyId,
      venueId,
      startsAt,
      endsAt,
      eventType: eventType as EventType,
      title,
      name,
      email,
      phone,
      attendees,
      note,
      hold: raw.hold === "on",
    },
  };
}

export type QuoteLine = { kind: string; description: string; quantity: number; unit_amount_minor: number };
/** The quote rows: fields kind_0, desc_0, qty_0, price_0 and so on. A row with no description and no price is skipped. */
export function parseQuoteLines(raw: Raw): Parsed<QuoteLine[]> {
  const lines: QuoteLine[] = [];
  for (let i = 0; i < MAX_QUOTE_LINES; i++) {
    const description = text(raw[`desc_${i}`]);
    const priceRaw = text(raw[`price_${i}`]);
    if (description === "" && priceRaw === "") continue;
    const kind = text(raw[`kind_${i}`]) || "other";
    const quantity = whole(raw[`qty_${i}`] ?? "1", 1, 10000);
    const price = nairaField(priceRaw === "" ? "0" : priceRaw);
    if (!(LINE_KINDS as readonly string[]).includes(kind) || description.length < 1 || description.length > 120) return bad;
    if (quantity === null || price === null || price > 1e9) return bad;
    lines.push({ kind, description, quantity, unit_amount_minor: price });
  }
  return lines.length === 0 ? bad : { ok: true, value: lines };
}

export type MoneyForm = { amountMinor: number; method: string; reference: string; note: string };
export function parseMoneyForm(raw: Raw, methods: readonly string[] = PAYMENT_METHODS.map((m) => m[0])): Parsed<MoneyForm> {
  const amountMinor = nairaField(raw.amount);
  const method = text(raw.method);
  const reference = text(raw.reference);
  const note = text(raw.note);
  if (amountMinor === null || amountMinor < 1 || !methods.includes(method) || reference.length > 80 || note.length > 200) return bad;
  return { ok: true, value: { amountMinor, method, reference, note } };
}

export type EventForm = {
  propertyId: string;
  eventId: string | null;
  title: string;
  body: string;
  venueId: string | null;
  startsAt: string;
  endsAt: string;
  maxPerOrder: number;
  salesCloseAt: string | null;
};
export function parseEventForm(raw: Raw): Parsed<EventForm> {
  const propertyId = text(raw.propertyId);
  const eventId = text(raw.eventId);
  const venueId = text(raw.venueId);
  const title = text(raw.title);
  const body = text(raw.body);
  const startsAt = parseLocalDateTime(raw.startsAt);
  const endsAt = parseLocalDateTime(raw.endsAt);
  const closeRaw = text(raw.salesCloseAt);
  const salesCloseAt = closeRaw === "" ? null : parseLocalDateTime(closeRaw);
  const maxPerOrder = whole(raw.maxPerOrder, 1, 50);
  if (!isUuid(propertyId) || (eventId !== "" && !isUuid(eventId)) || (venueId !== "" && !isUuid(venueId))) return bad;
  if (title.length < 1 || title.length > 80 || body.length > 500 || !startsAt || !endsAt || startsAt >= endsAt || maxPerOrder === null)
    return bad;
  if (closeRaw !== "" && (salesCloseAt === null || salesCloseAt > endsAt)) return bad;
  return {
    ok: true,
    value: {
      propertyId,
      eventId: eventId === "" ? null : eventId,
      title,
      body,
      venueId: venueId === "" ? null : venueId,
      startsAt,
      endsAt,
      maxPerOrder,
      salesCloseAt,
    },
  };
}

export type TicketTypeForm = {
  eventId: string;
  typeId: string | null;
  name: string;
  priceMinor: number;
  quantity: number;
  active: boolean;
  sort: number;
};
export function parseTicketTypeForm(raw: Raw): Parsed<TicketTypeForm> {
  const eventId = text(raw.eventId);
  const typeId = text(raw.typeId);
  const name = text(raw.name);
  const priceRaw = text(raw.price);
  const priceMinor = priceRaw === "" ? 0 : nairaField(priceRaw);
  const quantity = whole(raw.quantity, 1, 100000);
  const sort = text(raw.sort) === "" ? 0 : Number(text(raw.sort));
  if (!isUuid(eventId) || (typeId !== "" && !isUuid(typeId)) || name.length < 1 || name.length > 40) return bad;
  if (priceMinor === null || priceMinor > 1e9 || quantity === null || !Number.isInteger(sort) || sort < -1000 || sort > 1000) return bad;
  return {
    ok: true,
    value: { eventId, typeId: typeId === "" ? null : typeId, name, priceMinor, quantity, active: raw.active === "on", sort },
  };
}

export type SellForm = {
  propertyId: string;
  eventId: string;
  items: { ticket_type_id: string; quantity: number }[];
  name: string;
  email: string;
  phone: string;
  method: string;
  reference: string;
};
/** The desk sale: fields qty_<ticket type id> for each type, and the buyer. At most 5 types, at least one ticket. */
export function parseSellForm(raw: Raw): Parsed<SellForm> {
  const propertyId = text(raw.propertyId);
  const eventId = text(raw.eventId);
  const name = text(raw.name);
  const email = text(raw.email);
  const phone = text(raw.phone);
  const method = text(raw.method);
  const reference = text(raw.reference);
  if (!isUuid(propertyId) || !isUuid(eventId) || name.length < 1 || name.length > 80 || (email === "" && phone === "")) return bad;
  if (!PAYMENT_METHODS.some((m) => m[0] === method) || reference.length > 80) return bad;
  const items: { ticket_type_id: string; quantity: number }[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith("qty_")) continue;
    const id = key.slice(4);
    const q = text(value);
    if (q === "" || q === "0") continue;
    const n = whole(q, 1, 50);
    if (!isUuid(id) || n === null) return bad;
    items.push({ ticket_type_id: id, quantity: n });
  }
  if (items.length < 1 || items.length > 5) return bad;
  return { ok: true, value: { propertyId, eventId, items, name, email, phone, method, reference } };
}

/** The door's answer for a failed check-in. */
export function checkInProblem(message: string): "unknown" | "used" | "void" | "wrong_event" | "forbidden" | "other" {
  if (/NOT_FOUND: ticket/.test(message)) return "unknown";
  if (/INVALID_STATE: used/.test(message)) return "used";
  if (/INVALID_STATE: void/.test(message)) return "void";
  if (/INVALID_STATE: wrong event/.test(message)) return "wrong_event";
  if (/NOT_FOUND/.test(message)) return "forbidden";
  return "other";
}

// ---- reading what the database returns -----------------------------------------------------------------------------------------------
export type VenueRow = {
  id: string;
  property_id: string;
  name: string;
  body: string;
  capacity: number;
  hourly_rate_minor: number | null;
  day_rate_minor: number | null;
  bookable_online: boolean;
  is_active: boolean;
  sort_order: number;
};
export type BookingRow = {
  id: string;
  property_id: string;
  venue_id: string;
  reference: string;
  status: string;
  source: string;
  event_type: string;
  title: string;
  contact_name: string;
  contact_email: string | null;
  contact_phone: string | null;
  attendees: number;
  starts_at: string;
  ends_at: string;
  hold_expires_at: string | null;
  note: string | null;
  currency: string;
  tax_percent: number;
  service_percent: number;
  deposit_percent: number;
  subtotal_minor: number;
  service_minor: number;
  tax_minor: number;
  total_minor: number;
  deposit_minor: number;
  deposit_waived: boolean;
  attention_reason: string | null;
  cancel_reason: string | null;
  created_at: string;
};

/** What a held booking still needs, in words for the badge. */
export function bookingNeed(b: Pick<BookingRow, "status" | "deposit_minor" | "total_minor">, paid: number): string | null {
  if (b.status === "tentative") return paid >= b.deposit_minor ? null : "Deposit due";
  if (b.status === "confirmed" || b.status === "completed") return paid >= b.total_minor ? null : "Balance due";
  return null;
}

export const ATTENTION_LABEL: Record<string, string> = {
  paid_slot_lost: "Paid, but the slot was taken meanwhile. Contact the client and refund or move the booking.",
  paid_after_expiry: "Paid after the order lapsed and the tickets were gone. Refund the buyer.",
  paid_after_cancel: "Paid after the order was cancelled. Refund the buyer.",
  payment_amount_or_currency_mismatch: "A payment came in that does not match what was asked. Check it with the provider.",
  payment_overpayment: "A payment came in that is more than is owed. Check it with the provider and refund the difference.",
};
