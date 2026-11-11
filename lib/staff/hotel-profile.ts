/**
 * The hotel's public profile: contact phone, contact email and a short introduction shown on the guest site.
 * The same rules as the database checks (migration 087), so a mistake is explained on the form instead of being refused later.
 */

import { normalizeHex, parseTheme, primaryContrast, type ThemeId } from "@/lib/theme";

export const MAX_INTRO = 500;

export type ProfileForm = { propertyId: string; phone: string | null; email: string | null; intro: string | null };
export type ProfileCheck = { ok: true; value: ProfileForm } | { ok: false; code: "setup_invalid" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = /^[0-9+() -]{5,32}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Trims each field; an empty one means "not shown". */
export function parseProfileForm(raw: Record<string, unknown>): ProfileCheck {
  const propertyId = text(raw.propertyId);
  if (!UUID.test(propertyId)) return { ok: false, code: "setup_invalid" };
  const phone = text(raw.phone);
  const email = text(raw.email);
  const intro = text(raw.intro);
  if (phone && !PHONE.test(phone)) return { ok: false, code: "setup_invalid" };
  if (email && (email.length > 254 || !EMAIL.test(email))) return { ok: false, code: "setup_invalid" };
  if (intro.length > MAX_INTRO) return { ok: false, code: "setup_invalid" };
  return { ok: true, value: { propertyId, phone: phone || null, email: email || null, intro: intro || null } };
}

/** A phone number as a link target: digits and a leading plus only. Null when nothing dialable is left. */
export function telHref(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/[^0-9+]/g, "");
  return digits.replace(/\+/g, "").length >= 5 ? `tel:${digits}` : null;
}

export type BasicsForm = {
  propertyId: string;
  name: string;
  address: string | null;
  city: string;
  state: string;
  checkIn: string;
  checkOut: string;
};
export type BasicsCheck = { ok: true; value: BasicsForm } | { ok: false; code: "setup_invalid" };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The hotel's name, address, town, state and check-in and check-out times (migration 089); same limits as the database. */
export function parseBasicsForm(raw: Record<string, unknown>): BasicsCheck {
  const propertyId = text(raw.propertyId);
  const name = text(raw.name),
    address = text(raw.address),
    city = text(raw.city),
    state = text(raw.state);
  const checkIn = text(raw.checkIn),
    checkOut = text(raw.checkOut);
  if (!UUID.test(propertyId)) return { ok: false, code: "setup_invalid" };
  if (!name || name.length > 120) return { ok: false, code: "setup_invalid" };
  if (address.length > 200) return { ok: false, code: "setup_invalid" };
  if (!city || city.length > 80 || !state || state.length > 80) return { ok: false, code: "setup_invalid" };
  if (!TIME.test(checkIn) || !TIME.test(checkOut)) return { ok: false, code: "setup_invalid" };
  return { ok: true, value: { propertyId, name, address: address || null, city, state, checkIn, checkOut } };
}

export type ThemeForm = { propertyId: string; theme: ThemeId | null; primary: string | null };
export type ThemeCheck = { ok: true; value: ThemeForm } | { ok: false; code: "setup_invalid" | "theme_color" | "theme_contrast" };

/**
 * The hotel's look (migrations 093 and 099): "standard" (the look the app has always had) or one of the three theme names,
 * and an optional main colour (#rrggbb, blank for the theme's own). A colour white text cannot be read on is refused.
 */
export function parseThemeForm(raw: Record<string, unknown>): ThemeCheck {
  const propertyId = text(raw.propertyId);
  const choice = text(raw.theme);
  if (!UUID.test(propertyId)) return { ok: false, code: "setup_invalid" };
  const theme = choice === "standard" ? null : parseTheme(choice);
  if (choice !== "standard" && !theme) return { ok: false, code: "setup_invalid" };
  const colorRaw = text(raw.primary);
  const primary = colorRaw ? normalizeHex(colorRaw) : null;
  if (colorRaw && !primary) return { ok: false, code: "theme_color" };
  if (primary && primaryContrast(primary, theme).some((l) => !l.pass)) return { ok: false, code: "theme_contrast" };
  return { ok: true, value: { propertyId, theme, primary } };
}

/** "14:00:00" from the database as "14:00" for a time field. */
export const timeInput = (t: string | null | undefined): string => (t ?? "").slice(0, 5);
