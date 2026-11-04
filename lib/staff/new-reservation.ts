/** Checks the new-reservation form before it reaches the database. Pure, so it can be tested. */
import { nightsBetween, parseIsoDate } from "./reservations";
import { addDays } from "./transfer";
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
  /** Hold the rooms for the hotel's hold time and confirm when payment is recorded (migration 034), instead of confirming at once. */
  holdUntilPaid: boolean;
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

  return { ok: true, value: { propertyId, rooms, arrival, departure, source, holdUntilPaid: raw.holdUntilPaid === "on", guest: { name, email: email || null, phone: phone || null } } };
}

/** The `p_rooms` argument for create_reservation. The rate plan is left null so the property's default applies. */
export function roomsPayload(v: NewReservation) {
  return v.rooms.map((r) => ({ room_type_id: r.roomTypeId, requested_room_id: r.requestedRoomId, rate_plan_id: null, adults: r.adults, children: r.children }));
}

/** The link an empty night on the room calendar goes to: that room, arriving that night, leaving the next day. The form lets staff change the departure. */
export function bookFromCalendarHref(roomId: string, date: string): string {
  return `/app/reservations/new?${new URLSearchParams({ room: roomId, arrival: date, departure: addDays(date, 1) })}`;
}

export type Prefill = { propertyId: string | null; roomTypeId: string | null; roomId: string | null; arrival: string; departure: string | null };

const one = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Starting values for the new-reservation form from ?room=&property=&arrival=&departure=, used by the room calendar.
 * Only a hint: a room counts only if it is an active room of a property the viewer may book at, a past arrival becomes today,
 * and a departure that is not after the arrival, or is more than MAX_NIGHTS away, is dropped. The database still decides on submit.
 */
export function parsePrefill(
  search: Record<string, string | string[] | undefined>,
  today: string,
  rooms: { id: string; room_type_id: string; property_id: string }[],
  allowedPropertyIds: string[],
): Prefill {
  const room = rooms.find((r) => r.id === one(search.room) && allowedPropertyIds.includes(r.property_id));
  const wanted = one(search.property);
  const propertyId = room?.property_id ?? (wanted && allowedPropertyIds.includes(wanted) ? wanted : null);
  const asked = parseIsoDate(one(search.arrival));
  const arrival = asked && asked >= today ? asked : today;
  const dep = parseIsoDate(one(search.departure));
  const departure = asked && dep && dep > arrival && nightsBetween(arrival, dep) <= MAX_NIGHTS ? dep : asked ? addDays(arrival, 1) : null;
  return { propertyId, roomTypeId: room?.room_type_id ?? null, roomId: room?.id ?? null, arrival, departure };
}
