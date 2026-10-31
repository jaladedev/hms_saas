/** Buckets reservations into the front desk board's lists. Pure functions, so they can be tested. */

export type DeskRow = {
  id: string;
  property_id: string;
  booking_reference: string;
  reservation_status: string;
  payment_status: string;
  arrival_date: string;
  departure_date: string;
  attention_reason: string | null;
};

export type DeskGroups = {
  /** Due to arrive today and not fully checked in. */
  arrivals: DeskRow[];
  /** In house and due to leave today. */
  departures: DeskRow[];
  /** In house, staying past today. */
  inHouse: DeskRow[];
  /** In house with a departure date before today: someone should check them out or extend the stay. */
  overdue: DeskRow[];
  /** Confirmed with an arrival date before today and nobody checked in: late or no-show. */
  lateArrivals: DeskRow[];
};

/**
 * Every row lands in at most one group, judged against today's date in its own property's timezone.
 * `todayByProperty` maps property id to YYYY-MM-DD; a property missing from it is skipped rather than guessed at.
 */
export function bucketFrontDesk(rows: DeskRow[], todayByProperty: Map<string, string>): DeskGroups {
  const g: DeskGroups = { arrivals: [], departures: [], inHouse: [], overdue: [], lateArrivals: [] };
  for (const r of rows) {
    const today = todayByProperty.get(r.property_id);
    if (!today) continue;
    const st = r.reservation_status;
    if (st === "checked_in") {
      if (r.departure_date < today) g.overdue.push(r);
      else if (r.departure_date === today) g.departures.push(r);
      else g.inHouse.push(r);
      // A multi-room booking can be in house while a second room has yet to arrive.
      if (r.arrival_date === today) g.arrivals.push(r);
    } else if (st === "confirmed") {
      if (r.arrival_date === today) g.arrivals.push(r);
      else if (r.arrival_date < today && r.departure_date > today) g.lateArrivals.push(r);
    }
  }
  const byRef = (a: DeskRow, b: DeskRow) => a.booking_reference.localeCompare(b.booking_reference);
  for (const list of Object.values(g)) list.sort(byRef);
  return g;
}

/** Everything the board has to show for one reservation, or null for nothing worth a flag. */
export function deskFlag(r: DeskRow): string | null {
  if (r.attention_reason) return "Needs attention";
  if (r.payment_status === "unpaid") return "Unpaid";
  if (r.payment_status === "partially_paid") return "Part paid";
  return null;
}
