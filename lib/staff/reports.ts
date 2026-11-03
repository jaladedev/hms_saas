/** Date ranges and wording for the daily report page (migration 036). Pure, so it can be tested. */
import { nightsBetween, parseIsoDate } from "./reservations";

export const MAX_REPORT_DAYS = 92;

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The last 7 days up to and including today, which is what the page opens on. */
export function defaultRange(today: string): { from: string; to: string } {
  return { from: addDays(today, -6), to: today };
}

export type Range = { from: string; to: string; fixed: boolean };

/** ?from=&to= from the URL. Anything unreadable, backwards or longer than 92 days gives the default, and `fixed` says it did. */
export function parseRange(search: { from?: string | string[]; to?: string | string[] }, today: string): Range {
  const pick = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const rawFrom = pick(search.from);
  const rawTo = pick(search.to);
  const from = parseIsoDate(rawFrom);
  const to = parseIsoDate(rawTo);
  if (!rawFrom && !rawTo) return { ...defaultRange(today), fixed: false };
  if (!from || !to || to < from || nightsBetween(from, to) + 1 > MAX_REPORT_DAYS) return { ...defaultRange(today), fixed: true };
  return { from, to, fixed: false };
}

export function presets(today: string): { label: string; from: string; to: string }[] {
  return [
    { label: "Today", from: today, to: today },
    { label: "Yesterday", from: addDays(today, -1), to: addDays(today, -1) },
    { label: "Last 7 days", from: addDays(today, -6), to: today },
    { label: "Last 30 days", from: addDays(today, -29), to: today },
    { label: "This month", from: `${today.slice(0, 8)}01`, to: today },
  ];
}

export type ReportDay = {
  date: string; online_minor: number; cash_minor: number; bank_transfer_minor: number; pos_minor: number; other_minor: number;
  received_minor: number; refunded_minor: number; net_minor: number;
  room_revenue_minor: number; room_tax_minor: number; extras_minor: number; extras_tax_minor: number; cancellation_charges_minor: number;
};
export type Report = { property_id: string; currency: string; timezone: string; from: string; to: string; days: ReportDay[]; totals: Omit<ReportDay, "date"> };

/** Earned before tax: room nights, extras and cancellation charges (the charge has its tax inside it). */
export const earnedMinor = (d: Omit<ReportDay, "date">) => d.room_revenue_minor + d.extras_minor + d.cancellation_charges_minor;
export const taxMinor = (d: Omit<ReportDay, "date">) => d.room_tax_minor + d.extras_tax_minor;

/** A day with nothing in it at all, so the table can grey it out. */
export function isQuiet(d: ReportDay): boolean {
  return d.received_minor === 0 && d.refunded_minor === 0 && earnedMinor(d) === 0 && taxMinor(d) === 0;
}

export const CHANNELS = [
  { key: "online_minor", label: "Online" },
  { key: "cash_minor", label: "Cash" },
  { key: "bank_transfer_minor", label: "Transfer" },
  { key: "pos_minor", label: "POS" },
  { key: "other_minor", label: "Other" },
] as const;

export const ERROR_TEXT: Record<string, string> = {
  fixed: "That date range was not usable (dates must be real, in order, and at most 92 days), so the last 7 days are shown.",
};
