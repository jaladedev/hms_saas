import { formatTime } from "@/lib/guest-site/format";

/** What `guest_hotel` (migration 041) returns: only what a visitor may see before they search. */
export type GuestHotel = {
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  check_in_time: string;
  check_out_time: string;
  phone?: string | null; // absent from answers given before migration 087
  email?: string | null;
  intro?: string | null;
  logo?: string | null; // storage path in the room-photos bucket (migration 090)
};

/** "12 Example Road, Ibadan, Oyo": the parts the hotel has filled in, in order, without repeats or blanks. */
export function placeLine(h: Pick<GuestHotel, "address" | "city" | "state">): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of [h.address, h.city, h.state]) {
    const part = raw?.trim();
    if (!part) continue;
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(part);
  }
  return parts.join(", ");
}

/** "Check in from 14:00 · Check out by 12:00" */
export function timesLine(h: Pick<GuestHotel, "check_in_time" | "check_out_time">): string {
  return `Check in from ${formatTime(h.check_in_time)} · Check out by ${formatTime(h.check_out_time)}`;
}

/** The name shown in the page header; a hotel that cannot be loaded gets the plain wording the site used before. */
export function headerName(h: Pick<GuestHotel, "name"> | null): string {
  const name = h?.name?.trim();
  return name ? name : "Book your stay";
}

/** "1 photo", "4 photos": the count shown under a room type's picture row; nothing when there are none. */
export function photoCountLabel(n: number): string {
  if (!Number.isFinite(n) || n < 1) return "";
  return `${n} ${n === 1 ? "photo" : "photos"}`;
}
