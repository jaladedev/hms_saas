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
  font_display?: string | null; // heading font key over the theme (migration 100)
  font_body?: string | null;
  radius?: string | null; // corner style key over the theme (migration 118)
  theme_primary?: string | null; // optional main colour as #rrggbb over the theme (migration 099)
  theme?: string | null; // 'luxury', 'modern' or 'classic'; null is the standard look (migration 093)
  facilities?: string[] | null; // what the hotel as a whole offers: Pool, Restaurant (migration 105)
  instagram?: string | null; // https://instagram.com/<name>, or null
  facebook?: string | null; // https://facebook.com/<name>, or null
};

/** The name part of a hotel's social link, the same rules as the database checks (migration 105). */
export const INSTAGRAM_NAME = /^[A-Za-z0-9._]{1,30}$/;
export const FACEBOOK_NAME = /^[A-Za-z0-9._-]{5,50}$/;
const INSTAGRAM_URL = /^https:\/\/(www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?$/;
const FACEBOOK_URL = /^https:\/\/(www\.)?facebook\.com\/([A-Za-z0-9._-]{5,50})\/?$/;

export type SocialLink = { label: string; href: string };

/**
 * The links to draw under the hotel's contact details. Each stored value is checked again here, so a link is drawn only if it
 * is https, on instagram.com or facebook.com, with one plain name: nothing else, whatever the database held, can become an href.
 */
export function socialLinks(h: Pick<GuestHotel, "instagram" | "facebook">): SocialLink[] {
  const out: SocialLink[] = [];
  if (typeof h.instagram === "string" && INSTAGRAM_URL.test(h.instagram)) out.push({ label: "Instagram", href: h.instagram });
  if (typeof h.facebook === "string" && FACEBOOK_URL.test(h.facebook)) out.push({ label: "Facebook", href: h.facebook });
  return out;
}

/** The facilities to list: trimmed, blanks and repeats dropped, at most 20, and only strings. Never throws on odd data. */
export function facilityList(h: Pick<GuestHotel, "facilities">): string[] {
  if (!Array.isArray(h.facilities)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of h.facilities) {
    if (typeof raw !== "string") continue;
    const item = raw.trim();
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length === 20) break;
  }
  return out;
}

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
