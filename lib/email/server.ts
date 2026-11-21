import "server-only";
import { createBookingToken } from "@/lib/booking-token";
import { serverEnv } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/service";
import { createMailer } from "@/lib/email/mailer";
import { drainDigests, type ClaimedDigest } from "@/lib/email/digest";
import { drainNotices, type ClaimedNotice } from "@/lib/email/waitlist-notice";
import { drainReminders, type ClaimedReminder } from "@/lib/email/group-invoice-reminder";
import { createEventToken } from "@/lib/event-token";
import { drainEventEmails, type ClaimedEventEmail } from "@/lib/email/event-emails";
import { drainOutbox, type ClaimedEmail, type DrainResult } from "@/lib/email/outbox";

/** Emailed booking links work for a week; the guest can always ask for a fresh one. */
export const EMAIL_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Sends the morning summaries that are due (migration 129). Same rules as drainNow: nothing is lost when email is not configured. */
export async function drainDigestsNow(limit: number): Promise<{ claimed: number; sent: number; failed: number } | { skipped: string }> {
  const mailer = createMailer();
  if (!mailer) return { skipped: "email not configured" };
  const db = createServiceClient();
  return drainDigests(
    {
      async claim(n) {
        const { data, error } = await db.rpc("claim_digests", { p_limit: n });
        if (error) throw new Error(error.message);
        return (data ?? []) as ClaimedDigest[];
      },
      async mark(id, ok, errorText) {
        const { error } = await db.rpc("mark_digest_result", { p_id: id, p_ok: ok, p_error: errorText ?? null });
        if (error) throw new Error(error.message);
      },
      mailer,
      log: (level, message, context) => console[level === "info" ? "log" : level](`[email] ${message}`, context ?? {}),
    },
    limit,
  );
}

/** Sends the overdue group invoice reminders that are due (migration 166). Same rules as drainNow. */
export async function drainInvoiceRemindersNow(
  limit: number,
): Promise<{ claimed: number; sent: number; failed: number } | { skipped: string }> {
  const mailer = createMailer();
  if (!mailer) return { skipped: "email not configured" };
  const db = createServiceClient();
  return drainReminders(
    {
      async claim(n) {
        const { data, error } = await db.rpc("claim_group_invoice_reminders", { p_limit: n });
        if (error) throw new Error(error.message);
        return (data ?? []) as ClaimedReminder[];
      },
      async mark(id, ok, errorText) {
        const { error } = await db.rpc("mark_group_invoice_reminder_result", { p_id: id, p_ok: ok, p_error: errorText ?? null });
        if (error) throw new Error(error.message);
      },
      mailer,
      log: (level, message, context) => console[level === "info" ? "log" : level](`[email] ${message}`, context ?? {}),
    },
    limit,
  );
}

/** Sends the waiting list emails that are due (migration 130). Same rules as drainNow. */
export async function drainNoticesNow(limit: number): Promise<{ claimed: number; sent: number; failed: number } | { skipped: string }> {
  const mailer = createMailer();
  if (!mailer) return { skipped: "email not configured" };
  const db = createServiceClient();
  return drainNotices(
    {
      async claim(n) {
        const { data, error } = await db.rpc("claim_waitlist_notices", { p_limit: n });
        if (error) throw new Error(error.message);
        return (data ?? []) as ClaimedNotice[];
      },
      async mark(id, ok, errorText) {
        const { error } = await db.rpc("mark_waitlist_notice_result", { p_id: id, p_ok: ok, p_error: errorText ?? null });
        if (error) throw new Error(error.message);
      },
      mailer,
      linkScheme: process.env.EMAIL_LINK_SCHEME === "http" ? "http" : "https",
      log: (level, message, context) => console[level === "info" ? "log" : level](`[email] ${message}`, context ?? {}),
    },
    limit,
  );
}

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

/** Emailed event links last as long as the pages they open (60 days for a venue booking, 180 for tickets). */
const EVENT_LINK_TTL = { v: 60 * 24 * 3600, t: 180 * 24 * 3600 } as const;

/** Sends the event emails that are due (migration 144). Same rules as drainNow: nothing is lost when email is not configured. */
export async function drainEventEmailsNow(limit: number): Promise<{ claimed: number; sent: number; failed: number } | { skipped: string }> {
  const mailer = createMailer();
  if (!mailer) return { skipped: "email not configured" };
  const secret = serverEnv().BOOKING_TOKEN_SECRET;
  const db = createServiceClient();
  return drainEventEmails(
    {
      async claim(n) {
        const { data, error } = await db.rpc("claim_event_emails", { p_limit: n });
        if (error) throw new Error(error.message);
        return (data ?? []) as unknown as ClaimedEventEmail[];
      },
      async mark(id, ok, errorText) {
        const { error } = await db.rpc("mark_event_email_result", { p_id: id, p_ok: ok, p_error: errorText ?? null });
        if (error) throw new Error(error.message);
      },
      mailer,
      makeToken: (kind, id) => createEventToken(kind, id, secret, EVENT_LINK_TTL[kind]),
      linkScheme: process.env.EMAIL_LINK_SCHEME === "http" ? "http" : "https",
      log: (level, message, context) => console[level === "info" ? "log" : level](`[email] ${message}`, context ?? {}),
    },
    limit,
  );
}
