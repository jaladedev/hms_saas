import type { Mailer } from "@/lib/email/mailer";
import { escapeHtml, type RenderedEmail } from "@/lib/email/templates";
import { formatDate, formatMoney } from "@/lib/guest-site/format";

export type ClaimedReminder = { id: string; to_email: string; payload: Record<string, unknown>; attempt: number };

export type ReminderPayload = {
  hotel: string;
  hotelPhone: string;
  hotelEmail: string;
  billTo: string;
  invoiceNumber: string;
  totalMinor: number;
  currency: string;
  dueDate: string;
  daysOverdue: number;
  reminderNo: number;
};

/** Reads the stored payload; a missing text is empty and a missing number is zero. */
export function reminderPayload(raw: Record<string, unknown>): ReminderPayload {
  const s = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  const n = (k: string) => (typeof raw[k] === "number" && Number.isFinite(raw[k]) ? Math.trunc(raw[k] as number) : 0);
  return {
    hotel: s("hotel") || "the hotel",
    hotelPhone: s("hotel_phone"),
    hotelEmail: s("hotel_email"),
    billTo: s("bill_to"),
    invoiceNumber: s("invoice_number"),
    totalMinor: n("total_minor"),
    currency: s("currency") || "NGN",
    dueDate: s("due_date"),
    daysOverdue: Math.max(0, n("days_overdue")),
    reminderNo: Math.max(1, n("reminder_no")),
  };
}

/** A plain payment reminder for an overdue group invoice. It states what is owed and where to ask; it never links to a payment page. */
export function renderGroupInvoiceReminder(raw: Record<string, unknown>): RenderedEmail {
  const p = reminderPayload(raw);
  if (!p.invoiceNumber || p.totalMinor <= 0) throw new Error("reminder has no invoice number or amount");
  const subject = `${p.reminderNo > 1 ? "Reminder: " : ""}Invoice ${p.invoiceNumber} from ${p.hotel} is overdue`;
  const contact = [p.hotelPhone && `call ${p.hotelPhone}`, p.hotelEmail && `write to ${p.hotelEmail}`].filter(Boolean).join(" or ");
  const lines = [
    p.billTo ? `Dear ${p.billTo},` : "Hello,",
    `Our records show that invoice ${p.invoiceNumber} for ${formatMoney(p.totalMinor, p.currency)} was due on ${p.dueDate ? formatDate(p.dueDate) : "the date shown on it"} and is still unpaid (${p.daysOverdue} ${p.daysOverdue === 1 ? "day" : "days"} overdue).`,
    "Please arrange payment as soon as you can. If you have already paid, or if you think this is wrong, please let us know and ignore the reminder.",
    contact ? `To reach us, ${contact}.` : "",
  ].filter(Boolean);
  const text = [...lines, "", `${p.hotel}`].join("\n");
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1b2430">` +
    `<h1 style="font-size:22px">Invoice ${escapeHtml(p.invoiceNumber)} is overdue</h1>` +
    lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("") +
    `<p style="color:#5b6573;font-size:13px">${escapeHtml(p.hotel)}</p></div>`;
  return { subject, text, html };
}

export type ReminderDeps = {
  claim(limit: number): Promise<ClaimedReminder[]>;
  mark(id: string, ok: boolean, error?: string): Promise<void>;
  mailer: Mailer;
  /** Builds the email from a stored payload. Defaults to the group invoice reminder; the platform invoice reminders pass their own. */
  render?(payload: Record<string, unknown>): RenderedEmail;
  log?(level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void;
};

/** Sends claimed reminders one by one; one failure never blocks the others. */
export async function drainReminders(deps: ReminderDeps, limit: number): Promise<{ claimed: number; sent: number; failed: number }> {
  const log = deps.log ?? (() => {});
  const claimed = await deps.claim(limit);
  let sent = 0;
  let failed = 0;
  for (const d of claimed) {
    let error: string | null = null;
    try {
      await deps.mailer.send({ to: d.to_email, ...(deps.render ?? renderGroupInvoiceReminder)(d.payload), idempotencyKey: d.id });
    } catch (e) {
      error = e instanceof Error ? e.message : "send failed";
    }
    try {
      await deps.mark(d.id, error === null, error ?? undefined);
    } catch (e) {
      log("error", "could not record invoice reminder result", { reminderId: d.id, message: e instanceof Error ? e.message : "unknown" });
    }
    if (error === null) sent++;
    else {
      failed++;
      log("warn", "invoice reminder email failed", { reminderId: d.id, attempt: d.attempt, error });
    }
  }
  return { claimed: claimed.length, sent, failed };
}
