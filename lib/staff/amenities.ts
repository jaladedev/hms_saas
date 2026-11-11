import { MAX_AMENITIES, MAX_AMENITY_LENGTH } from "./room-setup";

/**
 * The amenities a hotel can tick when it sets up a room type. Stored as plain text on the room type (migration 077), so
 * the list can grow without a migration and a hotel can still add its own. Each name is at most 40 characters and has no
 * comma or semicolon, so it survives the comma-separated form the server reads.
 */
export const AMENITY_GROUPS: { title: string; items: string[] }[] = [
  {
    title: "Comfort",
    items: [
      "Air conditioning",
      "Ceiling fan",
      "Free Wi-Fi",
      "Smart TV",
      "Satellite TV",
      "Work desk",
      "Wardrobe",
      "In-room safe",
      "Blackout curtains",
      "Iron and ironing board",
      "Telephone",
    ],
  },
  {
    title: "Bathroom",
    items: ["Private bathroom", "Hot water", "Shower", "Bathtub", "Toiletries", "Hairdryer", "Fresh towels"],
  },
  {
    title: "Food and drink",
    items: ["Breakfast included", "Room service", "Mini fridge", "Minibar", "Kettle", "Tea and coffee", "Kitchenette"],
  },
  {
    title: "Space and view",
    items: ["Balcony", "Sitting area", "Garden view", "City view", "Pool view"],
  },
  {
    title: "Services",
    items: [
      "24-hour electricity",
      "Daily housekeeping",
      "Laundry service",
      "Free parking",
      "Airport pick-up",
      "Wheelchair accessible",
      "Non-smoking",
    ],
  },
];

export const ALL_AMENITIES: string[] = AMENITY_GROUPS.flatMap((g) => g.items);

const byLower = new Map(ALL_AMENITIES.map((a) => [a.toLowerCase(), a]));

/** Splits a saved list into the listed amenities (in the list's own spelling, in list order) and the hotel's own extras. */
export function splitAmenities(saved: string[]): { picked: string[]; extras: string[] } {
  const pickedSet = new Set<string>();
  const extras: string[] = [];
  for (const raw of saved) {
    const hit = byLower.get(raw.trim().toLowerCase());
    if (hit) pickedSet.add(hit);
    else if (!extras.some((e) => e.toLowerCase() === raw.toLowerCase())) extras.push(raw);
  }
  return { picked: ALL_AMENITIES.filter((a) => pickedSet.has(a)), extras };
}

/**
 * Adds what someone typed ("Rooftop pool, Sea breeze") to the hotel's own extras. Blanks are dropped, repeats (of an extra
 * or of anything already ticked) are ignored, and an item that is too long, or one that would pass 20 in all, is refused
 * with a reason and nothing is added.
 */
export function addExtras(picked: string[], extras: string[], draft: string): { extras: string[]; error: string | null } {
  const seen = new Set([...picked, ...extras].map((a) => a.toLowerCase()));
  const next = [...extras];
  for (const part of draft.split(/[,\n\r;]+/)) {
    const item = part.trim().replace(/\s+/g, " ");
    if (!item) continue;
    if (item.length > MAX_AMENITY_LENGTH)
      return { extras, error: `"${item.slice(0, 20)}…" is too long. Keep each to ${MAX_AMENITY_LENGTH} characters.` };
    if (seen.has(item.toLowerCase())) continue;
    if (picked.length + next.length >= MAX_AMENITIES)
      return { extras, error: `Up to ${MAX_AMENITIES} amenities. Untick one to add another.` };
    seen.add(item.toLowerCase());
    next.push(item);
  }
  return { extras: next, error: null };
}

/** The value the server reads: ticked amenities in list order, then the extras. */
export function amenityValue(picked: string[], extras: string[]): string {
  return [...picked, ...extras].join(";");
}
