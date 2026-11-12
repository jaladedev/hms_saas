import type { HomeRoomType, RoomTypeQuote } from "@/lib/guest-site/server";
import { formatMoney } from "@/lib/guest-site/format";

/** How the search results are ordered and narrowed. Everything comes from the address, so the page can be shared or reloaded. */
export type ResultsView = { sort: "price_asc" | "price_desc" | "name"; minGuests: number; amenity: string | null };

export const SORT_LABELS: Record<ResultsView["sort"], string> = {
  price_asc: "Price: low to high",
  price_desc: "Price: high to low",
  name: "Name",
};

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Reads `sort`, `guests` (room sleeps at least this many) and `amenity` from the address; anything unusable falls back to no filter. */
export function parseResultsView(raw: Record<string, string | string[] | undefined>): ResultsView {
  const sortRaw = first(raw.sort);
  const sort = sortRaw === "price_desc" || sortRaw === "name" ? sortRaw : "price_asc";
  const n = Number(first(raw.guests));
  const minGuests = Number.isInteger(n) && n >= 1 && n <= 20 ? n : 0;
  const amenityRaw = first(raw.amenity)?.trim();
  const amenity = amenityRaw && amenityRaw.length <= 60 ? amenityRaw : null;
  return { sort, minGuests, amenity };
}

/** The quotes that match the view, in its order. The cheapest total comes first by default; ties keep the hotel's own order. */
export function viewQuotes<T extends Pick<RoomTypeQuote, "name" | "max_occupancy" | "total_minor" | "amenities">>(
  quotes: T[],
  view: ResultsView,
): T[] {
  const want = view.amenity?.toLowerCase();
  const kept = quotes.filter(
    (q) => q.max_occupancy >= view.minGuests && (!want || (q.amenities ?? []).some((a) => a.toLowerCase() === want)),
  );
  const index = new Map(kept.map((q, i) => [q, i]));
  return [...kept].sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    const d = view.sort === "name" ? byName : view.sort === "price_desc" ? b.total_minor - a.total_minor : a.total_minor - b.total_minor;
    return d !== 0 ? d : (index.get(a) ?? 0) - (index.get(b) ?? 0);
  });
}

/** Every amenity offered by these room types, once each, in alphabetical order, for the filter. */
export function amenityOptions(quotes: Pick<RoomTypeQuote, "amenities">[]): string[] {
  const seen = new Map<string, string>();
  for (const q of quotes) for (const a of q.amenities ?? []) if (!seen.has(a.toLowerCase())) seen.set(a.toLowerCase(), a);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** "2 nights × ₦45,000 + ₦3,375 tax": what the total is made of. Rates that differ from night to night are shown as a subtotal. */
export function nightlyBreakdown(q: Pick<RoomTypeQuote, "nights" | "subtotal_minor" | "tax_minor">, currency: string): string {
  const n = q.nights.length;
  const rates = new Set(q.nights.map((x) => x.rate_minor));
  const base =
    n > 0 && rates.size === 1
      ? `${n} ${n === 1 ? "night" : "nights"} × ${formatMoney(q.nights[0]!.rate_minor, currency)}`
      : `${n} ${n === 1 ? "night" : "nights"}: ${formatMoney(q.subtotal_minor, currency)}`;
  return q.tax_minor > 0 ? `${base} + ${formatMoney(q.tax_minor, currency)} tax` : base;
}

/** Room types the hotel sells that the guests could stay in but that have no room free on those dates. */
export function soldOutTypes(
  all: HomeRoomType[],
  available: Pick<RoomTypeQuote, "room_type_id">[],
  adults: number,
  children: number,
): HomeRoomType[] {
  const free = new Set(available.map((a) => a.room_type_id));
  return all.filter((t) => !free.has(t.room_type_id) && t.max_adults >= adults && t.max_occupancy >= adults + children);
}
