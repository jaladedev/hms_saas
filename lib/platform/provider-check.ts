import { paystackBaseUrl } from "@/lib/paystack";
import type { PlatformCode, PlatformOk } from "@/lib/platform/hotel";
import { resolveProviderSecret } from "@/lib/provider-secret";

/**
 * "Test connection" for a hotel's Paystack account (platform admin, /platform/[tenantId]).
 *
 * What it proves: the environment variable the account points at exists, holds something shaped like a Paystack secret key of the
 * account's mode (test or live), and Paystack accepts it. What it does not prove: that the hotel's business is approved for live
 * payments, that its webhook is set up, or that a payment would succeed.
 *
 * It makes ONE read-only call, the same bank-list request `scripts/check-paystack-banks.mjs` verified against the real API, with a
 * page size of 1: no money moves and nothing is created. The outcome is a word; the key, the pointer's value, Paystack's reply and
 * any error text are never returned, logged or stored.
 */

export type CheckOutcome =
  | "ok" // Paystack accepted the key
  | "no_secret" // the environment variable is missing or too short
  | "bad_key" // set, but not shaped like a Paystack secret key (sk_test_… or sk_live_…)
  | "mode_mismatch" // a test key on a live account, or the other way round: nothing was sent to Paystack
  | "rejected" // Paystack answered 401 or 403
  | "unreachable" // network failure, timeout, rate limit or a server error: try again
  | "unexpected"; // Paystack answered, but not in the shape the app expects

export type KeyMode = "test" | "live";
export type CheckResult = { outcome: CheckOutcome; keyMode: KeyMode | null };

export const CHECK_OUTCOMES: readonly CheckOutcome[] = [
  "ok",
  "no_secret",
  "bad_key",
  "mode_mismatch",
  "rejected",
  "unreachable",
  "unexpected",
];

/** `sk_test_…` or `sk_live_…` and nothing else; anything else is not a Paystack secret key. */
export function keyModeOf(secret: string): KeyMode | null {
  const m = /^sk_(test|live)_[A-Za-z0-9]{8,}$/.exec(secret);
  return m ? (m[1] as KeyMode) : null;
}

const TIMEOUT_MS = 8000;

export async function checkPaystackAccount(
  account: { mode: string; secretReference: string },
  env: Record<string, string | undefined> = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<CheckResult> {
  let secret: string;
  try {
    secret = resolveProviderSecret(account.secretReference, env);
  } catch {
    return { outcome: "no_secret", keyMode: null };
  }
  const keyMode = keyModeOf(secret);
  if (!keyMode) return { outcome: "bad_key", keyMode: null };
  // Checked before anything is sent, so a live key is never used for a test account's check or the reverse.
  if (keyMode !== account.mode) return { outcome: "mode_mismatch", keyMode };

  const params = new URLSearchParams({ currency: "NGN", perPage: "1", use_cursor: "true", country: "nigeria" });
  let res: Response;
  try {
    res = await fetchFn(`${paystackBaseUrl()}/bank?${params.toString()}`, {
      headers: { Authorization: `Bearer ${secret}` },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { outcome: "unreachable", keyMode };
  }
  if (res.status === 401 || res.status === 403) return { outcome: "rejected", keyMode };
  if (!res.ok) return { outcome: "unreachable", keyMode }; // 429 and 5xx: nothing to conclude about the key
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { outcome: "unexpected", keyMode };
  }
  const b = body as { status?: unknown; data?: unknown } | null;
  return b && b.status === true && Array.isArray(b.data) ? { outcome: "ok", keyMode } : { outcome: "unexpected", keyMode };
}

/** The notice a check ends in: one success word or one refusal word, both worded in `lib/platform/hotel.ts`. */
export function outcomeNotice(outcome: CheckOutcome): { ok: PlatformOk } | { err: PlatformCode } {
  switch (outcome) {
    case "ok":
      return { ok: "check_ok" };
    case "no_secret":
      return { err: "check_no_secret" };
    case "bad_key":
      return { err: "check_bad_key" };
    case "mode_mismatch":
      return { err: "check_mode" };
    case "rejected":
      return { err: "check_rejected" };
    case "unreachable":
      return { err: "check_unreachable" };
    case "unexpected":
      return { err: "check_unexpected" };
  }
}
