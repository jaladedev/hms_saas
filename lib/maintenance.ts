import { createHash, timingSafeEqual } from "node:crypto";

export type MaintenanceDeps = {
  expireLapsedHolds(limit: number): Promise<number>;
  drainEmails(limit: number): Promise<unknown>;
  purgeOldData(): Promise<unknown>;
  /** Refunds stuck in processing (an unknown payout outcome, or a webhook that never came). */
  staleRefunds(): Promise<unknown[]>;
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
    emails: await step(() => deps.drainEmails(25)),
    purge: await step(() => deps.purgeOldData()),
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
