/** The occupancy report as CSV. Money in major units (naira) with two decimals, occupancy with two decimals of a percent. Pure, so it can be tested. */
import { adrMinor, occupancyBp, revparMinor, type OccupancyDay, type OccupancyReport } from "./occupancy";
import { csvField, major } from "./reports-csv";

const pct = (bp: number | null) => (bp === null ? "" : `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, "0")}`);
const money = (n: number | null) => (n === null ? "" : major(n));

const COLUMNS: { header: string; value: (d: OccupancyDay) => string | number }[] = [
  { header: "Date", value: (d) => d.date },
  { header: "Rooms in service", value: (d) => d.rooms_total },
  { header: "Blocked", value: (d) => d.rooms_blocked },
  { header: "Available", value: (d) => d.rooms_available },
  { header: "Sold", value: (d) => d.rooms_sold },
  { header: "Occupancy %", value: (d) => pct(occupancyBp(d)) },
  { header: "Room revenue", value: (d) => major(d.room_revenue_minor) },
  { header: "ADR", value: (d) => money(adrMinor(d)) },
  { header: "RevPAR", value: (d) => money(revparMinor(d)) },
  { header: "Arrivals", value: (d) => d.arrivals },
  { header: "Departures", value: (d) => d.departures },
  { header: "No-shows", value: (d) => d.no_shows },
];

export function occupancyCsv(report: OccupancyReport): string {
  const rows = [...report.days, { ...report.totals, date: "Total" }];
  const lines = [COLUMNS.map((c) => csvField(c.header)).join(","), ...rows.map((d) => COLUMNS.map((c) => csvField(c.value(d))).join(","))];
  return lines.join("\r\n") + "\r\n";
}

export const occupancyFileName = (propertyName: string, from: string, to: string) =>
  `occupancy-${(propertyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "hotel")}-${from}-to-${to}.csv`;
