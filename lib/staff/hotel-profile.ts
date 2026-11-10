/**
 * The hotel's public profile: contact phone, contact email and a short introduction shown on the guest site.
 * The same rules as the database checks (migration 087), so a mistake is explained on the form instead of being refused later.
 */

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
