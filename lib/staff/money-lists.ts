/**
 * The hotel-wide payments list and invoice list (prototype screens "Payments Overview", "Payment Details" and "Invoice List").
 * Pure functions, so they can be tested. The screens only read: every row is read under row-level security, so who sees what
 * is decided by `can_view_money` (payments, invoices) in the database, never here.
 */
import { parseIsoDate, sanitizeSearch } from "./reservations";

export const MONEY_PAGE_SIZE = 25;

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const pageOf = (v: string | string[] | undefined) => {
  const n = Number(one(v));
  return Number.isInteger(n) && n >= 1 && n <= 10000 ? n : 1;
};

// ---- Payments ---------------------------------------------------------------------------------------------------------

/** Manual methods come from the desk; the rest are what Paystack reports for a payment made online. */
export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  bank_transfer: "Bank transfer",
  pos: "POS",
  other: "Other",
  card: "Card",
  bank: "Bank",
  ussd: "USSD",
  qr: "QR",
  mobile_money: "Mobile money",
  eft: "EFT",
};
export const paymentMethodLabel = (m: string) => PAYMENT_METHOD_LABEL[m] ?? m;

export const PAYMENT_SOURCE_LABEL: Record<string, string> = { manual: "Recorded by staff", paystack: "Paystack" };
export const paymentSourceLabel = (p: string) => PAYMENT_SOURCE_LABEL[p] ?? p;

export const PAYMENT_STATUS_LABEL: Record<string, string> = { succeeded: "Received", reversed: "Reversed" };
export const paymentStatusLabel = (s: string) => PAYMENT_STATUS_LABEL[s] ?? s;

export const VERIFICATION_LABEL: Record<string, string> = { verified: "Verified", unverified: "Not yet verified" };
export const verificationLabel = (s: string) => VERIFICATION_LABEL[s] ?? s;

export const PAYMENT_SOURCE_FILTERS = [
  { value: "all", label: "All payments" },
  { value: "manual", label: "Recorded by staff" },
  { value: "paystack", label: "Paystack (online)" },
] as const;
export const PAYMENT_STATUS_FILTERS = [
  { value: "all", label: "Any status" },
  { value: "succeeded", label: "Received" },
  { value: "reversed", label: "Reversed" },
  { value: "unverified", label: "Waiting to be verified" },
] as const;

export type PaymentSource = (typeof PAYMENT_SOURCE_FILTERS)[number]["value"];
export type PaymentStatusFilter = (typeof PAYMENT_STATUS_FILTERS)[number]["value"];
export type PaymentFilters = {
  q: string;
  source: PaymentSource;
  status: PaymentStatusFilter;
  from: string | null;
  to: string | null;
  page: number;
};

/** Reads ?q=&source=&status=&from=&to=&page= from the URL. Anything unrecognised falls back to the default. */
export function parsePaymentFilters(search: Search): PaymentFilters {
  const source = one(search.source);
  const status = one(search.status);
  return {
    q: sanitizeSearch(one(search.q)),
    source: PAYMENT_SOURCE_FILTERS.some((f) => f.value === source) ? (source as PaymentSource) : "all",
    status: PAYMENT_STATUS_FILTERS.some((f) => f.value === status) ? (status as PaymentStatusFilter) : "all",
    from: parseIsoDate(one(search.from)),
    to: parseIsoDate(one(search.to)),
    page: pageOf(search.page),
  };
}

/** Query string for a link on the payments list, leaving out anything at its default so URLs stay short. */
export function paymentQuery(f: PaymentFilters, over: Partial<PaymentFilters> = {}): string {
  const m = { ...f, ...over };
  const qs = new URLSearchParams();
  if (m.q) qs.set("q", m.q);
  if (m.source !== "all") qs.set("source", m.source);
  if (m.status !== "all") qs.set("status", m.status);
  if (m.from) qs.set("from", m.from);
  if (m.to) qs.set("to", m.to);
  if (m.page > 1) qs.set("page", String(m.page));
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export const paymentFiltersActive = (f: PaymentFilters) =>
  f.q !== "" || f.source !== "all" || f.status !== "all" || f.from !== null || f.to !== null;

/** The database columns a status filter stands for. "unverified" is a verification state, not a payment status. */
export function paymentStatusColumns(s: PaymentStatusFilter): { payment_status?: string; verification_status?: string } {
  if (s === "unverified") return { payment_status: "succeeded", verification_status: "unverified" };
  if (s === "all") return {};
  return { payment_status: s };
}

/**
 * Money that has actually been received on the page: received payments only, in one currency at a time, because adding
 * naira to dollars would give a number that means nothing. Reversed payments are left out.
 */
export function receivedTotals(rows: { amount_minor: number; currency: string; payment_status: string }[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (r.payment_status !== "succeeded") continue;
    totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.amount_minor);
  }
  return totals;
}

