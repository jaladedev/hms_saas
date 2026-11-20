import { parseAmountToMinor } from "./money-input";
import { parseLocalDateTime } from "./events";

/**
 * Spa, gym and laundry services (migration 151): reading what the database returns, checking what a form sends, and the words the screens
 * use. Pure, so it is tested without a server. The database checks everything again on every call.
 */

export const SERVICE_KINDS = ["spa", "gym", "laundry", "other"] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];
export const SERVICE_KIND_LABEL: Record<ServiceKind, string> = { spa: "Spa", gym: "Gym", laundry: "Laundry", other: "Other" };

export const BOOKING_STATUSES = ["booked", "done", "cancelled", "no_show", "charged"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  booked: "Booked",
  done: "Done",
  cancelled: "Cancelled",
  no_show: "No-show",
  charged: "On the room bill",
};
export const BOOKING_ACTIONS = ["done", "cancel", "no_show", "charge"] as const;
export type BookingAction = (typeof BOOKING_ACTIONS)[number];

// ---- wording ---------------------------------------------------------------------------------

export type SvcErrorCode =
  | "svc_forbidden"
  | "svc_off"
  | "svc_invalid"
  | "svc_name_taken"
  | "svc_limit"
  | "svc_service"
  | "svc_guest"
  | "svc_reservation"
  | "svc_time"
  | "svc_full"
  | "svc_step"
  | "svc_no_room"
  | "svc_need_folio"
  | "svc_not_in_house"
  | "svc_reused"
  | "svc_failed";

export const SVC_ERROR_MESSAGES: Record<SvcErrorCode, string> = {
  svc_forbidden: "You do not have permission to do that here. The service list is kept by the owner or general manager.",
  svc_off: "Spa, gym and laundry services are switched off for your hotel group. Your list and bookings are kept. Contact the platform.",
  svc_invalid: "Check the details and try again.",
  svc_name_taken: "That name is already in use here. Choose another.",
  svc_limit: "This hotel has reached the most services it can hold (30). Switch one off or reuse it.",
  svc_service: "That service is switched off or not found.",
  svc_guest: "Give a booking reference from this hotel, or a name for a walk-in guest.",
  svc_reservation: "That booking is cancelled, expired or already checked out, so nothing can be booked for it.",
  svc_time: "Choose a time that is not in the past and within the next 180 days. A timed service needs one.",
  svc_full: "That time is full. Choose another time or a smaller quantity.",
  svc_step: "That booking has already moved on, so that step is not possible.",
  svc_no_room: "A walk-in has no room bill. Mark it done and take payment outside the system.",
  svc_need_folio: "Putting a service on a room bill also needs the permission to post charges to a guest's bill. Ask the front desk.",
  svc_not_in_house: "That guest is not checked in (or has not stayed yet), so the room bill cannot take a charge.",
  svc_reused: "That form was already sent with other details. Reload the page and try again.",
  svc_failed: "That did not work. Reload the page and try again.",
};

export const SVC_OK_MESSAGES = {
  svc_saved: "Saved.",
  svc_booked: "Booked.",
  svc_done: "Marked done.",
  svc_cancelled: "Booking cancelled.",
  svc_no_show: "Marked as a no-show.",
  svc_charged: "Posted to the guest's room bill.",
} as const;
export type SvcOkCode = keyof typeof SVC_OK_MESSAGES;

/** Turns a database refusal into a code; raw database text never reaches the browser. */
export function classifySvcError(message: string): SvcErrorCode {
  if (/IDEMPOTENCY_MISMATCH/.test(message)) return "svc_reused";
  if (/FORBIDDEN: folio\.charge/.test(message)) return "svc_need_folio";
  if (/NOT_FOUND/.test(message)) return "svc_forbidden";
  if (/services off/.test(message)) return "svc_off";
  if (/POLICY_VIOLATION: name taken/.test(message)) return "svc_name_taken";
  if (/POLICY_VIOLATION: limit/.test(message)) return "svc_limit";
  if (/POLICY_VIOLATION: service/.test(message)) return "svc_service";
  if (/POLICY_VIOLATION: guest/.test(message)) return "svc_guest";
  if (/POLICY_VIOLATION: time/.test(message)) return "svc_time";
  if (/POLICY_VIOLATION: slot full/.test(message)) return "svc_full";
  if (/INVALID_STATE: no room bill/.test(message)) return "svc_no_room";
  if (/INVALID_STATE: (pending|confirmed|cancelled|expired|no_show)/.test(message)) return "svc_not_in_house";
  if (/INVALID_STATE: reservation/.test(message)) return "svc_reservation";
  if (/INVALID_STATE/.test(message)) return "svc_step";
  if (/POLICY_VIOLATION/.test(message)) return "svc_invalid";
  return "svc_failed";
}

