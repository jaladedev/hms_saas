import { escapeHtml, type RenderedEmail } from "@/lib/email/templates";
import { formatDate, formatMoney } from "@/lib/guest-site/format";

export type PlatformReminderPayload = {
  hotelGroup: string;
  invoiceNumber: string;
  amountMinor: number;
  currency: string;
  dueDate: string;
  periodStart: string;
  periodEnd: string;
  daysOverdue: number;
  reminderNo: number;
};

export type PlatformReminderOptions = {
  /** An address or phone to reach the platform (PLATFORM_SUPPORT_EMAIL). Left out of the email when empty. */
  supportEmail?: string;
  /** True when hotels can pay platform invoices online (the platform Paystack key is set): the email then says where. */
  canPayOnline?: boolean;
};

/** Reads the stored payload; a missing text is empty and a missing number is zero. */
export function platformReminderPayload(raw: Record<string, unknown>): PlatformReminderPayload {
  const s = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  const n = (k: string) => (typeof raw[k] === "number" && Number.isFinite(raw[k]) ? Math.trunc(raw[k] as number) : 0);
  return {
    hotelGroup: s("tenant_name"),
    invoiceNumber: s("invoice_number"),
    amountMinor: n("amount_minor"),
    currency: s("currency") || "NGN",
    dueDate: s("due_date"),
    periodStart: s("period_start"),
    periodEnd: s("period_end"),
    daysOverdue: Math.max(0, n("days_overdue")),
    reminderNo: Math.max(1, n("reminder_no")),
  };
}

/**
 * A plain payment reminder for an overdue platform invoice (migration 186). It states what is owed and where to ask. It never links anywhere and
 * charges nothing; when online payment is on it only says where in the hotel's own dashboard the invoice can be paid.
 */
export function renderPlatformInvoiceReminder(raw: Record<string, unknown>, options: PlatformReminderOptions = {}): RenderedEmail {
  const p = platformReminderPayload(raw);
  if (!p.invoiceNumber || p.amountMinor <= 0) throw new Error("reminder has no invoice number or amount");
  const subject = `${p.reminderNo > 1 ? "Reminder: " : ""}Invoice ${p.invoiceNumber} is overdue`;
  const period = p.periodStart && p.periodEnd ? ` for ${formatDate(p.periodStart)} to ${formatDate(p.periodEnd)}` : "";
  const support = (options.supportEmail ?? "").trim();
  const lines = [
    p.hotelGroup ? `Dear ${p.hotelGroup},` : "Hello,",
    `Our records show that invoice ${p.invoiceNumber}${period}, for ${formatMoney(p.amountMinor, p.currency)}, was due on ${p.dueDate ? formatDate(p.dueDate) : "the date shown on it"} and is still unpaid (${p.daysOverdue} ${p.daysOverdue === 1 ? "day" : "days"} overdue).`,
    "Please arrange payment as soon as you can. If you have already paid, or if you think this is wrong, please let us know and ignore the reminder.",
    options.canPayOnline ? "You can also pay it by card under Settings, then Billing, in your hotel dashboard." : "",
    support ? `To reach us, write to ${support}.` : "",
  ].filter(Boolean);
  const text = lines.join("\n");
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1b2430">` +
    `<h1 style="font-size:22px">Invoice ${escapeHtml(p.invoiceNumber)} is overdue</h1>` +
    lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("") +
    `</div>`;
  return { subject, text, html };
}
