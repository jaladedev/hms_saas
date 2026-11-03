/** Figures and wording for the occupancy report page (migration 040). Pure, so it can be tested. */
export type OccupancyDay = {
  date: string; rooms_total: number; rooms_blocked: number; rooms_available: number; rooms_sold: number;
  room_revenue_minor: number; arrivals: number; departures: number; no_shows: number;
};
export type OccupancyReport = {
  property_id: string; currency: string; timezone: string; from: string; to: string;
  days: OccupancyDay[]; totals: Omit<OccupancyDay, "date">;
};
type Counts = Pick<OccupancyDay, "rooms_available" | "rooms_sold" | "room_revenue_minor">;

/** Integer division rounded half up. Null when there is nothing to divide by. */
function ratio(num: number, den: number, scale: number): number | null {
  if (den <= 0) return null;
  return Math.floor((num * scale * 2 + den) / (den * 2));
}

/** Sold nights as a share of available nights, in hundredths of a percent (7340 is 73.40 percent). Null when nothing was available. */
export const occupancyBp = (d: Counts): number | null => ratio(d.rooms_sold, d.rooms_available, 10000);
/** Average daily rate: room revenue per sold night, before tax, in minor units. Null when nothing was sold. */
export const adrMinor = (d: Counts): number | null => ratio(d.room_revenue_minor, d.rooms_sold, 1);
/** Revenue per available room: room revenue per available night, before tax, in minor units. Null when nothing was available. */
export const revparMinor = (d: Counts): number | null => ratio(d.room_revenue_minor, d.rooms_available, 1);

/** 7340 becomes "73.4%", 10000 "100%", null "–". */
export function formatBp(bp: number | null): string {
  if (bp === null) return "–";
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  if (frac === 0) return `${whole}%`;
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}%`;
}

/** A day with nothing happening in it, so the table can grey it out. */
export const isQuietDay = (d: OccupancyDay): boolean => d.rooms_sold === 0 && d.arrivals === 0 && d.departures === 0 && d.no_shows === 0;
