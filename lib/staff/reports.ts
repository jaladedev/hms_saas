/**
 * Reports screen (`/app/reports`): the date range from the address, and the totals shown over the rows that
 * `daily_report` returns. Pure functions, so they can be tested. The database decides who may read (report.view).
 */
export type ReportDay = {
  day: string; rooms_available: number; rooms_sold: number;
  room_revenue_minor: number; room_tax_minor: number; extras_minor: number; extras_tax_minor: number;
  cash_in_minor: number; refunds_paid_minor: number;
};

export const MAX_RANGE_DAYS = 92;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIso(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const m = ISO.exec(v);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? t : null;
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/**
 * The range to show. Missing or unusable dates give the last 7 days ending today; a reversed range is swapped;
 * a range longer than MAX_RANGE_DAYS is cut to the most recent days, and `trimmed` says so.
 */
export function parseRange(from: unknown, to: unknown, today: string): { from: string; to: string; trimmed: boolean } {
  const t = parseIso(today) ?? new Date();
  let a = parseIso(from); let b = parseIso(to);
  if (!a || !b) { b = t; a = addDays(t, -6); }
  if (a > b) [a, b] = [b, a];
  let trimmed = false;
  if ((b.getTime() - a.getTime()) / 86_400_000 + 1 > MAX_RANGE_DAYS) { a = addDays(b, -(MAX_RANGE_DAYS - 1)); trimmed = true; }
  return { from: iso(a), to: iso(b), trimmed };
}

/** Quick ranges for the report screens, ending today. */
export function presets(today: string): { label: string; from: string; to: string }[] {
  const t = parseIso(today) ?? new Date();
  const day = (n: number) => iso(addDays(t, n));
  return [
    { label: "Today", from: day(0), to: day(0) },
    { label: "Yesterday", from: day(-1), to: day(-1) },
    { label: "Last 7 days", from: day(-6), to: day(0) },
    { label: "Last 30 days", from: day(-29), to: day(0) },
    { label: "This month", from: `${iso(t).slice(0, 8)}01`, to: day(0) },
  ];
}

export type Totals = {
  days: number; roomNights: number; roomsAvailableNights: number; occupancyPercent: number | null;
  roomRevenue: number; roomTax: number; extras: number; extrasTax: number;
  /** Before tax: room revenue plus extras. */
  earned: number;
  cashIn: number; refundsPaid: number;
  /** Cash received less refunds paid. */
  cashNet: number;
  /** Earned room revenue per room sold, before tax; null when no room was sold. */
  averageRate: number | null;
};

export function totals(rows: ReportDay[]): Totals {
  const sum = (f: (r: ReportDay) => number) => rows.reduce((s, r) => s + f(r), 0);
  const roomNights = sum((r) => r.rooms_sold);
  const avail = sum((r) => r.rooms_available);
  const roomRevenue = sum((r) => r.room_revenue_minor);
  const extras = sum((r) => r.extras_minor);
  const cashIn = sum((r) => r.cash_in_minor);
  const refundsPaid = sum((r) => r.refunds_paid_minor);
  return {
    days: rows.length, roomNights, roomsAvailableNights: avail,
    occupancyPercent: avail > 0 ? Math.round((roomNights / avail) * 1000) / 10 : null,
    roomRevenue, roomTax: sum((r) => r.room_tax_minor), extras, extrasTax: sum((r) => r.extras_tax_minor),
    earned: roomRevenue + extras, cashIn, refundsPaid, cashNet: cashIn - refundsPaid,
    averageRate: roomNights > 0 ? Math.round(roomRevenue / roomNights) : null,
  };
}

/** Occupancy of one day as a percent with one decimal, or null when no rooms were available. */
export function dayOccupancy(r: Pick<ReportDay, "rooms_sold" | "rooms_available">): number | null {
  return r.rooms_available > 0 ? Math.round((r.rooms_sold / r.rooms_available) * 1000) / 10 : null;
}

/** The report as CSV, amounts in naira with two decimals, for a spreadsheet. */
export function toCsv(rows: ReportDay[]): string {
  const naira = (m: number) => (m / 100).toFixed(2);
  const head = ["Date", "Rooms available", "Rooms sold", "Occupancy %", "Room revenue", "Room tax", "Extras", "Extras tax", "Cash received", "Refunds paid"];
  const lines = rows.map((r) => [r.day, r.rooms_available, r.rooms_sold, dayOccupancy(r) ?? "", naira(r.room_revenue_minor), naira(r.room_tax_minor), naira(r.extras_minor), naira(r.extras_tax_minor), naira(r.cash_in_minor), naira(r.refunds_paid_minor)].join(","));
  return [head.join(","), ...lines].join("\n") + "\n";
}
