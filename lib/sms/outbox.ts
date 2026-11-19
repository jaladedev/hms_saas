import type { BookingStatus } from "@/lib/guest-site/server";
import { SmsSendError, type SmsChannel, type SmsProvider } from "@/lib/sms/provider";
import { renderSms, smsParts, type SmsKind } from "@/lib/sms/templates";

export type ClaimedSms = {
  id: string;
  kind: SmsKind;
  channel: SmsChannel;
  to_phone: string;
  payload: Record<string, unknown>;
  attempt: number;
  hotel_phone: string | null;
  site_host: string | null;
  booking: BookingStatus;
};

export type SmsDrainDeps = {
  claim(limit: number): Promise<ClaimedSms[]>;
  mark(id: string, result: { ok: boolean; error?: string; providerId?: string | null; permanent?: boolean }): Promise<void>;
  provider: SmsProvider;
  linkScheme: "http" | "https";
  log?(level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void;
};
export type SmsDrainResult = { claimed: number; sent: number; failed: number };

/** Sends claimed texts one by one. One bad text never blocks the others. */
export async function drainSms(deps: SmsDrainDeps, limit: number): Promise<SmsDrainResult> {
  const log = deps.log ?? (() => {});
  const claimed = await deps.claim(limit);
  let sent = 0;
  let failed = 0;
  for (const row of claimed) {
    let error: string | null = null;
    let permanent = false;
    let providerId: string | null = null;
    try {
      const text = renderSms({
        kind: row.kind,
        booking: row.booking,
        hotelPhone: row.hotel_phone,
        siteHost: row.site_host,
        scheme: deps.linkScheme,
      });
      if (smsParts(text) > 3) throw new SmsSendError("text is too long to send", true);
      const result = await deps.provider.send({ to: row.to_phone, text, channel: row.channel, idempotencyKey: row.id });
      providerId = result.providerMessageId;
    } catch (e) {
      error = e instanceof Error ? e.message : "send failed";
      permanent = e instanceof SmsSendError && e.permanent;
    }
    try {
      await deps.mark(row.id, { ok: error === null, error: error ?? undefined, providerId, permanent });
    } catch (e) {
      // The row stays 'sending' and is claimed again after 10 minutes.
      log("error", "could not record text result", { smsId: row.id, message: e instanceof Error ? e.message : "unknown" });
    }
    if (error === null) sent++;
    else {
      failed++;
      log("warn", "text send failed", { smsId: row.id, kind: row.kind, attempt: row.attempt, permanent, error });
    }
  }
  return { claimed: claimed.length, sent, failed };
}
