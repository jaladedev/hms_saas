/**
 * The arrivals and departures calendar: for each day of a window, who is due to arrive, who is due to leave, and how many
 * bookings have a night that day. Pure functions, so they can be tested.
 *
 * Which bookings count: pending (a hold), confirmed, checked in and checked out; cancelled ones never. A pending hold is
 * listed so the desk sees it coming, but does not count as staying, because it is not a guest yet and can expire. The
 * departure day is not a night: a stay arriving on the 5th and leaving on the 8th is staying on the 5th, 6th and 7th.
 */
import { addDays } from "./transfer";
import type { CalendarWindow } from "./room-calendar";

export type AgendaRow = {
  id: string; property_id: string; booking_reference: string; primary_guest_id: string;
  reservation_status: string; payment_status: string; arrival_date: string; departure_date: string;
};

/** Statuses read from the database for this view. */
export const AGENDA_STATUSES = ["pending", "confirmed", "checked_in", "checked_out"] as const;
const STAYING = new Set(["confirmed", "checked_in", "checked_out"]);

export type AgendaDay = { date: string; arrivals: AgendaRow[]; departures: AgendaRow[]; staying: number };

const byRef = (a: AgendaRow, b: AgendaRow) => a.booking_reference.localeCompare(b.booking_reference, "en", { numeric: true });

/** One entry per day of the window, in date order, with lists sorted by booking number. Rows outside the window are ignored. */
export function buildAgenda(rows: AgendaRow[], w: CalendarWindow): AgendaDay[] {
  const live = rows.filter((r) => (AGENDA_STATUSES as readonly string[]).includes(r.reservation_status));
  return Array.from({ length: w.days }, (_, i) => {
    const date = addDays(w.start, i);
    return {
      date,
      arrivals: live.filter((r) => r.arrival_date === date).sort(byRef),
      departures: live.filter((r) => r.departure_date === date).sort(byRef),
      staying: live.filter((r) => STAYING.has(r.reservation_status) && r.arrival_date <= date && r.departure_date > date).length,
    };
  });
}

/** Days with something to do, in order; the page lists these in full and shows the rest only in the summary. */
export const busyDays = (days: AgendaDay[]): AgendaDay[] => days.filter((d) => d.arrivals.length > 0 || d.departures.length > 0);

export const agendaTotals = (days: AgendaDay[]): { arrivals: number; departures: number } => ({
  arrivals: days.reduce((n, d) => n + d.arrivals.length, 0),
  departures: days.reduce((n, d) => n + d.departures.length, 0),
});

/** The query returns at most this many bookings; more than that and the page says the list is cut. */
export const AGENDA_LIMIT = 1000;
