/** The channel and guest reports as CSV. Money in major units (naira), shares with two decimals of a percent. Pure, so it can be tested. */
import { countryLabel, lostBp, shareBp, sourceLabel, type ChannelReport, type GuestReport } from "./channels";
import { csvField, major } from "./reports-csv";

const pct = (bp: number | null) => (bp === null ? "" : `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, "0")}`);
const lines = (header: string[], rows: (string | number)[][]) =>
  [header, ...rows].map((r) => r.map((v) => csvField(v)).join(",")).join("\r\n") + "\r\n";

export function channelsCsv(report: ChannelReport): string {
  const all = [...report.rows.map((r) => ({ ...r, label: sourceLabel(r.source) })), { ...report.totals, label: "Total" }];
  return lines(
    ["Source", "Bookings", "Room nights", "Room revenue", "Share of revenue %", "Cancelled", "No-shows", "Cancelled or no-show %"],
    all.map((r) => [
      r.label,
      r.bookings,
      r.room_nights,
      major(r.room_revenue_minor),
      pct(shareBp(r.room_revenue_minor, report.totals.room_revenue_minor)),
      r.cancelled,
      r.no_shows,
      pct(lostBp(r)),
    ]),
  );
}

export function guestsCsv(report: GuestReport): string {
  const out: string[] = [];
  out.push(lines(["Guests", "New", "Returning"], [[report.guests_total, report.guests_new, report.guests_returning]]));
  out.push(
    lines(
      ["Country", "Guests", "Room nights"],
      report.countries.map((c) => [countryLabel(c.country), c.guests, c.room_nights]),
    ),
  );
  if (!report.names_hidden) {
    out.push(
      lines(
        ["Top guest", "Stays", "Room nights", "Room revenue"],
        report.top_guests.map((g) => [g.name, g.stays, g.room_nights, major(g.room_revenue_minor)]),
      ),
    );
  }
  return out.join("\r\n");
}

export function channelsFileName(kind: "channels" | "guests" | "noshows", propertyName: string, from: string, to: string): string {
  const slug =
    propertyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "hotel";
  return `${kind}-${slug}-${from}-to-${to}.csv`;
}
