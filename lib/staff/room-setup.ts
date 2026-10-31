/** Checks the hotel-setup forms (room types and rooms) before they reach the database. Pure, so it can be tested. */
import { parseAmountToMinor } from "./money-input";
import type { ErrorCode } from "./refunds";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
const whole = (v: unknown, min: number, max: number): number | null => {
  const t = typeof v === "string" ? v.trim() : "";
  if (!/^-?\d{1,4}$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
};

/** "Deluxe Double, Garden View" becomes "deluxe-double-garden-view". Empty when nothing usable is left. */
export function slugify(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

export type RoomTypeInput = {
  propertyId: string; name: string; code: string; slug: string; description: string | null;
  maxAdults: number; maxChildren: number; maxOccupancy: number; baseRateMinor: number; isPublic: boolean;
};

export function validateRoomType(raw: Record<string, unknown>): { ok: true; value: RoomTypeInput } | { ok: false; code: ErrorCode } {
  const propertyId = clean(raw.propertyId, 40);
  if (!GUID.test(propertyId)) return { ok: false, code: "bad_request" };
  // Over-long input is refused, never silently cut short: clean() gets a generous cap and the checks below set the real limits.
  const name = clean(raw.name, 200);
  const code = clean(raw.code, 50).toUpperCase();
  const slug = slugify(name);
  if (!name || name.length > 80 || !slug || !/^[A-Z0-9][A-Z0-9-]{1,11}$/.test(code)) return { ok: false, code: "setup_invalid" };

  const maxAdults = whole(raw.maxAdults, 1, 20);
  const maxChildren = whole(raw.maxChildren ?? "0", 0, 20);
  if (maxAdults === null || maxChildren === null) return { ok: false, code: "setup_invalid" };
  const occupancyText = clean(raw.maxOccupancy, 20);
  const maxOccupancy = occupancyText === "" ? maxAdults + maxChildren : whole(occupancyText, 1, 40);
  // The database insists on this too: occupancy cannot exceed adults plus children.
  if (maxOccupancy === null || maxOccupancy > maxAdults + maxChildren) return { ok: false, code: "setup_invalid" };

  const baseRateMinor = parseAmountToMinor(clean(raw.baseRate, 50));
  if (baseRateMinor === null) return { ok: false, code: "amount_invalid" };

  const description = clean(raw.description, 2000);
  if (description.length > 500) return { ok: false, code: "setup_invalid" };
  return { ok: true, value: { propertyId, name, code, slug, description: description || null, maxAdults, maxChildren, maxOccupancy, baseRateMinor, isPublic: raw.isPublic === "on" } };
}

export type RoomInput = { roomTypeId: string; roomNumber: string; floor: number | null };

export function validateRoom(raw: Record<string, unknown>): { ok: true; value: RoomInput } | { ok: false; code: ErrorCode } {
  const roomTypeId = clean(raw.roomTypeId, 40);
  if (!GUID.test(roomTypeId)) return { ok: false, code: "bad_request" };
  const roomNumber = clean(raw.roomNumber, 50);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,9}$/.test(roomNumber)) return { ok: false, code: "setup_invalid" };
  const floorText = clean(raw.floor, 20);
  const floor = floorText === "" ? null : whole(floorText, -5, 200);
  if (floorText !== "" && floor === null) return { ok: false, code: "setup_invalid" };
  return { ok: true, value: { roomTypeId, roomNumber, floor } };
}

export const ROOM_STATUSES = [
  { value: "active", label: "In service" },
  { value: "out_of_service", label: "Out of service" },
  { value: "retired", label: "Retired" },
] as const;
export type RoomOperationalStatus = (typeof ROOM_STATUSES)[number]["value"];
export const isRoomStatus = (v: unknown): v is RoomOperationalStatus => ROOM_STATUSES.some((s) => s.value === v);

/** Turns a PostgREST error from an insert or update into one of our codes. Raw database text never reaches the page. */
export function classifySetupError(err: { code?: string; message?: string }): ErrorCode {
  const msg = err.message ?? "";
  if (err.code === "23505") {
    if (/_code_key|\(property_id, code\)/.test(msg)) return "setup_duplicate_code";
    if (/_slug_key|\(property_id, slug\)/.test(msg)) return "setup_duplicate_name";
    if (/room_number/.test(msg)) return "setup_duplicate_room";
    return "setup_invalid";
  }
  if (err.code === "42501" || /row-level security/i.test(msg)) return "setup_forbidden";
  if (err.code === "23514" || err.code === "22003" || err.code === "22P02") return "setup_invalid";
  return "unknown";
}
