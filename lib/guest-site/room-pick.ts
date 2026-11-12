export type PriceNight = { date: string; rate_minor: number | null };
export type Pick = { arrival: string; departure: string; awaitingEnd: boolean };

/** The date `n` days after an ISO date ("2026-11-12"), with no timezone shift. */
export function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + n)).toISOString().slice(0, 10);
}

/** Whether `night` is one of the nights of a stay: from arrival up to, not including, departure. */
export function inStay(night: string, arrival: string, departure: string): boolean {
  return Boolean(arrival && departure) && night >= arrival && night < departure;
}

/**
 * What a click on a night of the price calendar does. The first click picks that night alone (arrival that day, departure
 * the next). A later click on a later night makes it the last night, unless a night in between has no rate, which starts
 * over from the night clicked. A night with no rate cannot be picked.
 */
export function pickNight(current: Pick, nights: PriceNight[], clicked: string): Pick {
  const day = nights.find((n) => n.date === clicked);
  if (!day || day.rate_minor === null) return current;
  const restart = { arrival: clicked, departure: addDaysIso(clicked, 1), awaitingEnd: true };
  if (!current.awaitingEnd || !current.arrival || clicked <= current.arrival) return restart;
  const gap = nights.some((n) => n.date >= current.arrival && n.date <= clicked && n.rate_minor === null);
  return gap ? restart : { arrival: current.arrival, departure: addDaysIso(clicked, 1), awaitingEnd: false };
}

/**
 * What the stay's nights add up to before tax, when every night is on the calendar and has a rate; null otherwise (a longer
 * stay or one past the calendar is priced when the guest checks availability, not guessed here).
 */
export function stayEstimate(nights: PriceNight[], arrival: string, departure: string): { nights: number; totalMinor: number } | null {
  if (!arrival || !departure || departure <= arrival) return null;
  const count = Math.round((Date.parse(`${departure}T00:00:00Z`) - Date.parse(`${arrival}T00:00:00Z`)) / 86400000);
  const picked = nights.filter((n) => inStay(n.date, arrival, departure));
  if (picked.length !== count || picked.some((n) => n.rate_minor === null)) return null;
  return { nights: count, totalMinor: picked.reduce((s, n) => s + (n.rate_minor as number), 0) };
}