// ---- Invoices ---------------------------------------------------------------------------------------------------------

export const INVOICE_STATUS_LABEL: Record<string, string> = {
  issued: "Issued",
  partially_paid: "Part paid",
  paid: "Paid",
  void: "Void",
};
export const invoiceStatusLabel = (s: string) => INVOICE_STATUS_LABEL[s] ?? s;

export const INVOICE_KIND_FILTERS = [
  { value: "stay", label: "Booking invoices" },
  { value: "extras", label: "Invoices for extras" },
] as const;
export type InvoiceKind = (typeof INVOICE_KIND_FILTERS)[number]["value"];

/** An invoice for extras is only ever issued or void: it moves no money, so it has no paid states. */
export const INVOICE_STATUS_FILTERS: Record<InvoiceKind, readonly { value: string; label: string }[]> = {
  stay: [
    { value: "all", label: "Any status" },
    { value: "issued", label: INVOICE_STATUS_LABEL.issued! },
    { value: "partially_paid", label: INVOICE_STATUS_LABEL.partially_paid! },
    { value: "paid", label: INVOICE_STATUS_LABEL.paid! },
    { value: "void", label: INVOICE_STATUS_LABEL.void! },
  ],
  extras: [
    { value: "all", label: "Any status" },
    { value: "issued", label: INVOICE_STATUS_LABEL.issued! },
    { value: "void", label: INVOICE_STATUS_LABEL.void! },
  ],
};

export type InvoiceFilters = { q: string; kind: InvoiceKind; status: string; from: string | null; to: string | null; page: number };

export function parseInvoiceFilters(search: Search): InvoiceFilters {
  const kindRaw = one(search.kind);
  const kind: InvoiceKind = kindRaw === "extras" ? "extras" : "stay";
  const status = one(search.status) ?? "all";
  return {
    q: sanitizeSearch(one(search.q)),
    kind,
    // A status the chosen kind does not have (for example "paid" on extras) is ignored rather than returning nothing.
    status: INVOICE_STATUS_FILTERS[kind].some((s) => s.value === status) ? status : "all",
    from: parseIsoDate(one(search.from)),
    to: parseIsoDate(one(search.to)),
    page: pageOf(search.page),
  };
}

export function invoiceQuery(f: InvoiceFilters, over: Partial<InvoiceFilters> = {}): string {
  const m = { ...f, ...over };
  const qs = new URLSearchParams();
  if (m.q) qs.set("q", m.q);
  if (m.kind !== "stay") qs.set("kind", m.kind);
  if (m.status !== "all") qs.set("status", m.status);
  if (m.from) qs.set("from", m.from);
  if (m.to) qs.set("to", m.to);
  if (m.page > 1) qs.set("page", String(m.page));
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export const invoiceFiltersActive = (f: InvoiceFilters) =>
  f.q !== "" || f.kind !== "stay" || f.status !== "all" || f.from !== null || f.to !== null;

/**
 * Overdue means a live invoice with a due date that has passed and money still owed. Paid and void invoices are never
 * overdue, and an invoice with no due date cannot be.
 */
export function isOverdue(inv: { invoice_status: string; due_at: string | null }, now: Date): boolean {
  if (inv.invoice_status !== "issued" && inv.invoice_status !== "partially_paid") return false;
  if (!inv.due_at) return false;
  const t = new Date(inv.due_at).getTime();
  return !Number.isNaN(t) && t < now.getTime();
}

/**
 * What is still owed on a booking invoice: its total less the money held on the booking (succeeded payments minus succeeded refunds,
 * the same figure the database uses to set the invoice's status, `reservation_money_held`). A void invoice owes nothing. Never negative:
 * money held above the total is shown as nothing owed, not as a credit.
 */
export function invoiceBalanceMinor(invoiceStatus: string, totalMinor: number, heldMinor: number): number {
  if (invoiceStatus === "void") return 0;
  return Math.max(totalMinor - Math.max(heldMinor, 0), 0);
}

/** Money held per booking from payment and refund rows (rows of other statuses are ignored). */
export function moneyHeldByReservation(
  payments: { reservation_id: string; amount_minor: number; payment_status: string }[],
  refunds: { reservation_id: string; amount_minor: number; refund_status: string }[],
): Map<string, number> {
  const held = new Map<string, number>();
  for (const p of payments)
    if (p.payment_status === "succeeded") held.set(p.reservation_id, (held.get(p.reservation_id) ?? 0) + p.amount_minor);
  for (const r of refunds)
    if (r.refund_status === "succeeded") held.set(r.reservation_id, (held.get(r.reservation_id) ?? 0) - r.amount_minor);
  return held;
}

// ---- Dates ------------------------------------------------------------------------------------------------------------

/** Minutes a zone is ahead of UTC at a moment (60 for Africa/Lagos). Zero for an unknown zone. */
function zoneOffsetMinutes(ms: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(ms));
    const v = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second"));
    return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
  } catch {
    return 0;
  }
}

