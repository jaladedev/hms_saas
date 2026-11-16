export const MAX_PLACES = 8;
export const MAX_PLACE_NAME = 60;
export const MAX_PLACE_BODY = 140;

export const PLACE_CATEGORIES = ["dining", "sights", "nightlife", "wellness", "shopping", "other"] as const;
export type PlaceCategory = (typeof PLACE_CATEGORIES)[number];
/** The heading a category gets on the guest homepage and in the staff form. */
export const PLACE_CATEGORY_LABEL: Record<PlaceCategory, string> = {
  dining: "Dining",
  sights: "Things to see",
  nightlife: "Nightlife",
  wellness: "Wellness",
  shopping: "Shopping",
  other: "Also nearby",
};
export const MAX_PLACE_LINK = 200;

export type PlaceForm = {
  propertyId: string;
  placeId: string | null;
  name: string;
  body: string;
  active: boolean;
  sort: number;
  category: PlaceCategory;
  link: string;
};
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
  const categoryRaw = text(raw.category) || "other";
  const link = text(raw.link);
  if (!(PLACE_CATEGORIES as readonly string[]).includes(categoryRaw)) return { ok: false, code: "place_invalid" };
  if (link !== "" && !isHttpsLink(link)) return { ok: false, code: "place_invalid" };
  if (!UUID.test(propertyId) || (placeId !== "" && !UUID.test(placeId))) return { ok: false, code: "place_invalid" };
  if (name.length < 1 || name.length > MAX_PLACE_NAME || body.length > MAX_PLACE_BODY) return { ok: false, code: "place_invalid" };
  const sort = sortRaw === "" ? 0 : Number(sortRaw);
  if (!Number.isInteger(sort) || sort < -1000 || sort > 1000) return { ok: false, code: "place_invalid" };
  return {
    ok: true,
    value: {
      propertyId,
      placeId: placeId === "" ? null : placeId,
      name,
      body,
      active: raw.active === "on" || raw.active === "true",
      sort,
      category: categoryRaw as PlaceCategory,
      link,
    },
  };
}

/** An https address of at most 200 characters with no spaces, quotes or angle brackets: the rule the database applies too. */
export function isHttpsLink(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_PLACE_LINK && /^https:\/\/[^ "<>]+$/.test(value);
}

export type GuestPlace = { name: string; body: string; category?: string | null; link?: string | null };
export type PlaceGroup = { category: PlaceCategory; label: string; places: GuestPlace[] };

/** The homepage list as one group per category, in the order the categories are listed above, each keeping the hotel's own order. A
 * category nobody uses is left out, and an unknown one is treated as "Also nearby". */
export function groupPlaces(places: GuestPlace[]): PlaceGroup[] {
  const groups = new Map<PlaceCategory, GuestPlace[]>();
  for (const pl of places) {
    const c = (PLACE_CATEGORIES as readonly string[]).includes(pl.category ?? "") ? (pl.category as PlaceCategory) : "other";
    groups.set(c, [...(groups.get(c) ?? []), pl]);
  }
  return PLACE_CATEGORIES.filter((c) => groups.has(c)).map((c) => ({
    category: c,
    label: PLACE_CATEGORY_LABEL[c],
    places: groups.get(c) ?? [],
  }));
}

/** The link to draw for a place, or null: only a valid https address is ever used, whatever the database holds. */
export function safePlaceLink(value: unknown): string | null {
  return isHttpsLink(value) ? value : null;
}
