import { invoiceOverdue } from "@/lib/staff/hotel-billing";

export type OpenInvoice = {
  id: string;
  number: string;
  tenant_id: string;
  tenant_name: string;
  period_start: string;
  period_end: string;
  amount_minor: number;
  currency: string;
  due_date: string | null;
  note: string | null;
};

/** Reads platform_open_invoices, dropping anything malformed. An error or null reads as an empty list. */
export function readOpenInvoices(data: unknown): OpenInvoice[] {
  if (!Array.isArray(data)) return [];
  const out: OpenInvoice[] = [];
  for (const r of data) {
    if (!r || typeof r !== "object") continue;
    const i = r as Record<string, unknown>;
    if (typeof i.id !== "string" || typeof i.number !== "string" || typeof i.tenant_id !== "string" || typeof i.tenant_name !== "string")
      continue;
    if (typeof i.amount_minor !== "number" || !Number.isInteger(i.amount_minor) || i.amount_minor <= 0 || typeof i.currency !== "string")
      continue;
    out.push({
      id: i.id,
      number: i.number,
      tenant_id: i.tenant_id,
      tenant_name: i.tenant_name,
      period_start: typeof i.period_start === "string" ? i.period_start : "",
      period_end: typeof i.period_end === "string" ? i.period_end : "",
      amount_minor: i.amount_minor,
      currency: i.currency,
      due_date: typeof i.due_date === "string" ? i.due_date : null,
      note: typeof i.note === "string" ? i.note : null,
    });
  }
  return out;
}

/** The late ones: open, with a due date before `today` (yyyy-mm-dd). */
export function overdueInvoices<T extends Pick<OpenInvoice, "due_date">>(list: T[], today: string): T[] {
  return list.filter((i) => invoiceOverdue({ status: "open", due_date: i.due_date }, today));
}

/** Whole days late (1 or more), or 0 when it is not late. */
export function daysLate(due: string | null, today: string): number {
  if (!due || due >= today) return 0;
  const d = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/** What is owed, per currency, across a list of open invoices. */
export function totalsByCurrency(list: Pick<OpenInvoice, "amount_minor" | "currency">[]): [string, number][] {
  const m = new Map<string, number>();
  for (const i of list) m.set(i.currency, (m.get(i.currency) ?? 0) + i.amount_minor);
  return [...m];
}
