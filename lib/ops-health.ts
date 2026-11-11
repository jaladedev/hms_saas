/**
 * Turns the raw counts from the database function ops_health() (migration 094) into a verdict an uptime monitor can act on.
 * The database records facts; the thresholds live here so they can change without a migration. docs/MONITORING.md explains each.
 *
 *   fail  something needs a person now, or the maintenance job has stopped: the endpoint answers 503 and the monitor alerts
 *   warn  worth a look today: the endpoint still answers 200 and the problem is listed in the body
 *   ok    nothing to report
 */
export type RawHealth = {
  maintenance: { last_run_at: string; last_ok_at: string | null; last_error: string | null } | null;
  emails_failed_7d: number;
  emails_stuck: number;
  payment_events_stuck: number;
  payment_events_mismatch_7d: number;
  refunds_stuck: number;
  holds_overdue: number;
  paid_inventory_lost: number;
  attention_other: number;
};

export type HealthStatus = "ok" | "warn" | "fail";
export type HealthIssue = { check: string; level: "warn" | "fail"; detail: string };
export type HealthReport = { status: HealthStatus; issues: HealthIssue[]; checkedAt: string };

/** The maintenance job runs every few minutes; this long without a good run means it has stopped. */
export const MAINTENANCE_STALE_MINUTES = 30;
export const EMAILS_FAILED_WARN = 5;

const MIN = 60_000;

export function evaluateHealth(raw: RawHealth, now: Date = new Date()): HealthReport {
  const issues: HealthIssue[] = [];
  const fail = (check: string, detail: string) => issues.push({ check, level: "fail", detail });
  const warn = (check: string, detail: string) => issues.push({ check, level: "warn", detail });

  const m = raw.maintenance;
  if (!m) {
    fail("maintenance", "the maintenance job has never reported");
  } else {
    const lastOk = m.last_ok_at ? new Date(m.last_ok_at).getTime() : null;
    if (lastOk === null || now.getTime() - lastOk > MAINTENANCE_STALE_MINUTES * MIN) {
      const ago = lastOk === null ? "never" : `${Math.round((now.getTime() - lastOk) / MIN)} minutes ago`;
      fail("maintenance", `no good maintenance run since ${ago}${m.last_error ? `: ${m.last_error}` : ""}`);
    } else if (m.last_error) {
      warn("maintenance", `the latest run had a failed step: ${m.last_error}`);
    }
  }

  if (raw.paid_inventory_lost > 0)
    fail("paid_inventory_lost", `${raw.paid_inventory_lost} guest(s) paid for a room that was no longer free`);
  if (raw.payment_events_stuck > 0)
    fail("payment_events_stuck", `${raw.payment_events_stuck} payment notice(s) received but not processed`);
  if (raw.refunds_stuck > 0) fail("refunds_stuck", `${raw.refunds_stuck} refund(s) in processing for over 2 hours`);
  if (raw.holds_overdue > 0) fail("holds_overdue", `${raw.holds_overdue} held room(s) not released after the hold ended`);

  if (raw.emails_stuck > 0) warn("emails_stuck", `${raw.emails_stuck} email(s) waiting over 30 minutes past due`);
  if (raw.emails_failed_7d >= EMAILS_FAILED_WARN) warn("emails_failed_7d", `${raw.emails_failed_7d} email(s) gave up in the last 7 days`);
  if (raw.payment_events_mismatch_7d > 0)
    warn("payment_events_mismatch_7d", `${raw.payment_events_mismatch_7d} payment notice(s) matched no attempt in 7 days`);
  if (raw.attention_other > 0) warn("attention_other", `${raw.attention_other} booking(s) flagged for attention`);

  const status: HealthStatus = issues.some((i) => i.level === "fail") ? "fail" : issues.length > 0 ? "warn" : "ok";
  return { status, issues, checkedAt: now.toISOString() };
}

/** The HTTP status for a report: only "fail" is an error to a monitor. */
export function httpStatusFor(status: HealthStatus): number {
  return status === "fail" ? 503 : 200;
}
