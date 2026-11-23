/**
 * Guest ID type and number (migration 183): the types, the same checks the database makes, and the masked form shown to staff.
 * Pure helpers, so they can be tested without a browser. The database still decides; nothing here stores or logs a number.
 */

export const GUEST_ID_TYPES = ["nin", "passport", "drivers_licence", "voters_card", "other"] as const;
export type GuestIdType = (typeof GUEST_ID_TYPES)[number];

export const GUEST_ID_TYPE_LABEL: Record<GuestIdType, string> = {
  nin: "National ID number (NIN)",
  passport: "Passport",
  drivers_licence: "Driver's licence",
  voters_card: "Voter's card",
  other: "Other ID",
};

export function isGuestIdType(v: unknown): v is GuestIdType {
  return typeof v === "string" && (GUEST_ID_TYPES as readonly string[]).includes(v);
}

/** The number as the database stores it: trimmed, upper case, single spaces. */
export function normaliseGuestIdNumber(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toUpperCase();
}

export type GuestIdForm = { id_type: string; id_number: string };

/** Both blank clears the ID. Otherwise both are needed, the type from the list, the number 6 to 40 letters, digits, spaces, slashes or hyphens. */
export function checkGuestIdForm(f: GuestIdForm): "guest_id_both" | "guest_id_type" | "guest_id_number" | null {
  const type = f.id_type.trim();
  const num = normaliseGuestIdNumber(f.id_number);
  if (type === "" && num === "") return null;
  if (type === "" || num === "") return "guest_id_both";
  if (!isGuestIdType(type.toLowerCase())) return "guest_id_type";
  if (num.length < 6 || num.length > 40 || !/^[A-Z0-9][A-Z0-9 /-]*$/.test(num)) return "guest_id_number";
  return null;
}

/** "Passport, ending 678": what staff without the right to read the full number see. */
export function maskedGuestId(s: { id_type: string; last3: string }): string {
  const label = isGuestIdType(s.id_type) ? GUEST_ID_TYPE_LABEL[s.id_type] : "ID";
  return `${label}, ending ${s.last3}`;
}

/** Turns a database refusal into one of our codes. Raw database text never reaches the page. */
export function classifyGuestIdError(err: {
  code?: string;
  message?: string;
}): "guest_id_both" | "guest_id_type" | "guest_id_number" | "guest_id_forbidden" | "unknown" {
  const msg = err.message ?? "";
  if (/id both/i.test(msg)) return "guest_id_both";
  if (/id type/i.test(msg)) return "guest_id_type";
  if (/id number/i.test(msg)) return "guest_id_number";
  if (/NOT_FOUND/.test(msg) || err.code === "42501") return "guest_id_forbidden";
  return "unknown";
}
