import { parseAmountToMinor } from "./money-input";

/**
 * Loyalty points (migration 150): what a form sends is checked here so a typo is refused before it reaches the database, and the
 * database's own refusals are turned into the codes the page words. The database still decides everything that matters (permission,
 * the flag, the balance, the state of the booking); nothing here is a rule, only a courtesy.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

export type LoyaltyCode = "loyalty_invalid";

export type Settings = { propertyId: string; enabled: boolean; earnPer100: number; pointValueMinor: number; minRedeem: number };

export type SettingsRow = { enabled: boolean; earn_per_100: number; point_value_minor: number; min_redeem: number; flag_on: boolean };

function whole(v: unknown, min: number, max: number): number | null {
  const s = String(v ?? "").trim();
  if (!/^\d{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

/** The settings form: a checkbox, points per 100 naira (1 to 50), what one point is worth in naira (0.10 to 100) and the least to spend. */
export function parseSettingsForm(raw: Record<string, unknown>): { ok: true; value: Settings } | { ok: false; code: LoyaltyCode } {
  const propertyId = String(raw.propertyId ?? "");
  const earn = whole(raw.earnPer100, 1, 50);
  const value = parseAmountToMinor(String(raw.pointValue ?? ""));
  const min = whole(raw.minRedeem, 1, 10000);
  if (!UUID.test(propertyId) || earn === null || value === null || value < 10 || value > 10000 || min === null) {
    return { ok: false, code: "loyalty_invalid" };
  }
  return {
    ok: true,
    value: {
      propertyId,
      enabled: raw.enabled === "on" || raw.enabled === "true",
      earnPer100: earn,
      pointValueMinor: value,
      minRedeem: min,
    },
  };
}

/** Points to spend on a booking. */
export function parseRedeemForm(
  raw: Record<string, unknown>,
): { ok: true; value: { reservationId: string; points: number } } | { ok: false; code: LoyaltyCode } {
  const reservationId = String(raw.reservationId ?? "");
  const points = whole(raw.points, 1, 1000000);
  if (!UUID.test(reservationId) || points === null) return { ok: false, code: "loyalty_invalid" };
  return { ok: true, value: { reservationId, points } };
}

/** A manual adjustment: plus or minus 1 to 100,000 points for an e-mail address, with a reason of up to 200 characters. */
export function parseAdjustForm(
  raw: Record<string, unknown>,
): { ok: true; value: { propertyId: string; email: string; points: number; reason: string } } | { ok: false; code: LoyaltyCode } {
  const propertyId = String(raw.propertyId ?? "");
  const email = String(raw.email ?? "").trim();
  const reason = String(raw.reason ?? "").trim();
  const sign = String(raw.direction ?? "add") === "remove" ? -1 : 1;
  const n = whole(raw.points, 1, 100000);
  if (!UUID.test(propertyId) || !EMAIL.test(email) || email.length > 254 || n === null || reason.length < 1 || reason.length > 200) {
    return { ok: false, code: "loyalty_invalid" };
  }
  return { ok: true, value: { propertyId, email, points: sign * n, reason } };
}

/** What the points are worth in minor units. */
export function pointsValueMinor(points: number, pointValueMinor: number): number {
  return Math.max(0, Math.trunc(points)) * pointValueMinor;
}

/** "1,250 points" or "1 point". */
export function pointsText(n: number): string {
  const v = Math.trunc(n);
  return `${v.toLocaleString("en-GB")} ${Math.abs(v) === 1 ? "point" : "points"}`;
}

export function parseSettingsRow(data: unknown): SettingsRow | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const earn = n(d.earn_per_100);
  const value = n(d.point_value_minor);
  const min = n(d.min_redeem);
  if (earn === null || value === null || min === null || typeof d.enabled !== "boolean" || typeof d.flag_on !== "boolean") return null;
  return { enabled: d.enabled, earn_per_100: earn, point_value_minor: value, min_redeem: min, flag_on: d.flag_on };
}

export type BookingLoyalty =
  | { enabled: false }
  | {
      enabled: true;
      hasEmail: boolean;
      balance: number;
      pointValueMinor: number;
      minRedeem: number;
      redeemedPoints: number;
      redeemedMinor: number;
      earnPer100: number;
    };

export function parseBookingLoyalty(data: unknown): BookingLoyalty {
  if (!data || typeof data !== "object") return { enabled: false };
  const d = data as Record<string, unknown>;
  if (d.enabled !== true) return { enabled: false };
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    enabled: true,
    hasEmail: d.has_email === true,
    balance: n(d.balance),
    pointValueMinor: n(d.point_value_minor),
    minRedeem: n(d.min_redeem),
    redeemedPoints: n(d.redeemed_points),
    redeemedMinor: n(d.redeemed_minor),
    earnPer100: n(d.earn_per_100),
  };
}

export type LedgerRow = {
  id: string;
  email: string;
  kind: "earn" | "redeem" | "reverse" | "adjust";
  points: number;
  reason: string | null;
  created_at: string;
  booking_reference: string | null;
  balance: number;
};

const KINDS = ["earn", "redeem", "reverse", "adjust"];
export function parseLedger(data: unknown): LedgerRow[] {
  if (!Array.isArray(data)) return [];
  const out: LedgerRow[] = [];
  for (const x of data) {
    if (!x || typeof x !== "object") continue;
    const d = x as Record<string, unknown>;
    if (typeof d.id !== "string" || typeof d.email !== "string" || typeof d.kind !== "string" || !KINDS.includes(d.kind)) continue;
    if (typeof d.points !== "number" || typeof d.created_at !== "string") continue;
    out.push({
      id: d.id,
      email: d.email,
      kind: d.kind as LedgerRow["kind"],
      points: d.points,
      reason: typeof d.reason === "string" ? d.reason : null,
      created_at: d.created_at,
      booking_reference: typeof d.booking_reference === "string" ? d.booking_reference : null,
      balance: typeof d.balance === "number" ? d.balance : 0,
    });
  }
  return out;
}

export const KIND_LABEL: Record<LedgerRow["kind"], string> = { earn: "Earned", redeem: "Spent", reverse: "Given back", adjust: "Adjusted" };

/**
 * The database's refusal as a page code. NOT_FOUND is a permission refusal; everything else is worded by the page. "loyalty off" means
 * the group's plan flag for saving settings and adjusting (`adminAction`), and the flag or this hotel's own switch for spending.
 */
export function loyaltyError(
  message: string,
  adminAction = false,
):
  | "setup_forbidden"
  | "loyalty_invalid"
  | "loyalty_flag"
  | "loyalty_off"
  | "loyalty_balance"
  | "loyalty_no_email"
  | "loyalty_discount"
  | "loyalty_state"
  | null {
  if (/NOT_FOUND/.test(message)) return "setup_forbidden";
  if (/POLICY_VIOLATION: loyalty off/.test(message)) return adminAction ? "loyalty_flag" : "loyalty_off";
  if (/POLICY_VIOLATION: balance/.test(message)) return "loyalty_balance";
  if (/POLICY_VIOLATION: no email/.test(message)) return "loyalty_no_email";
  if (/INVALID_STATE: discount/.test(message)) return "loyalty_discount";
  if (/INVALID_STATE/.test(message)) return "loyalty_state";
  if (/POLICY_VIOLATION: (enabled|earn|value|minimum|points|email|reason|amount)/.test(message)) return "loyalty_invalid";
  return null;
}