/**
 * The first instant of a calendar day (YYYY-MM-DD) in a time zone, as an ISO string, so "from 1 Nov" means the hotel's
 * 1 Nov and not UTC's. Two passes settle the offset on a day where the clocks change.
 */
export function startOfDayIso(date: string, timeZone: string): string {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  const midnightUtc = Date.UTC(y, m - 1, d);
  let ms = midnightUtc - zoneOffsetMinutes(midnightUtc, timeZone) * 60000;
  ms = midnightUtc - zoneOffsetMinutes(ms, timeZone) * 60000;
  return new Date(ms).toISOString();
}

/** The first instant of the day after `date`: an exclusive upper bound for "to and including that day". */
export function startOfNextDayIso(date: string, timeZone: string): string {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return startOfDayIso(next, timeZone);
}

/** One zone for a date filter: the hotels' shared zone when they all agree, else UTC (and the page says so). */
export function filterZone(zones: string[]): { zone: string; mixed: boolean } {
  const distinct = [...new Set(zones)];
  if (distinct.length === 1) return { zone: distinct[0]!, mixed: false };
  return { zone: "UTC", mixed: distinct.length > 1 };
}

// ---- The money position tiles (migration 113) -------------------------------------------------------------------------

export type SummaryRow = { currency: string; amount_minor: number; count: number };
export type PaymentsSummary = { received: SummaryRow[]; unverified: SummaryRow[]; refunds_open: SummaryRow[]; refunded: SummaryRow[] };

const isRow = (r: unknown): r is SummaryRow =>
  typeof r === "object" &&
  r !== null &&
  typeof (r as SummaryRow).currency === "string" &&
  Number.isSafeInteger((r as SummaryRow).amount_minor) &&
  Number.isSafeInteger((r as SummaryRow).count);

/**
 * Reads what payments_summary returned. Anything that is not the expected shape gives null, so the page shows no tiles rather
 * than wrong ones; a list with an odd row keeps only the good rows, and a missing list is empty.
 */
export function parseSummary(raw: unknown): PaymentsSummary | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const list = (k: string): SummaryRow[] => (Array.isArray(o[k]) ? (o[k] as unknown[]).filter(isRow) : []);
  return { received: list("received"), unverified: list("unverified"), refunds_open: list("refunds_open"), refunded: list("refunded") };
}

/** The window the date filter stands for, as the two instants payments_summary takes (either may be null for no limit). */
export function summaryWindow(f: { from: string | null; to: string | null }, zone: string): { from: string | null; to: string | null } {
  return { from: f.from ? startOfDayIso(f.from, zone) : null, to: f.to ? startOfNextDayIso(f.to, zone) : null };
}

/** What the two dated tiles are about, in words: "All time", "From 1 Nov 2026", "Up to 10 Nov 2026" or "1 Nov 2026 to 10 Nov 2026". */
export function windowLabel(f: { from: string | null; to: string | null }, fmt: (iso: string) => string): string {
  if (f.from && f.to) return f.from === f.to ? fmt(f.from) : `${fmt(f.from)} to ${fmt(f.to)}`;
  if (f.from) return `From ${fmt(f.from)}`;
  if (f.to) return `Up to ${fmt(f.to)}`;
  return "All time";
}

/** "3 payments" or "1 refund": the count under an amount. */
export const countLabel = (n: number, noun: "payment" | "refund") => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** A calendar day (YYYY-MM-DD) as "1 Nov 2026", the same on every machine. Anything unusable is shown as it was given. */
export function formatDay(iso: string): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
