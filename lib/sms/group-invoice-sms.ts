import { formatMoney } from "@/lib/guest-site/format";
import { reminderPayload } from "@/lib/email/group-invoice-reminder";
import { SmsSendError, type SmsChannel, type SmsProvider } from "@/lib/sms/provider";
import { cut, gsmSafe, shortDate, smsParts } from "@/lib/sms/templates";

export type ClaimedInvoiceSms = {
  id: string;
  to_phone: string;
  channel: SmsChannel;
  payload: Record<string, unknown>;
  attempt: number;
};

/** One short overdue notice (migration 173). It states what is owed and where to ask; it never carries a link. */
export function renderInvoiceReminderSms(raw: Record<string, unknown>): string {
  const p = reminderPayload(raw);
  if (!p.invoiceNumber || p.totalMinor <= 0) throw new SmsSendError("reminder has no invoice number or amount", true);
  const hotel = cut(gsmSafe(p.hotel) || "Your hotel", 28);
  const due = p.dueDate ? ` due ${shortDate(p.dueDate)}` : "";
  const phone = p.hotelPhone ? gsmSafe(p.hotelPhone) : "";
  const text = `${hotel}: ${p.reminderNo > 1 ? "reminder, " : ""}invoice ${gsmSafe(p.invoiceNumber)} for ${gsmSafe(formatMoney(p.totalMinor, p.currency))}${due} is unpaid.${phone ? ` Please pay or call ${phone}.` : " Please pay or contact us."}`;
  return text.replace(/\s+/g, " ").trim();
}

export type InvoiceSmsDeps = {
  claim(limit: number): Promise<ClaimedInvoiceSms[]>;
  mark(id: string, result: { ok: boolean; error?: string; permanent?: boolean }): Promise<void>;
  provider: SmsProvider;
  log?(level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void;
};

/** Sends claimed invoice texts one by one; one failure never blocks the others. */
export async function drainInvoiceSms(deps: InvoiceSmsDeps, limit: number): Promise<{ claimed: number; sent: number; failed: number }> {
  const log = deps.log ?? (() => {});
  const claimed = await deps.claim(limit);
  let sent = 0;
  let failed = 0;
  for (const row of claimed) {
    let error: string | null = null;
    let permanent = false;
    try {
      const text = renderInvoiceReminderSms(row.payload);
      if (smsParts(text) > 3) throw new SmsSendError("text is too long to send", true);
      await deps.provider.send({ to: row.to_phone, text, channel: row.channel, idempotencyKey: row.id });
    } catch (e) {
      error = e instanceof Error ? e.message : "send failed";
      permanent = e instanceof SmsSendError && e.permanent;
    }
    try {
      await deps.mark(row.id, { ok: error === null, error: error ?? undefined, permanent });
    } catch (e) {
      log("error", "could not record invoice text result", { smsId: row.id, message: e instanceof Error ? e.message : "unknown" });
    }
    if (error === null) sent++;
    else {
      failed++;
      log("warn", "invoice text failed", { smsId: row.id, attempt: row.attempt, permanent, error });
    }
  }
  return { claimed: claimed.length, sent, failed };
}
