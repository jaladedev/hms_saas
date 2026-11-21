import { createHash, timingSafeEqual } from "node:crypto";

export type MaintenanceDeps = {
  expireLapsedHolds(limit: number): Promise<number>;
  /** Queues the arrival reminder emails that are due (migration 122); the hotels that turned them on only. */
  queueArrivalReminders(): Promise<unknown>;
  /** Queues the review request emails that are due (migration 128); the hotels that turned them on only. */
  queueReviewRequests(): Promise<unknown>;
  /** Queues each hotel's morning summary once its local day has started (migration 129), then sends the ones that are due. */
  queueDailyDigests(): Promise<unknown>;
  drainDigests(limit: number): Promise<unknown>;
  /** Queues the waiting list emails for requests whose room has freed up (migration 130), then sends the ones that are due. */
  queueWaitlistNotices(): Promise<unknown>;
  drainWaitlistNotices(limit: number): Promise<unknown>;
  drainEmails(limit: number): Promise<unknown>;
  /** Queues the arrival reminder and review request texts that are due (migration 147), then sends the texts that are due. */
  queueSmsMessages(): Promise<unknown>;
  drainSms(limit: number): Promise<unknown>;
  /** Sends the emails to guests who booked a venue or bought tickets on the website (migration 144). */
  drainEventEmails(limit: number): Promise<unknown>;
  /** Frees the rooms of group bookings whose release date has passed (migration 150). */
  releaseGroupBlocks(): Promise<unknown>;
  /** Queues the overdue group invoice reminders (migration 166), then sends the ones that are due. */
  queueInvoiceReminders(): Promise<unknown>;
  drainInvoiceReminders(limit: number): Promise<unknown>;
  /** The same overdue reminders by text (migration 173): queues them, then sends the ones that are due. */
  queueInvoiceSms(): Promise<unknown>;
  drainInvoiceSms(limit: number): Promise<unknown>;
  /** Tries failed channel bookings again, up to 5 attempts, waiting longer each time (migration 175). */
  retryChannelImports(): Promise<unknown>;
  /** Re-prices the next 60 nights for hotels with automatic pricing on, and switches it off where the plan lost the feature (migration 152). */
  applyDuePricing(): Promise<unknown>;
  /** Sends the webhooks that are due, with back-off between tries (migration 158). */
  drainWebhooks(limit: number): Promise<unknown>;
  purgeOldData(): Promise<unknown>;
  /** Raises overdue-repair notices and clears notifications older than 90 days. */
  sweepNotifications(): Promise<unknown>;
  /** Refunds stuck in processing (an unknown payout outcome, or a webhook that never came). */
  staleRefunds(): Promise<unknown[]>;
  /** Removes stored room photo files whose picture was deleted (migration 088). */
  cleanPhotoFiles(): Promise<unknown>;
  log?(level: "warn", message: string, context?: Record<string, unknown>): void;
};
export type StepResult = { ok: true; result: unknown } | { ok: false; error: string };

/** Runs each step on its own: a failure in one never stops the others. */
export async function runMaintenance(deps: MaintenanceDeps): Promise<Record<string, StepResult>> {
  const step = async (fn: () => Promise<unknown>): Promise<StepResult> => {
    try {
      return { ok: true, result: await fn() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "failed" };
    }
  };
  return {
    expiredHolds: await step(() => deps.expireLapsedHolds(200)),
    arrivalReminders: await step(() => deps.queueArrivalReminders()),
    reviewRequests: await step(() => deps.queueReviewRequests()),
    dailyDigests: await step(async () => ({ queued: await deps.queueDailyDigests(), sent: await deps.drainDigests(10) })),
    waitlistNotices: await step(async () => ({ queued: await deps.queueWaitlistNotices(), sent: await deps.drainWaitlistNotices(10) })),
    emails: await step(() => deps.drainEmails(25)),
    sms: await step(async () => ({ queued: await deps.queueSmsMessages(), sent: await deps.drainSms(25) })),
    eventEmails: await step(() => deps.drainEventEmails(25)),
    groupBlocks: await step(() => deps.releaseGroupBlocks()),
    invoiceReminders: await step(async () => ({ queued: await deps.queueInvoiceReminders(), sent: await deps.drainInvoiceReminders(10) })),
    invoiceSms: await step(async () => ({ queued: await deps.queueInvoiceSms(), sent: await deps.drainInvoiceSms(10) })),
    channelRetries: await step(() => deps.retryChannelImports()),
    pricing: await step(() => deps.applyDuePricing()),
    webhooks: await step(() => deps.drainWebhooks(25)),
    purge: await step(() => deps.purgeOldData()),
    photoFiles: await step(() => deps.cleanPhotoFiles()),
    notifications: await step(() => deps.sweepNotifications()),
    staleRefunds: await step(async () => {
      const stale = await deps.staleRefunds();
      if (stale.length > 0) deps.log?.("warn", "refunds stuck in processing need a person", { count: stale.length, refunds: stale });
      return { count: stale.length, refunds: stale };
    }),
  };
}

/**
 * Cron callers send `Authorization: Bearer <CRON_SECRET>` (Vercel Cron does this automatically when
 * CRON_SECRET is set). The secret must be at least 32 characters, and comparison is constant time.
 */
export function isAuthorizedCron(authorization: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 32 || !authorization) return false;
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  const given = createHash("sha256").update(authorization).digest();
  return timingSafeEqual(expected, given);
}
