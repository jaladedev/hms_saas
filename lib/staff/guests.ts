/** Rules for the guest screens. Pure functions, tested without a database. */

/**
 * Turns what someone typed into a safe "contains" pattern for name, email and phone, or null if there is
 * too little to search on. Only letters, digits, spaces and . @ + ' - survive: commas, brackets, quotes and
 * wildcards would change the meaning of the filter string they are placed in.
 */
export function searchPattern(input: string | undefined): string | null {
  const cleaned = (input ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} .@+'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 2 ? `*${cleaned.slice(0, 60)}*` : null;
}

export type StayRow = {
  primary_guest_id: string;
  reservation_status: string;
  arrival_date: string;
  departure_date: string;
  total_minor?: number;
  currency?: string;
};
export type StaySummary = {
  completed: number;
  nextArrival: string | null;
  lastDeparture: string | null;
  inHouse: boolean;
  /** The total booked on completed (checked out) stays, per currency, in minor units. Never added across currencies. */
  booked: Map<string, number>;
};

/** Per guest: finished stays, the next confirmed arrival from today on, the latest departure, and whether they are in house now. */
export function summariseStays(rows: StayRow[], today: string): Map<string, StaySummary> {
  const out = new Map<string, StaySummary>();
  for (const r of rows) {
    const s = out.get(r.primary_guest_id) ?? { completed: 0, nextArrival: null, lastDeparture: null, inHouse: false, booked: new Map() };
    if (r.reservation_status === "checked_out") {
      s.completed++;
      if (typeof r.total_minor === "number" && Number.isSafeInteger(r.total_minor) && typeof r.currency === "string") {
        s.booked.set(r.currency, (s.booked.get(r.currency) ?? 0) + r.total_minor);
      }
    }
    if (r.reservation_status === "checked_in") s.inHouse = true;
    if (
      (r.reservation_status === "checked_out" || r.reservation_status === "checked_in") &&
      (s.lastDeparture === null || r.departure_date > s.lastDeparture)
    ) {
      s.lastDeparture = r.departure_date;
    }
    if (r.reservation_status === "confirmed" && r.arrival_date >= today && (s.nextArrival === null || r.arrival_date < s.nextArrival)) {
      s.nextArrival = r.arrival_date;
    }
    out.set(r.primary_guest_id, s);
  }
  return out;
}

/** One line for a list row: "In house", "Arrives 5 Nov 2026", "2 stays, last left 3 Oct 2026", or "No stays yet". */
export function stayLine(s: StaySummary | undefined, fmt: (iso: string) => string): string {
  if (!s) return "No stays yet";
  if (s.inHouse) return "In house now";
  if (s.nextArrival) return `Arrives ${fmt(s.nextArrival)}`;
  if (s.completed > 0)
    return `${s.completed} ${s.completed === 1 ? "stay" : "stays"}${s.lastDeparture ? `, last left ${fmt(s.lastDeparture)}` : ""}`;
  return "No stays yet";
}

/**
 * "NGN 450,000 booked" for the guest's completed stays, or null when there is nothing to show. It is the room total booked on stays
 * that have finished: extras on the folio and what was actually paid are not in it, which is why it says "booked" and not "spent".
 * More than one currency are listed side by side ("and"), never added together.
 */
export function bookedLine(s: StaySummary | undefined, fmtMoney: (minor: number, currency: string) => string): string | null {
  if (!s || s.booked.size === 0) return null;
  const parts = [...s.booked]
    .filter(([, minor]) => minor > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cur, minor]) => fmtMoney(minor, cur));
  return parts.length > 0 ? `${parts.join(" and ")} booked` : null;
}

/** Reads ?vip=1 from the guest list URL. Only the exact value "1" turns the filter on. */
export const vipOnly = (v: string | string[] | undefined): boolean => (Array.isArray(v) ? v[0] : v) === "1";

export const MAX_NOTES = 2000;

/** Same checks as set_guest_profile, so a mistake is explained before the round trip. The database still decides. */
export function checkGuestProfile(f: { notes: string }): "guest_notes" | null {
  return f.notes.trim().length > MAX_NOTES ? "guest_notes" : null;
}

export type GuestForm = { full_name: string; email: string; phone: string; address: string; country_code: string };

/** Same checks as update_guest, so the person hears about a mistake before the round trip. The database still decides. */
export function checkGuestForm(f: GuestForm): "guest_name" | "guest_email" | "guest_country" | "guest_field" | null {
  const name = f.full_name.replace(/\s+/g, " ").trim();
  if (name.length === 0 || name.length > 200) return "guest_name";
  const email = f.email.trim();
  if (email && (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) return "guest_email";
  const cc = f.country_code.trim();
  if (cc && !/^[A-Za-z]{2}$/.test(cc)) return "guest_country";
  if (f.phone.trim().length > 40 || f.address.trim().length > 500) return "guest_field";
  return null;
}
