/**
 * The steps of a booking for the guest's booking page: held, confirmed, checked in, checked out. It is worked out from
 * the booking's status alone, so it shows where the booking is and carries no times (the page has none to give).
 * A booking that is over without a stay (cancelled, expired, no-show) ends in one closing step instead.
 */
export type TimelineStep = { key: string; label: string; note: string; state: "done" | "current" | "later" };

const STAY_STEPS: { key: string; label: string; note: string; reached: string[] }[] = [
  {
    key: "held",
    label: "Reserved",
    note: "Your room is held while you pay",
    reached: ["pending", "confirmed", "checked_in", "checked_out"],
  },
  { key: "confirmed", label: "Confirmed", note: "Payment received", reached: ["confirmed", "checked_in", "checked_out"] },
  { key: "checked_in", label: "Checked in", note: "When you arrive", reached: ["checked_in", "checked_out"] },
  { key: "checked_out", label: "Checked out", note: "When your stay ends", reached: ["checked_out"] },
];

const ENDED: Record<string, { label: string; note: string }> = {
  cancelled: { label: "Cancelled", note: "This booking was cancelled" },
  expired: { label: "Expired", note: "The hold ran out before payment" },
  no_show: { label: "No-show", note: "The guest did not arrive" },
};

export function bookingTimeline(status: string): TimelineStep[] {
  const ended = ENDED[status];
  const steps: TimelineStep[] = STAY_STEPS.map((s) => ({ key: s.key, label: s.label, note: s.note, state: "later" }));
  if (ended) {
    // A cancelled booking was at least reserved; an expired or no-show one stays as the first step only.
    const first = steps[0];
    return [...(first ? [{ ...first, state: "done" as const }] : []), { key: status, ...ended, state: "current" as const }];
  }
  let lastReached = -1;
  STAY_STEPS.forEach((s, i) => {
    if (s.reached.includes(status)) lastReached = i;
  });
  return steps.map((s, i) => ({ ...s, state: i < lastReached ? "done" : i === lastReached ? "current" : "later" }));
}
