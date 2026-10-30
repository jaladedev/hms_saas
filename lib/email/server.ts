import "server-only";
import { createBookingToken } from "@/lib/booking-token";
import { serverEnv } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/service";
import { createMailer } from "@/lib/email/mailer";
import { drainOutbox, type ClaimedEmail, type DrainResult } from "@/lib/email/outbox";

/** Emailed booking links work for a week; the guest can always ask for a fresh one. */
export const EMAIL_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Claims due emails and sends them. Returns {skipped} when email is not configured, leaving the outbox
 * untouched so mail waits instead of being lost. Safe to call from several places at once: claims are exclusive.
 */
export async function drainNow(limit: number): Promise<DrainResult | { skipped: string }> {
  const mailer = createMailer();
  if (!mailer) return { skipped: "email not configured" };
  const secret = serverEnv().BOOKING_TOKEN_SECRET;
  const db = createServiceClient();
  return drainOutbox(
    {
      async claim(n) {
        const { data, error } = await db.rpc("claim_emails", { p_limit: n });
        if (error) throw new Error(error.message);
        return (data ?? []) as ClaimedEmail[];
      },
      async mark(id, ok, errorText) {
        const { error } = await db.rpc("mark_email_result", { p_id: id, p_ok: ok, p_error: errorText ?? null });
        if (error) throw new Error(error.message);
      },
      mailer,
      makeToken: (reservationId) => createBookingToken(reservationId, secret, EMAIL_LINK_TTL_SECONDS),
      linkScheme: process.env.EMAIL_LINK_SCHEME === "http" ? "http" : "https",
      log: (level, message, context) => console[level === "info" ? "log" : level](`[email] ${message}`, context ?? {}),
    },
    limit,
  );
}
