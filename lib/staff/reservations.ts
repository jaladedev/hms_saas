/** Shared types and rules for the staff reservation screens. Pure functions only, so they can be tested. */

export type ReservationStatus = "pending" | "confirmed" | "checked_in" | "checked_out" | "cancelled" | "no_show" | "expired";
export type RoomStatus = "booked" | "checked_in" | "checked_out" | "cancelled";

export const PAGE_SIZE = 25;

export const STATUS_LABEL: Record<string, string> = {
  pending: "Awaiting payment", confirmed: "Confirmed", checked_in: "In house", checked_out: "Checked out",
  cancelled: "Cancelled", no_show: "No-show", expired: "Expired",
};
export const PAYMENT_LABEL: Record<string, string> = {
  unpaid: "Unpaid", partially_paid: "Part paid", paid: "Paid", partially_refunded: "Part refunded", refunded: "Refunded", payment_failed: "Payment failed",
};
export const SOURCE_LABEL: Record<string, string> = {
  website: "Website", walk_in: "Walk-in", phone: "Phone", staff_entry: "Staff entry", partner: "Partner",
};

/** The filter choices shown on the list, in display order. "attention" is not a status; it filters on attention_reason. */
export const STATUS_FILTERS = [
  { value: "open", label: "Open (awaiting, confirmed, in house)" },
  { value: "all", label: "All" },
  { value: "attention", label: "Needs attention" },
  { value: "pending", label: STATUS_LABEL.pending },
  { value: "confirmed", label: STATUS_LABEL.confirmed },
  { value: "checked_in", label: STATUS_LABEL.checked_in },
  { value: "checked_out", label: STATUS_LABEL.checked_out },
  { value: "cancelled", label: STATUS_LABEL.cancelled },
  { value: "no_show", label: STATUS_LABEL.no_show },
  { value: "expired", label: STATUS_LABEL.expired },
] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number]["value"];

export type ListFilters = { q: string; status: StatusFilter; from: string | null; to: string | null; page: number };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * What a person types into the search box, reduced to letters, digits, spaces, dots, @ and hyphens.
 * The result goes into a PostgREST filter string, where commas, parentheses and wildcards mean
 * something, so they are dropped rather than escaped.
 */
export function sanitizeSearch(raw: string | undefined): string {
  if (!raw) return "";
  return raw.replace(/[^\p{L}\p{N} .@-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date in YYYY-MM-DD form, or null. */
export function parseIsoDate(v: string | undefined): string | null {
  if (!v || !ISO_DATE.test(v)) return null;
  const [y = 0, m = 0, d = 0] = v.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? v : null;
}

/** Reads ?q=&status=&from=&to=&page= from the URL. Anything unrecognised falls back to the default. */
export function parseFilters(search: Search): ListFilters {
  const status = one(search.status);
  const known = STATUS_FILTERS.some((f) => f.value === status);
  const pageNum = Number(one(search.page));
  return {
    q: sanitizeSearch(one(search.q)),
    status: known ? (status as StatusFilter) : "open",
    from: parseIsoDate(one(search.from)),
    to: parseIsoDate(one(search.to)),
    page: Number.isInteger(pageNum) && pageNum >= 1 && pageNum <= 10000 ? pageNum : 1,
  };
}

/** The reservation statuses a status filter stands for (null means no status restriction). */
export function statusesFor(filter: StatusFilter): ReservationStatus[] | null {
  switch (filter) {
    case "open": return ["pending", "confirmed", "checked_in"];
    case "all": case "attention": return null;
    default: return [filter];
  }
}

/** Upcoming work reads best soonest first; history reads best newest first. */
export function sortAscending(filter: StatusFilter): boolean {
  return filter === "open" || filter === "pending" || filter === "confirmed" || filter === "checked_in" || filter === "attention";
}

/** Query string for a list link, leaving out anything at its default so URLs stay short. */
export function listQuery(f: ListFilters, over: Partial<ListFilters> = {}): string {
  const m = { ...f, ...over };
  const qs = new URLSearchParams();
  if (m.q) qs.set("q", m.q);
  if (m.status !== "open") qs.set("status", m.status);
  if (m.from) qs.set("from", m.from);
  if (m.to) qs.set("to", m.to);
  if (m.page > 1) qs.set("page", String(m.page));
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/** Today's date (YYYY-MM-DD) in a property's own timezone; falls back to UTC for an unknown zone. */
export function todayIn(timeZone: string, now: Date): string {
  const fmt = (tz: string) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz }).format(now);
  try { return fmt(timeZone); } catch { return fmt("UTC"); }
}

/** Nights between two YYYY-MM-DD dates (departure exclusive). */
export function nightsBetween(arrival: string, departure: string): number {
  const a = Date.parse(`${arrival}T00:00:00Z`);
  const d = Date.parse(`${departure}T00:00:00Z`);
  return Number.isNaN(a) || Number.isNaN(d) ? 0 : Math.round((d - a) / 86400000);
}

export type ResState = { reservation_status: string; arrival_date: string; departure_date: string; total_minor: number; cancellation_charge_minor: number };
export type RoomState = { room_status: string };
export type Viewer = { cancel: boolean; checkin: boolean; checkout: boolean; payment: boolean };

export type DetailActions = {
  cancel: boolean;
  recordPayment: boolean;
  /** What a payment may not exceed: the total, or for a cancelled booking the cancellation charge. Null when payments are closed. */
  payableCeilingMinor: number | null;
  checkIn: (room: RoomState) => boolean;
  checkOut: (room: RoomState) => boolean;
};

/**
 * Which controls to show on the detail page. This only hides buttons that would be refused: the
 * database enforces permission, state and dates again on every call.
 */
export function detailActions(r: ResState, viewer: Viewer, today: string, heldMinor: number | null): DetailActions {
  const st = r.reservation_status;
  const cancellable = st === "pending" || st === "confirmed";
  const ceiling = st === "cancelled"
    ? (heldMinor !== null && r.cancellation_charge_minor > heldMinor ? r.cancellation_charge_minor : null)
    : st === "expired" || st === "no_show" ? null : r.total_minor;
  const inWindow = today >= r.arrival_date && today < r.departure_date;
  return {
    cancel: viewer.cancel && cancellable,
    recordPayment: viewer.payment && ceiling !== null && (heldMinor === null || heldMinor < ceiling),
    payableCeilingMinor: ceiling,
    checkIn: (room) => viewer.checkin && (st === "confirmed" || st === "checked_in") && room.room_status === "booked" && inWindow,
    checkOut: (room) => viewer.checkout && room.room_status === "checked_in",
  };
}

export const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "pos", label: "POS" },
  { value: "other", label: "Other" },
] as const;
export const isPaymentMethod = (v: string): v is (typeof PAYMENT_METHODS)[number]["value"] => PAYMENT_METHODS.some((m) => m.value === v);

/** Why a reservation needs a person, in plain words. Unknown codes are shown as given rather than hidden. */
export function attentionText(code: string): string {
  switch (code) {
    case "cancellation_charge_unpaid": return "The cancellation charge has not been fully collected yet. Record a payment for the difference, or decide how to handle it.";
    case "paid_after_cancel": return "The guest paid after this reservation was cancelled. That money should go back to them: request a refund from the settlement page.";
    case "paid_inventory_lost": return "The guest paid, but the rooms were no longer available. The money needs refunding or the booking re-made by hand.";
    default: return code.startsWith("payment_") ? "A payment on this reservation needs review." : `Flagged for attention (${code}).`;
  }
}
