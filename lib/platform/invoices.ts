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
  reminder: PlatformReminderInfo | null;
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
      reminder: readReminderInfo(i.reminder_info),
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

export type PlatformReminderOutcome = "queued" | "sending" | "sent" | "closed" | "failed";
export const PLATFORM_REMINDER_LABEL: Record<PlatformReminderOutcome, string> = {
  queued: "waiting to be sent",
  sending: "being sent",
  sent: "sent",
  closed: "not sent (paid, voided or switched off first)",
  failed: "could not be delivered",
};
export type PlatformReminderInfo = {
  remindersOn: boolean;
  nextReminderDate: string | null;
  reminders: { no: number; outcome: PlatformReminderOutcome; sentAt: string | null }[];
};

/** The reminder status of one platform invoice (migration 186). Null when the data does not look right. */
export function readReminderInfo(data: unknown): PlatformReminderInfo | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const reminders: PlatformReminderInfo["reminders"] = [];
  if (Array.isArray(d.reminders)) {
    for (const raw of d.reminders) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const outcome = (["queued", "sending", "sent", "closed", "failed"] as const).find((o) => o === r.outcome);
      if (!outcome || typeof r.no !== "number") continue;
      reminders.push({ no: r.no, outcome, sentAt: typeof r.sent_at === "string" ? r.sent_at : null });
    }
  }
  return {
    remindersOn: d.reminders_on === true,
    nextReminderDate: typeof d.next_reminder_date === "string" ? d.next_reminder_date : null,
    reminders,
  };
}

/** One line: "1 sent, next 21 Nov", "none yet, next 21 Nov", or why there is none. The caller formats a date. */
export function platformReminderSummary(info: PlatformReminderInfo | null, date: (iso: string) => string): string {
  if (!info) return "";
  if (!info.remindersOn) return "Off for this group";
  const count = (o: PlatformReminderOutcome[]) => info.reminders.filter((r) => o.includes(r.outcome)).length;
  const parts: string[] = [];
  if (count(["sent"]) > 0) parts.push(`${count(["sent"])} sent`);
  if (count(["queued", "sending"]) > 0) parts.push(`${count(["queued", "sending"])} on the way`);
  if (count(["failed"]) > 0) parts.push(`${count(["failed"])} not delivered`);
  if (count(["closed"]) > 0) parts.push(`${count(["closed"])} closed out`);
  if (parts.length === 0) parts.push("none yet");
  if (info.nextReminderDate) parts.push(`next ${date(info.nextReminderDate)}`);
  return parts.join(", ");
}

export type BillingReminders = {
  billingEmail: string | null;
  remind: boolean;
  invoices: { invoiceId: string; number: string; dueDate: string | null; info: PlatformReminderInfo | null }[];
};

/** The billing contact of one hotel group and the reminder status of its invoices (migration 186). Null when the data does not look right. */
export function readBillingReminders(data: unknown): BillingReminders | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const invoices: BillingReminders["invoices"] = [];
  if (Array.isArray(d.invoices)) {
    for (const raw of d.invoices) {
      if (!raw || typeof raw !== "object") continue;
      const i = raw as Record<string, unknown>;
      if (typeof i.invoice_id !== "string" || typeof i.number !== "string") continue;
      invoices.push({
        invoiceId: i.invoice_id,
        number: i.number,
        dueDate: typeof i.due_date === "string" ? i.due_date : null,
        info: readReminderInfo(i.info),
      });
    }
  }
  return {
    billingEmail: typeof d.billing_email === "string" ? d.billing_email : null,
    remind: d.remind_overdue_invoices === true,
    invoices,
  };
}
