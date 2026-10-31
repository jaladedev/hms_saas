/** Checks the new-reservation form before it reaches the database. Pure, so it can be tested. */
import { nightsBetween, parseIsoDate } from "./reservations";
import type { ErrorCode } from "./refunds";

export const MANUAL_SOURCES = [
  { value: "walk_in", label: "Walk-in" },
  { value: "phone", label: "Phone" },
  { value: "staff_entry", label: "Other staff entry" },
] as const;
export type ManualSource = (typeof MANUAL_SOURCES)[number]["value"];

export const MAX_NIGHTS = 30;

export type NewReservation = {
  propertyId: string; roomTypeId: string; arrival: string; departure: string;
  adults: number; children: number; source: ManualSource;
  guest: { name: string; email: string | null; phone: string | null };
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
const wholeNumber = (v: unknown, min: number, max: number): number | null => {
  const n = typeof v === "string" && /^\d{1,2}$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** The first thing wrong with the form as an error code, or the cleaned values. */
export function validateNewReservation(raw: Record<string, unknown>): { ok: true; value: NewReservation } | { ok: false; code: ErrorCode } {
  const propertyId = clean(raw.propertyId, 40);
  const roomTypeId = clean(raw.roomTypeId, 40);
  if (!GUID.test(propertyId) || !GUID.test(roomTypeId)) return { ok: false, code: "bad_request" };

  const name = clean(raw.guestName, 120);
  if (!name) return { ok: false, code: "guest_name_required" };
  const email = clean(raw.guestEmail, 200).toLowerCase();
  if (email && !EMAIL.test(email)) return { ok: false, code: "guest_failed" };
  const phone = clean(raw.guestPhone, 40);
  if (phone && !/^[\d+()\-\s.]{5,40}$/.test(phone)) return { ok: false, code: "guest_failed" };

  const arrival = parseIsoDate(clean(raw.arrival, 10));
  const departure = parseIsoDate(clean(raw.departure, 10));
  if (!arrival || !departure || departure <= arrival) return { ok: false, code: "dates_invalid" };
  if (nightsBetween(arrival, departure) > MAX_NIGHTS) return { ok: false, code: "too_long_stay" };

  const adults = wholeNumber(raw.adults, 1, 20);
  const children = wholeNumber(raw.children ?? "0", 0, 20);
  if (adults === null || children === null) return { ok: false, code: "capacity" };

  const source = MANUAL_SOURCES.find((s) => s.value === raw.source)?.value;
  if (!source) return { ok: false, code: "bad_request" };

  return { ok: true, value: { propertyId, roomTypeId, arrival, departure, adults, children, source, guest: { name, email: email || null, phone: phone || null } } };
}

/** The `p_rooms` argument for create_reservation. The rate plan is left null so the property's default applies. */
export function roomsPayload(v: NewReservation) {
  return [{ room_type_id: v.roomTypeId, requested_room_id: null, rate_plan_id: null, adults: v.adults, children: v.children }];
}
