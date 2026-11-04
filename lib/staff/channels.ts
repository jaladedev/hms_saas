/** Wording and shares for the channel and guest report page (migration 044). Pure, so it can be tested. */
export type ChannelRow = { source: string; bookings: number; room_nights: number; room_revenue_minor: number; cancelled: number; no_shows: number };
export type ChannelReport = {
  property_id: string; currency: string; from: string; to: string; rows: ChannelRow[]; totals: Omit<ChannelRow, "source">;
};
export type GuestReport = {
  property_id: string; currency: string; from: string; to: string; guests_total: number; guests_new: number; guests_returning: number;
  countries: { country: string; guests: number; room_nights: number }[];
  top_guests: { guest_id: string; name: string; stays: number; room_nights: number; room_revenue_minor: number }[];
  names_hidden: boolean;
};

export const SOURCE_LABEL: Record<string, string> = {
  website: "Website", walk_in: "Walk-in", phone: "Phone", staff_entry: "Staff entry", partner: "Partner",
};
export const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? s;

/** Share of the whole as hundredths of a percent, rounded half up; null when the whole is zero. */
export function shareBp(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.floor((part * 20000 + whole) / (whole * 2));
}

/** Of the bookings due to arrive (kept ones plus cancelled and no-shows), how many were cancelled or never came. Null when none were due. */
export function lostBp(r: Pick<ChannelRow, "bookings" | "cancelled" | "no_shows">): number | null {
  return shareBp(r.cancelled + r.no_shows, r.bookings + r.cancelled + r.no_shows);
}

const COUNTRY_NAMES = new Intl.DisplayNames("en", { type: "region" });
/** "NG" becomes "Nigeria"; anything not a real code (including "unknown") is shown as it is or as "No country". */
export function countryLabel(code: string): string {
  if (code === "unknown") return "No country recorded";
  if (!/^[A-Za-z]{2}$/.test(code)) return code;
  try { return COUNTRY_NAMES.of(code.toUpperCase()) ?? code; } catch { return code; }
}

export const KINDS = ["channels", "guests"] as const;
export type Kind = (typeof KINDS)[number];
export const parseKind = (v: string | null | undefined): Kind => (v === "guests" ? "guests" : "channels");