// ---- reading what the database returns ----------------------------------------------------------

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : 0;
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec).filter((x): x is Rec => x !== null) : []);
const kindOf = (v: unknown): ServiceKind => ((SERVICE_KINDS as readonly string[]).includes(str(v)) ? (str(v) as ServiceKind) : "other");
const statusOf = (v: unknown): BookingStatus =>
  (BOOKING_STATUSES as readonly string[]).includes(str(v)) ? (str(v) as BookingStatus) : "booked";

export type Service = {
  id: string;
  name: string;
  kind: ServiceKind;
  priceMinor: number;
  durationMinutes: number | null;
  capacity: number;
  isActive: boolean;
};
export function parseServices(raw: unknown): Service[] {
  return arr(raw).map((r) => ({
    id: str(r.id),
    name: str(r.name),
    kind: kindOf(r.kind),
    priceMinor: num(r.price_minor),
    durationMinutes: numOrNull(r.duration_minutes),
    capacity: num(r.capacity) || 1,
    isActive: r.is_active !== false,
  }));
}

export type ServiceBooking = {
  id: string;
  serviceId: string;
  reservationId: string | null;
  guestLabel: string | null;
  startsAt: string | null;
  quantity: number;
  note: string | null;
  name: string;
  kind: ServiceKind;
  unitPriceMinor: number;
  status: BookingStatus;
  totalMinor: number;
};
export function parseBookings(raw: unknown): ServiceBooking[] {
  return arr(raw).map((r) => {
    const quantity = num(r.quantity) || 1;
    const unit = num(r.unit_price_minor);
    return {
      id: str(r.id),
      serviceId: str(r.service_id),
      reservationId: strOrNull(r.reservation_id),
      guestLabel: strOrNull(r.guest_label),
      startsAt: strOrNull(r.starts_at),
      quantity,
      note: strOrNull(r.note),
      name: str(r.name_at_booking),
      kind: kindOf(r.kind_at_booking),
      unitPriceMinor: unit,
      status: statusOf(r.status),
      totalMinor: quantity * unit,
    };
  });
}

/** Which steps a booking in this status can take, and the button for each. A charge also needs a reservation. */
export function nextActions(status: BookingStatus, hasReservation: boolean): { action: BookingAction; button: string }[] {
  if (status === "booked")
    return [
      { action: "done", button: "Done" },
      ...(hasReservation ? [{ action: "charge" as const, button: "Put on room bill" }] : []),
      { action: "no_show", button: "No-show" },
      { action: "cancel", button: "Cancel" },
    ];
  if (status === "done" && hasReservation) return [{ action: "charge", button: "Put on room bill" }];
  return [];
}

export type ServiceReportRow = {
  serviceId: string;
  name: string;
  kind: ServiceKind;
  booked: number;
  done: number;
  charged: number;
  cancelled: number;
  noShow: number;
  revenueMinor: number | null;
};
export type ServiceReport = { from: string; to: string; services: ServiceReportRow[]; revenueMinor: number | null };
export function parseServiceReport(raw: unknown): ServiceReport {
  const r = rec(raw) ?? {};
  return {
    from: str(r.from),
    to: str(r.to),
    revenueMinor: numOrNull(r.revenue_minor),
    services: arr(r.services).map((x) => ({
      serviceId: str(x.service_id),
      name: str(x.name),
      kind: kindOf(x.kind),
      booked: num(x.booked),
      done: num(x.done),
      charged: num(x.charged),
      cancelled: num(x.cancelled),
      noShow: num(x.no_show),
      revenueMinor: numOrNull(x.revenue_minor),
    })),
  };
}

