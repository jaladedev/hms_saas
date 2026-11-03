/** The daily report as CSV. Amounts are written in major units (naira) with two decimals, dates as YYYY-MM-DD. Pure, so it can be tested. */
import { earnedMinor, taxMinor, type Report, type ReportDay } from "./reports";

const COLUMNS: { header: string; value: (d: ReportDay) => string | number }[] = [
  { header: "Date", value: (d) => d.date },
  { header: "Online", value: (d) => major(d.online_minor) },
  { header: "Cash", value: (d) => major(d.cash_minor) },
  { header: "Transfer", value: (d) => major(d.bank_transfer_minor) },
  { header: "POS", value: (d) => major(d.pos_minor) },
  { header: "Other", value: (d) => major(d.other_minor) },
  { header: "Received", value: (d) => major(d.received_minor) },
  { header: "Refunded", value: (d) => major(d.refunded_minor) },
  { header: "Net", value: (d) => major(d.net_minor) },
  { header: "Room revenue", value: (d) => major(d.room_revenue_minor) },
  { header: "Extras", value: (d) => major(d.extras_minor) },
  { header: "Cancellation charges", value: (d) => major(d.cancellation_charges_minor) },
  { header: "Earned before tax", value: (d) => major(earnedMinor(d)) },
  { header: "Tax", value: (d) => major(taxMinor(d)) },
];

/** Kobo to "1234.50", exactly, with no floating point. */
export function major(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(minor));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** One CSV field: quoted when it holds a comma, quote, or line break; a leading = + - @ is neutralised so a spreadsheet never runs it. */
export function csvField(v: string | number): string {
  let s = String(v);
  if (typeof v === "string" && /^[=+@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function reportCsv(report: Report): string {
  const rows = [...report.days, { ...report.totals, date: "Total" }];
  const lines = [COLUMNS.map((c) => csvField(c.header)).join(","), ...rows.map((d) => COLUMNS.map((c) => csvField(c.value(d))).join(","))];
  return lines.join("\r\n") + "\r\n";
}

export function csvFileName(propertyName: string, from: string, to: string): string {
  const slug = propertyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "hotel";
  return `report-${slug}-${from}-to-${to}.csv`;
}
