/** What `early_checkout_quote` (migration 060) says check-out will do for a guest leaving before their booked departure. */
export type EarlyQuote = {
  early: boolean;
  mode: "none" | "credit" | "one_night";
  nights_credited: number;
  credit_minor: number;
  new_total_minor: number | null;
  surplus_minor: number;
};

export function parseEarlyQuote(data: unknown): EarlyQuote | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const mode = d.mode === "credit" || d.mode === "one_night" ? d.mode : "none";
  return {
    early: d.early === true, mode, nights_credited: num(d.nights_credited), credit_minor: num(d.credit_minor),
    new_total_minor: typeof d.new_total_minor === "number" ? d.new_total_minor : null, surplus_minor: num(d.surplus_minor),
  };
}

/**
 * The sentence shown above the Check out button, or null when check-out will change no money. `date` is the booked
 * departure, already formatted. Money is formatted by the caller.
 */
export function earlyCheckoutNote(q: EarlyQuote, date: string, money: (minor: number) => string): string | null {
  if (!q.early) return null;
  if (q.mode === "none" || q.nights_credited === 0 || q.credit_minor === 0) {
    return `Leaving before ${date}: the room is freed for the unused nights. The price does not change.`;
  }
  const nights = q.nights_credited === 1 ? "1 night" : `${q.nights_credited} nights`;
  const total = q.new_total_minor === null ? "" : ` The booking total becomes ${money(q.new_total_minor)}.`;
  const refund = q.surplus_minor > 0 ? ` The guest has paid ${money(q.surplus_minor)} more than that, which will be flagged for a refund.` : "";
  return `Leaving before ${date}: ${nights} not stayed will be taken off, ${money(q.credit_minor)} in all.${total}${refund}`;
}
