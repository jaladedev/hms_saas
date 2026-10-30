import type { BookingStatus } from "@/lib/guest-site/server";
import type { Mailer } from "@/lib/email/mailer";
import { renderEmail, type EmailKind } from "@/lib/email/templates";

export type ClaimedEmail = {
  id: string;
  kind: EmailKind;
  to_email: string;
  payload: Record<string, unknown>;
  attempt: number;
  site_host: string | null;
  booking: BookingStatus;
};

export type DrainDeps = {
  claim(limit: number): Promise<ClaimedEmail[]>;
  mark(id: string, ok: boolean, error?: string): Promise<void>;
  mailer: Mailer;
  /** Signed booking token for a reservation (the secret stays in the app). */
  makeToken(reservationId: string): string;
  linkScheme: "http" | "https";
  log?(level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void;
};
export type DrainResult = { claimed: number; sent: number; failed: number };

/** Sends claimed emails one by one. One bad email never blocks the others. */
export async function drainOutbox(deps: DrainDeps, limit: number): Promise<DrainResult> {
  const log = deps.log ?? (() => {});
  const claimed = await deps.claim(limit);
  let sent = 0;
  let failed = 0;
  for (const email of claimed) {
    let error: string | null = null;
    try {
      if (!email.site_host) throw new Error("no verified domain for this hotel");
      const link = `${deps.linkScheme}://${email.site_host}/booking/${deps.makeToken(email.booking.reservation_id)}`;
      const rendered = renderEmail({ kind: email.kind, booking: email.booking, link, payload: email.payload });
      await deps.mailer.send({ to: email.to_email, ...rendered, idempotencyKey: email.id });
    } catch (e) {
      error = e instanceof Error ? e.message : "send failed";
    }
    try {
      await deps.mark(email.id, error === null, error ?? undefined);
    } catch (e) {
      // The row stays 'sending' and is claimed again after 10 minutes; the idempotency key prevents a double send.
      log("error", "could not record email result", { emailId: email.id, message: e instanceof Error ? e.message : "unknown" });
    }
    if (error === null) sent++;
    else {
      failed++;
      log("warn", "email send failed", { emailId: email.id, kind: email.kind, attempt: email.attempt, error });
    }
  }
  return { claimed: claimed.length, sent, failed };
}
