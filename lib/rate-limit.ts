import { createHmac } from "node:crypto";
import { isIP } from "node:net";

export type RateRule = { limit: number; windowSeconds: number };

/** Guest-facing limits. Holds spend inventory and payments spend provider calls, so those are tight. */
export const RATE_RULES = {
  search: { limit: 120, windowSeconds: 600 },
  hold: { limit: 10, windowSeconds: 3600 },
  holdEmail: { limit: 6, windowSeconds: 3600 },
  pay: { limit: 10, windowSeconds: 3600 },
  payReservation: { limit: 6, windowSeconds: 3600 },
  link: { limit: 5, windowSeconds: 3600 },
  linkEmail: { limit: 3, windowSeconds: 3600 },
} as const satisfies Record<string, RateRule>;
export type RateRuleName = keyof typeof RATE_RULES;

type HeaderReader = { get(name: string): string | null };

/**
 * The client address as seen by the platform in front of the app. X-Forwarded-For is only trustworthy
 * when the app runs behind a proxy that sets it (Vercel, Cloudflare, a load balancer): deploy that way.
 */
export function clientIp(headers: HeaderReader): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded && isIP(forwarded)) return forwarded;
  const real = headers.get("x-real-ip")?.trim();
  if (real && isIP(real)) return real;
  return "unknown";
}

/** Keyed hash so counters never store a raw address or email, and cannot be guessed offline. */
export function subjectKey(secret: string, value: string): string {
  return createHmac("sha256", `rate-limit:${secret}`).update(value.trim().toLowerCase()).digest("hex").slice(0, 32);
}

export type ConsumeResult = { allowed: boolean; retry_after_seconds: number };
export type RateCheck = { rule: RateRuleName; subject: string };

/** Counts every check (so one request spends one hit on each rule) and reports the longest wait if any refused. */
export async function enforceRateLimits(
  consume: (key: string, limit: number, windowSeconds: number) => Promise<ConsumeResult>,
  checks: RateCheck[],
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  let retry = 0;
  let refused = false;
  for (const { rule, subject } of checks) {
    const r = RATE_RULES[rule];
    const result = await consume(`${rule}:${subject}`, r.limit, r.windowSeconds);
    if (!result.allowed) {
      refused = true;
      retry = Math.max(retry, result.retry_after_seconds);
    }
  }
  return refused ? { allowed: false, retryAfterSeconds: retry } : { allowed: true };
}
