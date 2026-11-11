/**
 * The hotel's facilities (Pool, Restaurant, Gym) and its Instagram and Facebook links, shown on the guest site (migration 105).
 * Pure functions, so they can be tested. The database checks the same rules again; these exist so a mistake is explained on the
 * form, and so what a person types ("@bodijaboutique") becomes the one stored shape (https://instagram.com/bodijaboutique).
 */
import { FACEBOOK_NAME, INSTAGRAM_NAME } from "@/lib/guest-site/hotel";

export const MAX_FACILITIES = 20;
export const MAX_FACILITY_LENGTH = 40;

export type ExtrasForm = { propertyId: string; facilities: string[]; instagram: string | null; facebook: string | null };
export type ExtrasCheck = { ok: true; value: ExtrasForm } | { ok: false; code: "setup_invalid" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * One facility per line, or separated by commas. Each is trimmed, blanks are dropped and a repeat (any capitals) is dropped,
 * keeping the first. Null when there are too many or one is too long, which is a mistake to show rather than to cut off.
 */
export function parseFacilities(raw: string): string[] | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n\r,]+/)) {
    const item = part.replace(/\s+/g, " ").trim();
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  if (out.length > MAX_FACILITIES || out.some((f) => f.length > MAX_FACILITY_LENGTH)) return null;
  return out;
}

/**
 * Turns what a person typed into the stored link for one site. Accepts the bare name, an @name, a host and name, or a pasted
 * address, with or without https, www, a trailing slash or a ?query (which is dropped). Empty means "not shown" (null).
 * "invalid" when it names another site or is not a single plain name; never guesses.
 */
function normalizeSocial(input: string, host: string, name: RegExp): string | null | "invalid" {
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  const hostPrefix = new RegExp(`^${host.replace(/\./g, "\\.")}/`, "i");
  if (hostPrefix.test(s)) s = s.replace(hostPrefix, "");
  else if (s.includes("/") || s.includes(".com")) {
    // A slash or a .com that is not this site's host: another site, or a path (profile.php/x). Refuse.
    if (!s.startsWith("@")) return "invalid";
  }
  s = s
    .replace(/^@/, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
  if (!name.test(s)) return "invalid";
  return `https://${host}/${s}`;
}

export const normalizeInstagram = (input: string) => normalizeSocial(input, "instagram.com", INSTAGRAM_NAME);
/**
 * A personal address like facebook.com/profile.php?id=123 only works with its ?id=, which is dropped above, so what was left would
 * be a link to a page that does not exist. A Facebook name never ends in .php, so anything that does is refused.
 */
export function normalizeFacebook(input: string): string | null | "invalid" {
  const link = normalizeSocial(input, "facebook.com", FACEBOOK_NAME);
  return typeof link === "string" && link !== "invalid" && /\.php$/i.test(link) ? "invalid" : link;
}

/** Reads the hotel extras form. Anything unusable is one "setup_invalid", the same answer the other hotel forms give. */
export function parseExtrasForm(raw: Record<string, unknown>): ExtrasCheck {
  const propertyId = text(raw.propertyId);
  if (!UUID.test(propertyId)) return { ok: false, code: "setup_invalid" };
  const facilities = parseFacilities(typeof raw.facilities === "string" ? raw.facilities : "");
  if (facilities === null) return { ok: false, code: "setup_invalid" };
  const instagram = normalizeInstagram(text(raw.instagram));
  const facebook = normalizeFacebook(text(raw.facebook));
  if (instagram === "invalid" || facebook === "invalid") return { ok: false, code: "setup_invalid" };
  return { ok: true, value: { propertyId, facilities, instagram, facebook } };
}
