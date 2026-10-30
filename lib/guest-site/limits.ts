import "server-only";
import { headers } from "next/headers";
import { serverEnv } from "@/lib/env";
import { createServiceClient } from "@/lib/supabase/service";
import { clientIp, enforceRateLimits, subjectKey, type RateCheck, type RateRuleName } from "@/lib/rate-limit";

/**
 * Applies rate rules for the current request: `ip` rules count against the caller's address, `keyed`
 * rules against a value such as an email or reservation id. Only keyed hashes are stored. A database
 * failure throws, so the guest action fails closed rather than skipping the limit.
 */
export async function checkGuestLimits(spec: {
  ip?: RateRuleName[];
  keyed?: Array<{ rule: RateRuleName; value: string }>;
}) {
  const secret = serverEnv().BOOKING_TOKEN_SECRET;
  const checks: RateCheck[] = [];
  if (spec.ip?.length) {
    const subject = subjectKey(secret, clientIp(await headers()));
    for (const rule of spec.ip) checks.push({ rule, subject });
  }
  for (const k of spec.keyed ?? []) checks.push({ rule: k.rule, subject: subjectKey(secret, k.value) });

  const db = createServiceClient();
  return enforceRateLimits(async (key, limit, windowSeconds) => {
    const { data, error } = await db.rpc("consume_rate_limit", { p_key: key, p_limit: limit, p_window_seconds: windowSeconds });
    if (error) throw new Error(error.message);
    return data as { allowed: boolean; retry_after_seconds: number };
  }, checks);
}
