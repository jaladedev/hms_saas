import type { RetryRefundResult } from "@/lib/paystack";

export type DetailsStart = { refund_id: string; provider_refund_id: string; currency: string; call_allowed: boolean };

export type DetailsDeps = {
  /** As the signed-in approver: true for exactly one caller until the attempt is refused or Paystack asks again. */
  start(refundId: string): Promise<DetailsStart>;
  /** The tenant's Paystack secret key. Throws when it cannot be resolved. */
  getSecret(refundId: string): Promise<string>;
  retry(
    args: { providerRefundId: string; currency: string; accountNumber: string; bankId: string },
    secret: string,
  ): Promise<RetryRefundResult>;
  finish(refundId: string, outcome: "accepted" | "rejected" | "unknown", note: string | null): Promise<void>;
  log?(level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void;
};

export type DetailsInput = { bankId: string; accountNumber: string };

export type DetailsOutcome =
  | { status: "already_started" }
  | { status: "submitted" }
  | { status: "rejected"; reason: string }
  | { status: "unknown"; note: string };

export type DetailsCheck = { ok: true; value: DetailsInput } | { ok: false; error: "bank_required" | "account_invalid" };

/**
 * Checks what staff typed BEFORE the one-shot guard is used, so a typo never burns the attempt.
 * Spaces and dashes are removed from the account number. A Nigerian (NGN) account number has exactly 10 digits;
 * other currencies accept 5 to 20.
 */
export function checkDetails(currency: string, raw: { bankId?: unknown; accountNumber?: unknown }): DetailsCheck {
  const bankId = typeof raw.bankId === "string" ? raw.bankId.trim() : "";
  if (!/^\d{1,12}$/.test(bankId)) return { ok: false, error: "bank_required" };
  const accountNumber = typeof raw.accountNumber === "string" ? raw.accountNumber.replace(/[\s-]/g, "") : "";
  const okLength = currency === "NGN" ? accountNumber.length === 10 : accountNumber.length >= 5 && accountNumber.length <= 20;
  if (!/^\d+$/.test(accountNumber) || !okLength) return { ok: false, error: "account_invalid" };
  return { ok: true, value: { bankId, accountNumber } };
}

/**
 * Sends the customer's bank details to Paystack for a refund it reported as needs-attention, at most once per attempt.
 * Paystack's retry endpoint has no idempotency key, so:
 *  - only the caller told call_allowed may call Paystack; everyone else gets already_started;
 *  - a definite refusal (4xx, or no provider configured) frees the attempt so staff can correct the details;
 *  - an UNKNOWN outcome (timeout, 5xx, 429, odd response) keeps the attempt used: a person checks Paystack first.
 * The account number exists only in this call's arguments: it is not logged, stored or returned.
 */
export async function submitRefundDetails(deps: DetailsDeps, refundId: string, input: DetailsInput): Promise<DetailsOutcome> {
  const log = deps.log ?? (() => {});
  const started = await deps.start(refundId);
  if (!started.call_allowed) return { status: "already_started" };

  let secret: string;
  try {
    secret = await deps.getSecret(refundId);
  } catch {
    // Paystack was never called, so the attempt can be given back.
    const reason = "payment provider is not configured for this hotel";
    await deps.finish(refundId, "rejected", reason);
    return { status: "rejected", reason };
  }

  let result: RetryRefundResult;
  try {
    result = await deps.retry(
      {
        providerRefundId: started.provider_refund_id,
        currency: started.currency,
        accountNumber: input.accountNumber,
        bankId: input.bankId,
      },
      secret,
    );
  } catch (e) {
    const detail = e instanceof Error ? e.message.split(input.accountNumber).join("…") : "error";
    const note = `bank details outcome unknown: ${detail}. Check Paystack before sending them again.`.slice(0, 500);
    log("error", "refund bank details outcome unknown", { refundId, note });
    await deps.finish(refundId, "unknown", note);
    return { status: "unknown", note };
  }

  if (result.kind === "rejected") {
    const note = `Paystack refused the bank details: ${result.message}`.slice(0, 500);
    await deps.finish(refundId, "rejected", note);
    return { status: "rejected", reason: result.message };
  }
  await deps.finish(refundId, "accepted", null);
  return { status: "submitted" };
}
