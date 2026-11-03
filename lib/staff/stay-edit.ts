/**
 * Editing a booking's dates and guests (migration 033, `update_reservation_stay`). Pure functions, so they can be tested.
 * The database decides who may do what and checks every rule again; these helpers decide whether the form is worth
 * showing, check its shape, and word the refusals.
 *
 * The rule the screen explains: dates and guest numbers change only while NOTHING is paid and no live invoice exists,
 * because a changed total would break the money code (one invoice equal to the total, payments capped at it). Past
 * that point the booking is cancelled and booked again.
 */
import { MAX_NIGHTS } from "./new-reservation";
import type { ErrorCode } from "./refunds";
import { nightsBetween, parseIsoDate } from "./reservations";

export const STAY_REASON_MAX = 200;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StayRoom = { room_status: string };
export type StayEditView =
  | { kind: "hidden" }
  | { kind: "blocked"; why: "paid" | "invoiced" }
  | { kind: "editable" };

/**
 * Whether to offer the form. "hidden" for people who may not edit and for bookings that cannot be edited at all (not
 * confirmed, or a guest already in the house), so those screens stay quiet; "blocked" says why money stops the edit.
 * A provider payment in flight cannot be seen from here, so the database may still refuse an editable booking.
 */
export function stayEditView(args: {
  reservationStatus: string; rooms: StayRoom[]; canModify: boolean; paymentCount: number; liveInvoiceCount: number;
}): StayEditView {
  if (!args.canModify || args.reservationStatus !== "confirmed") return { kind: "hidden" };
  if (args.rooms.length === 0 || args.rooms.some((r) => r.room_status !== "booked")) return { kind: "hidden" };
  if (args.paymentCount > 0) return { kind: "blocked", why: "paid" };
  if (args.liveInvoiceCount > 0) return { kind: "blocked", why: "invoiced" };
  return { kind: "editable" };
}

/** What to tell the person when money stops the edit. */
export function blockedText(why: "paid" | "invoiced"): string {
  return why === "paid"
    ? "Dates and guests cannot be changed because a payment has been recorded on this booking. To change them, cancel the booking and book it again."
    : "Dates and guests cannot be changed while an invoice is issued. Void the invoice below (an invoice with payments cannot be voided) and then change them.";
}

export type StayGuests = { reservationRoomId: string; adults: number; children: number };
export type StayEdit = { arrival: string; departure: string; guests: StayGuests[]; reason: string };
export type Parsed<T> = { ok: true; value: T } | { ok: false; code: ErrorCode };

type Raw = Record<string, FormDataEntryValue | undefined>;
const text = (v: FormDataEntryValue | undefined) => (typeof v === "string" ? v.trim() : "");
const count = (v: FormDataEntryValue | undefined, min: number): number | null => {
  const s = text(v);
  const n = /^\d{1,2}$/.test(s) ? Number(s) : NaN;
  return Number.isInteger(n) && n >= min && n <= 20 ? n : null;
};

/**
 * Reads the edit form: two dates, a reason, and a pair of fields per room named `adults_<room id>` and
 * `children_<room id>`. Only the shape is checked here (real dates, a stay of 1 to 30 nights, whole numbers, a reason);
 * capacity, the arrival date and everything about money and rooms is the database's call.
 */
export function parseStayForm(raw: Raw): Parsed<StayEdit> {
  const arrival = parseIsoDate(text(raw.arrival));
  const departure = parseIsoDate(text(raw.departure));
  if (!arrival || !departure || departure <= arrival) return { ok: false, code: "se_dates" };
  if (nightsBetween(arrival, departure) > MAX_NIGHTS) return { ok: false, code: "se_too_long" };
  const reason = text(raw.reason);
  if (reason.length < 1 || reason.length > STAY_REASON_MAX) return { ok: false, code: "se_reason" };

  const guests: StayGuests[] = [];
  for (const key of Object.keys(raw)) {
    if (!key.startsWith("adults_")) continue;
    const id = key.slice("adults_".length);
    if (!GUID.test(id)) return { ok: false, code: "se_room" };
    const adults = count(raw[key], 1);
    const children = count(raw[`children_${id}`] ?? "0", 0);
    if (adults === null || children === null) return { ok: false, code: "se_capacity" };
    guests.push({ reservationRoomId: id, adults, children });
  }
  return { ok: true, value: { arrival, departure, guests, reason } };
}

/** The `p_guests` payload for the database. */
export const guestsPayload = (g: StayGuests[]) => g.map((x) => ({ reservation_room_id: x.reservationRoomId, adults: x.adults, children: x.children }));

/** What the database answers: the new dates and total, and how many rooms had to move. */
export type StayResult = { changed: boolean; rooms_moved?: number };

/** Where to go after a successful edit: moved rooms need saying, because the guest may have been told a room number. */
export function resultCode(result: unknown): "se_changed" | "se_changed_moved" | "se_nochange" {
  const r = (result ?? {}) as StayResult;
  if (r.changed === false) return "se_nochange";
  return typeof r.rooms_moved === "number" && r.rooms_moved > 0 ? "se_changed_moved" : "se_changed";
}

/**
 * Turns a refusal from `update_reservation_stay` into a code. Total: the function has a small, known vocabulary, so the
 * shared classifier (which words the same database texts for other screens) is not used.
 */
export function classifyStayError(message: string): ErrorCode {
  if (/IDEMPOTENCY_MISMATCH/.test(message)) return "se_duplicate";
  if (/INVALID_STATE: money held/.test(message)) return "se_paid";
  if (/INVALID_STATE: invoice/.test(message)) return "se_invoiced";
  if (/INVALID_STATE: payment started/.test(message)) return "se_payment_started";
  if (/INVALID_STATE: split stay/.test(message)) return "se_split";
  if (/INVALID_STATE/.test(message)) return "se_not_editable";
  if (/CAPACITY_EXCEEDED/.test(message)) return "se_capacity";
  if (/ROOM_UNAVAILABLE/.test(message)) return "se_unavailable";
  if (/RATE_MISSING/.test(message)) return "se_rate";
  if (/POLICY_VIOLATION: reason/.test(message)) return "se_reason";
  if (/POLICY_VIOLATION: departure must follow/.test(message)) return "se_dates";
  if (/POLICY_VIOLATION: stay too long/.test(message)) return "se_too_long";
  if (/POLICY_VIOLATION: arrival in the past/.test(message)) return "se_arrival_past";
  if (/POLICY_VIOLATION: guests/.test(message)) return "se_capacity";
  if (/POLICY_VIOLATION: room/.test(message)) return "se_room";
  if (/POLICY_VIOLATION: discount/.test(message)) return "se_discount";
  if (/NOT_FOUND|FORBIDDEN/.test(message)) return "se_not_found";
  return "se_unknown";
}

/** Success codes the edit sends back (worded in `OK_MESSAGES`). */
export const STAY_OK_CODES = ["se_changed", "se_changed_moved", "se_nochange"] as const;
