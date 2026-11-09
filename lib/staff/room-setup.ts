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
  propertyId: string; name: string; code: string; slug: string; description: string | null; amenities: string[];
  maxAdults: number; maxChildren: number; maxOccupancy: number; baseRateMinor: number; isPublic: boolean;
};

type TypeFields = { name: string; slug: string; description: string | null; amenities: string[]; maxAdults: number; maxChildren: number; maxOccupancy: number; baseRateMinor: number; isPublic: boolean };

export const MAX_AMENITIES = 20;
export const MAX_AMENITY_LENGTH = 40;

/**
 * "Air conditioning, Wi-Fi" (commas or one per line) becomes a list. Spaces are tidied, blanks dropped and repeats ignoring
 * case collapsed to the first spelling. Too many items, or one that is too long, is refused, never cut short; the database
 * checks the same limits (amenities_valid, migration 077). Null means refused.
 */
export function parseAmenities(raw: unknown): string[] | null {
  const text = typeof raw === "string" ? raw : "";
  if (text.length > 2000) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[,\n\r;]+/)) {
    const item = part.trim().replace(/\s+/g, " ");
    if (!item) continue;
    if (item.length > MAX_AMENITY_LENGTH) return null;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.length > MAX_AMENITIES ? null : out;
}

/** The fields a room type has whether it is being added or edited. Over-long input is refused, never silently cut short. */
function parseTypeFields(raw: Record<string, unknown>): { ok: true; value: TypeFields } | { ok: false; code: ErrorCode } {
  const name = clean(raw.name, 200);
  const slug = slugify(name);
  if (!name || name.length > 80 || !slug) return { ok: false, code: "setup_invalid" };

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
  const amenities = parseAmenities(raw.amenities);
  if (amenities === null) return { ok: false, code: "setup_invalid" };
  return { ok: true, value: { name, slug, description: description || null, amenities, maxAdults, maxChildren, maxOccupancy, baseRateMinor, isPublic: raw.isPublic === "on" } };
}

export function validateRoomType(raw: Record<string, unknown>): { ok: true; value: RoomTypeInput } | { ok: false; code: ErrorCode } {
  const propertyId = clean(raw.propertyId, 40);
  if (!GUID.test(propertyId)) return { ok: false, code: "bad_request" };
  const code = clean(raw.code, 50).toUpperCase();
  const fields = parseTypeFields(raw);
  if (!fields.ok) return fields;
  if (!/^[A-Z0-9][A-Z0-9-]{1,11}$/.test(code)) return { ok: false, code: "setup_invalid" };
  return { ok: true, value: { propertyId, code, ...fields.value } };
}

/**
 * What an edit may change: name, description, capacity, standard price and whether guests can book it online.
 * The code and the web address (slug) stay as they were, so existing links, reports and references do not break.
 */
export type RoomTypeEdit = Omit<TypeFields, "slug"> & { roomTypeId: string };

export function validateRoomTypeEdit(raw: Record<string, unknown>): { ok: true; value: RoomTypeEdit } | { ok: false; code: ErrorCode } {
  const roomTypeId = clean(raw.roomTypeId, 40);
  if (!GUID.test(roomTypeId)) return { ok: false, code: "bad_request" };
  const fields = parseTypeFields(raw);
  if (!fields.ok) return fields;
  const { slug: _slug, ...rest } = fields.value;
  return { ok: true, value: { roomTypeId, ...rest } };
}

export const ROOM_TYPE_STATUSES = ["active", "inactive"] as const;
export type RoomTypeStatus = (typeof ROOM_TYPE_STATUSES)[number];
export const isRoomTypeStatus = (v: unknown): v is RoomTypeStatus => ROOM_TYPE_STATUSES.some((s) => s === v);

/**
 * True when renaming a type to `name` would make it look like another type at the hotel: the same name, or a name
 * that makes the same web address. Compared in code so names with odd characters need no escaping in a query.
 */
export function nameClashes(name: string, others: { name: string; slug: string }[]): boolean {
  const lower = name.trim().toLowerCase();
  const slug = slugify(name);
  return others.some((o) => o.name.trim().toLowerCase() === lower || o.slug === slug);
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
