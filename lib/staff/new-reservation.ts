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

export const MAX_ROOMS = 5;

/** requestedRoomId is a chosen physical room of that type, or null for "any free room" (the usual case). */
export type RoomRequest = { roomTypeId: string; requestedRoomId: string | null; adults: number; children: number };

export type NewReservation = {
  propertyId: string; rooms: RoomRequest[]; arrival: string; departure: string;
  source: ManualSource;
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
  if (!GUID.test(propertyId)) return { ok: false, code: "bad_request" };

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

  // Room 1 uses roomTypeId / roomId / adults / children; rooms 2 to MAX_ROOMS use the same names with _2 ... _5.
  // roomId is optional: empty means any free room of the type. Whether it belongs to the type is the database's call.
  // A later slot with no room type is simply unused. Room 1 is required.
  const rooms: RoomRequest[] = [];
  for (let i = 1; i <= MAX_ROOMS; i++) {
    const sfx = i === 1 ? "" : `_${i}`;
    const roomTypeId = clean(raw[`roomTypeId${sfx}`], 40);
    if (i > 1 && roomTypeId === "") continue;
    if (!GUID.test(roomTypeId)) return { ok: false, code: i === 1 ? "bad_request" : "room_type_missing" };
    const roomId = clean(raw[`roomId${sfx}`], 40);
    if (roomId !== "" && !GUID.test(roomId)) return { ok: false, code: "room_choice" };
    const adults = wholeNumber(raw[`adults${sfx}`] ?? (i > 1 ? "1" : undefined), 1, 20);
    const children = wholeNumber(raw[`children${sfx}`] ?? "0", 0, 20);
    if (adults === null || children === null) return { ok: false, code: "capacity" };
    rooms.push({ roomTypeId, requestedRoomId: roomId === "" ? null : roomId, adults, children });
  }

  const source = MANUAL_SOURCES.find((s) => s.value === raw.source)?.value;
  if (!source) return { ok: false, code: "bad_request" };

  return { ok: true, value: { propertyId, rooms, arrival, departure, source, guest: { name, email: email || null, phone: phone || null } } };
}

/** The `p_rooms` argument for create_reservation. The rate plan is left null so the property's default applies. */
export function roomsPayload(v: NewReservation) {
  return v.rooms.map((r) => ({ room_type_id: r.roomTypeId, requested_room_id: r.requestedRoomId, rate_plan_id: null, adults: r.adults, children: r.children }));
}
