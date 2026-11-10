/** What `early_checkin_quote` (migration 061) says about checking a guest in before their booked arrival date. */
export type EarlyCheckinQuote = {
  allowed: boolean;
  why_not: "status" | "not_early" | "off" | "too_early" | "payment_started" | "no_rate" | null;
  days_early: number;
  max_days: number;
  nights_added: number;
  added_minor: number;
  new_total_minor: number | null;
};

const WHY = ["status", "not_early", "off", "too_early", "payment_started", "no_rate"] as const;

export function parseEarlyCheckinQuote(data: unknown): EarlyCheckinQuote | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const why = WHY.find((w) => w === d.why_not) ?? null;
  const allowed = d.allowed === true && why === null;
  return {
    allowed,
    why_not: allowed ? null : (why ?? "status"),
    days_early: num(d.days_early),
    max_days: num(d.max_days),
    nights_added: num(d.nights_added),
    added_minor: num(d.added_minor),
    new_total_minor: typeof d.new_total_minor === "number" ? d.new_total_minor : null,
  };
}

/** The sentence above the early check-in form. */
export function earlyCheckinNote(q: EarlyCheckinQuote, money: (minor: number) => string): string {
  const nights = q.nights_added === 1 ? "1 night" : `${q.nights_added} nights`;
  const total = q.new_total_minor === null ? "" : ` The booking total becomes ${money(q.new_total_minor)}.`;
  return `The booking starts ${q.days_early === 1 ? "tomorrow" : `in ${q.days_early} days`}. Checking in now adds ${nights} to it, ${money(q.added_minor)} in all.${total}`;
}

/** Why early check-in is not offered, for the reasons worth telling staff. Null means say nothing (it is simply not early, or not switched on). */
export function earlyCheckinWhyNot(q: EarlyCheckinQuote): string | null {
  switch (q.why_not) {
    case "too_early":
      return `The hotel allows early check-in up to ${q.max_days === 1 ? "1 day" : `${q.max_days} days`} before arrival. This booking is ${q.days_early} days away.`;
    case "payment_started":
      return "Early check-in is not possible while the guest has a payment in progress.";
    case "no_rate":
      return "Early check-in is not possible: one of the earlier nights has no price set.";
    default:
      return null;
  }
}
