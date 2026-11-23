import { buildEnvelope, buildEvent, dedupeKey, makeDeduper, parseDsn, type ErrorContext } from "./error-report";

/**
 * Sends an error to the tracker named by ERROR_REPORT_DSN. With no DSN (or a malformed one) every call returns at once and nothing
 * leaves the server. It never throws, never waits more than 2 seconds, and reports the same error at most once a minute.
 */

const once = makeDeduper();
const TIMEOUT_MS = 2000;

export async function reportError(err: unknown, ctx: ErrorContext = {}, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const dsn = parseDsn(env.ERROR_REPORT_DSN);
    if (!dsn) return false;
    const event = buildEvent(err, {
      release: env.ERROR_REPORT_RELEASE || env.VERCEL_GIT_COMMIT_SHA,
      environment: env.ERROR_REPORT_ENV || env.VERCEL_ENV || env.NODE_ENV,
      runtime: env.NEXT_RUNTIME,
      ...ctx,
    });
    if (!once(dedupeKey(event))) return false;
    const res = await fetch(dsn.envelopeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=hms-reporter/1.0, sentry_key=${dsn.publicKey}`,
      },
      body: buildEnvelope(event, dsn),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
