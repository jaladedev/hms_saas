/** The pending-hold rules the booking page shows. Mirrors migration 034 (pending_required_minor) so the screen and the database agree. */

type Snapshot = { online_payment?: { mode?: string; value?: number | string } | null } | null | undefined;

/** What must be paid before a pending booking is confirmed: the policy's deposit percent of the total, otherwise all of it. */
export function requiredToConfirm(totalMinor: number, snapshot: Snapshot): number {
  const op = snapshot?.online_payment;
  if (op?.mode !== "deposit_percent") return totalMinor;
  const pct = Number(op.value ?? 100);
  if (!Number.isFinite(pct) || pct <= 0) return totalMinor;
  // whole kobo arithmetic, rounded up, like the database
  return Math.min(totalMinor, Math.ceil((totalMinor * pct) / 100));
}

export type HoldView =
  | { kind: "none" }
  | { kind: "live"; until: string; stillNeededMinor: number }
  | { kind: "lapsed"; stillNeededMinor: number };

/** The hold banner for a booking: only a pending booking has one. `holdUntil` is the earliest hold expiry among its active hold claims, or null when it has none. */
export function holdView(
  status: string,
  holdUntil: string | null,
  now: Date,
  totalMinor: number,
  snapshot: Snapshot,
  heldMinor: number | null,
): HoldView {
  if (status !== "pending") return { kind: "none" };
  const need = Math.max(requiredToConfirm(totalMinor, snapshot) - (heldMinor ?? 0), 0);
  const until = holdUntil ? new Date(holdUntil) : null;
  if (!until || Number.isNaN(until.getTime()) || until <= now) return { kind: "lapsed", stillNeededMinor: need };
  return { kind: "live", until: holdUntil as string, stillNeededMinor: need };
}
