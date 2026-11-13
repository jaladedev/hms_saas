/** Rules for the rates screen: date ranges, price overrides and how stored nightly prices are summarised. Pure, so testable. */
import { parseAmountToMinor } from "./money-input";
import { nightsBetween, parseIsoDate } from "./reservations";
import type { ErrorCode } from "./refunds";

export const MAX_RANGE_NIGHTS = 366;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function addDay(iso: string, n: number): string {
  const [y = 0, m = 0, d = 0] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export const WEEKDAYS = [
  { key: "mon", label: "Mon", day: 1 },
  { key: "tue", label: "Tue", day: 2 },
  { key: "wed", label: "Wed", day: 3 },
  { key: "thu", label: "Thu", day: 4 },
  { key: "fri", label: "Fri", day: 5 },
  { key: "sat", label: "Sat", day: 6 },
  { key: "sun", label: "Sun", day: 0 },
] as const;

/** Day of the week of a calendar date, 0 = Sunday to 6 = Saturday. Dates are plain business dates, so no time zone applies. */
function weekdayOf(iso: string): number {
  const [y = 0, m = 0, d = 0] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * The weekdays ticked on the form, as numbers (0 = Sunday). Nothing ticked means every night, so it returns null (no filter).
 * Anything that is not one of the seven keys makes the whole input invalid (the string "invalid"), rather than quietly pricing
 * more nights than the person meant.
 */
export function parseWeekdays(values: unknown[]): number[] | null | "invalid" {
  const picked = new Set<number>();
  for (const v of values) {
    const hit = WEEKDAYS.find((w) => w.key === v);
    if (!hit) return "invalid";
    picked.add(hit.day);
  }
  if (picked.size === 0 || picked.size === 7) return null;
  return [...picked];
}

/**
 * Every date from `from` to `to`, both included, or only those that fall on one of `weekdays` (0 = Sunday) when given. Empty when
 * the range is backwards or invalid.
 */
export function expandDates(from: string, to: string, weekdays?: number[] | null): string[] {
  if (!parseIsoDate(from) || !parseIsoDate(to) || to < from) return [];
  const out: string[] = [];
  let looked = 0;
  for (let d = from; d <= to && looked <= MAX_RANGE_NIGHTS; d = addDay(d, 1), looked++) {
    if (!weekdays || weekdays.includes(weekdayOf(d))) out.push(d);
  }
  return out;
}

export type RateRangeInput = { propertyId: string; roomTypeId: string; from: string; to: string; amountMinor: number | null };

/** `needAmount` is false when clearing overrides, where no price is given. */
export function validateRateRange(
  raw: Record<string, unknown>,
  needAmount: boolean,
): { ok: true; value: RateRangeInput } | { ok: false; code: ErrorCode } {
  const propertyId = clean(raw.propertyId, 50);
  const roomTypeId = clean(raw.roomTypeId, 50);
  if (!GUID.test(propertyId) || !GUID.test(roomTypeId)) return { ok: false, code: "bad_request" };
  const from = parseIsoDate(clean(raw.from, 10));
  const to = parseIsoDate(clean(raw.to, 10));
  if (!from || !to || to < from) return { ok: false, code: "rate_range_invalid" };
  if (nightsBetween(from, to) + 1 > MAX_RANGE_NIGHTS) return { ok: false, code: "rate_range_long" };
  let amountMinor: number | null = null;
  if (needAmount) {
    amountMinor = parseAmountToMinor(clean(raw.amount, 50));
    if (amountMinor === null) return { ok: false, code: "rate_range_invalid" };
  }
  return { ok: true, value: { propertyId, roomTypeId, from, to, amountMinor } };
}

export type StoredRate = { business_date: string; amount_minor: number };
export type RateRange = { from: string; to: string; amountMinor: number; nights: number };

/** Consecutive nights with the same price become one range, so 60 stored rows read as "1 Dec to 31 Jan: ₦60,000". */
export function groupRanges(rows: StoredRate[]): RateRange[] {
  const sorted = [...rows].sort((a, b) => a.business_date.localeCompare(b.business_date));
  const out: RateRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && last.amountMinor === r.amount_minor && addDay(last.to, 1) === r.business_date) {
      last.to = r.business_date;
      last.nights += 1;
    } else out.push({ from: r.business_date, to: r.business_date, amountMinor: r.amount_minor, nights: 1 });
  }
  return out;
}
