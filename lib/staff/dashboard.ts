import type { OccupancyDay, OccupancyReport } from "./occupancy";
import { occupancyBp } from "./occupancy";

/** One property's occupancy for today and the next six days, for the dashboard (the prototype's "Occupancy 7 days"). */
export type WeekStrip = {
  propertyId: string;
  today: { sold: number; available: number; free: number; bp: number | null };
  days: { date: string; bp: number | null; sold: number; available: number }[];
};

const isDay = (d: unknown): d is OccupancyDay => {
  const o = d as Partial<OccupancyDay> | null;
  return !!o && typeof o.date === "string" && typeof o.rooms_sold === "number" && typeof o.rooms_available === "number";
};

/** Reads occupancy_report's answer. Anything not shaped like a report, or with no days, gives null so the page shows nothing rather than zeros. */
export function weekStrip(data: unknown): WeekStrip | null {
  const r = data as Partial<OccupancyReport> | null;
  if (!r || typeof r.property_id !== "string" || !Array.isArray(r.days)) return null;
  const days = r.days.filter(isDay);
  const first = days[0];
  if (!first) return null;
  return {
    propertyId: r.property_id,
    today: {
      sold: first.rooms_sold,
      available: first.rooms_available,
      free: Math.max(first.rooms_available - first.rooms_sold, 0),
      bp: occupancyBp(first),
    },
    days: days.slice(0, 7).map((d) => ({ date: d.date, bp: occupancyBp(d), sold: d.rooms_sold, available: d.rooms_available })),
  };
}

/** Height of a bar for a day, as a whole percent from 4 (so an empty day is still drawn) to 100. */
export function barPercent(bp: number | null): number {
  if (bp === null) return 4;
  return Math.min(100, Math.max(4, Math.round(bp / 100)));
}

export type RecentReservation = {
  id: string;
  booking_reference: string;
  reservation_status: string;
  payment_status: string;
  total_minor: number;
  currency: string;
  arrival_date: string;
  primary_guest_id: string | null;
};

/** Keeps well-formed rows and drops the rest. */
export function recentReservations(data: unknown): RecentReservation[] {
  if (!Array.isArray(data)) return [];
  return data.filter((r): r is RecentReservation => {
    const o = r as Partial<RecentReservation> | null;
    return (
      !!o &&
      typeof o.id === "string" &&
      typeof o.booking_reference === "string" &&
      typeof o.reservation_status === "string" &&
      typeof o.payment_status === "string" &&
      typeof o.total_minor === "number" &&
      typeof o.currency === "string" &&
      typeof o.arrival_date === "string"
    );
  });
}
