export const MAX_PLACES = 8;
export const MAX_PLACE_NAME = 60;
export const MAX_PLACE_BODY = 140;

export type PlaceForm = { propertyId: string; placeId: string | null; name: string; body: string; active: boolean; sort: number };
export type PlaceCheck = { ok: true; value: PlaceForm } | { ok: false; code: "place_invalid" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Reads the place form. The database checks again (and decides who may save); this keeps obviously wrong input from making the trip. */
export function parsePlaceForm(raw: Record<string, unknown>): PlaceCheck {
  const propertyId = text(raw.propertyId);
  const placeId = text(raw.placeId);
  const name = text(raw.name);
  const body = text(raw.body);
  const sortRaw = text(raw.sort);
  if (!UUID.test(propertyId) || (placeId !== "" && !UUID.test(placeId))) return { ok: false, code: "place_invalid" };
  if (name.length < 1 || name.length > MAX_PLACE_NAME || body.length > MAX_PLACE_BODY) return { ok: false, code: "place_invalid" };
  const sort = sortRaw === "" ? 0 : Number(sortRaw);
  if (!Number.isInteger(sort) || sort < -1000 || sort > 1000) return { ok: false, code: "place_invalid" };
  return {
    ok: true,
    value: { propertyId, placeId: placeId === "" ? null : placeId, name, body, active: raw.active === "on" || raw.active === "true", sort },
  };
}