// ---- checking what a form sends -----------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{8,100}$/;
type Raw = Record<string, FormDataEntryValue | undefined>;
type Parsed<T> = { ok: true; value: T } | { ok: false; code: SvcErrorCode };
const text = (v: FormDataEntryValue | undefined): string => (typeof v === "string" ? v.trim() : "");
const bad = (): { ok: false; code: SvcErrorCode } => ({ ok: false, code: "svc_invalid" });
const checked = (v: FormDataEntryValue | undefined): boolean => v === "on" || v === "true";
function intIn(v: FormDataEntryValue | undefined, min: number, max: number, fallback?: number): number | null {
  const s = text(v);
  if (s === "") return fallback ?? null;
  if (!/^\d{1,6}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

export function parseServiceForm(raw: Raw): Parsed<{
  propertyId: string;
  serviceId: string | null;
  name: string;
  kind: ServiceKind;
  priceMinor: number;
  durationMinutes: number | null;
  capacity: number;
  sort: number;
  active: boolean;
}> {
  const propertyId = text(raw.propertyId);
  const serviceId = text(raw.serviceId) || null;
  const name = text(raw.name);
  const kind = text(raw.kind);
  const priceMinor = parseAmountToMinor(text(raw.price));
  const durationMinutes = intIn(raw.duration, 5, 480, 0);
  const capacity = intIn(raw.capacity, 1, 50, 1);
  const sort = intIn(raw.sort, 0, 1000, 0);
  if (
    !UUID.test(propertyId) ||
    (serviceId && !UUID.test(serviceId)) ||
    name.length < 1 ||
    name.length > 60 ||
    !(SERVICE_KINDS as readonly string[]).includes(kind) ||
    priceMinor === null ||
    priceMinor > 1_000_000_000 ||
    durationMinutes === null ||
    capacity === null ||
    sort === null
  )
    return bad();
  return {
    ok: true,
    value: {
      propertyId,
      serviceId,
      name,
      kind: kind as ServiceKind,
      priceMinor,
      durationMinutes: durationMinutes === 0 ? null : durationMinutes, // blank or 0 means no fixed duration (no slots)
      capacity,
      sort,
      active: checked(raw.active),
    },
  };
}

export function parseBookForm(raw: Raw): Parsed<{
  propertyId: string;
  serviceId: string;
  reference: string | null;
  guestLabel: string | null;
  startsAt: string | null;
  quantity: number;
  note: string | null;
  key: string;
}> {
  const propertyId = text(raw.propertyId);
  const serviceId = text(raw.serviceId);
  const reference = text(raw.reference).toUpperCase();
  const guestLabel = text(raw.guestLabel);
  const startsRaw = text(raw.startsAt);
  const startsAt = startsRaw === "" ? null : parseLocalDateTime(startsRaw);
  const quantity = intIn(raw.quantity, 1, 20, 1);
  const note = text(raw.note);
  const key = text(raw.key);
  if (
    !UUID.test(propertyId) ||
    !UUID.test(serviceId) ||
    reference.length > 40 ||
    guestLabel.length > 60 ||
    (reference === "" && guestLabel === "") ||
    (startsRaw !== "" && startsAt === null) ||
    quantity === null ||
    note.length > 200 ||
    !KEY.test(key)
  )
    return bad();
  return {
    ok: true,
    value: {
      propertyId,
      serviceId,
      reference: reference || null,
      guestLabel: guestLabel || null,
      startsAt,
      quantity,
      note: note || null,
      key,
    },
  };
}

export function parseStepForm(raw: Raw): Parsed<{ bookingId: string; action: BookingAction }> {
  const bookingId = text(raw.bookingId);
  const action = text(raw.action);
  if (!UUID.test(bookingId) || !(BOOKING_ACTIONS as readonly string[]).includes(action)) return bad();
  return { ok: true, value: { bookingId, action: action as BookingAction } };
}

export const STEP_OK: Record<BookingAction, SvcOkCode> = {
  done: "svc_done",
  cancel: "svc_cancelled",
  no_show: "svc_no_show",
  charge: "svc_charged",
};
