export type BillingInvoice = {
  id: string;
  number: string;
  period_start: string;
  period_end: string;
  amount_minor: number;
  currency: string;
  status: string;
  due_date: string | null;
  note: string | null;
  paid_at: string | null;
  payment_ref: string | null;
};

const DAY = 86_400_000;

/** True for an open invoice whose due date is before `today` (both yyyy-mm-dd). Paid invoices and ones with no due date are never overdue. */
export function invoiceOverdue(inv: Pick<BillingInvoice, "status" | "due_date">, today: string): boolean {
  return inv.status === "open" && !!inv.due_date && inv.due_date < today;
}

/** What the hotel still owes the platform: the sum of open invoices, per currency. Anything that is not a whole positive amount is skipped. */
export function amountOwing(invoices: Pick<BillingInvoice, "status" | "amount_minor" | "currency">[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const i of invoices) {
    if (i.status !== "open" || !Number.isInteger(i.amount_minor) || i.amount_minor <= 0) continue;
    out.set(i.currency, (out.get(i.currency) ?? 0) + i.amount_minor);
  }
  return out;
}

/** "Due in 5 days", "Due today", "3 days overdue" for an open invoice with a due date; null otherwise. */
export function dueLabel(inv: Pick<BillingInvoice, "status" | "due_date">, today: string): string | null {
  if (inv.status !== "open" || !inv.due_date) return null;
  const days = Math.round((Date.parse(`${inv.due_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
  if (!Number.isFinite(days)) return null;
  if (days === 0) return "Due today";
  if (days > 0) return `Due in ${days} day${days === 1 ? "" : "s"}`;
  return `${-days} day${days === -1 ? "" : "s"} overdue`;
}
