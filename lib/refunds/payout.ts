import type { CreateRefundResult } from "@/lib/paystack";

export type PayoutStart = {
  refund_id: string;
  internal_reference: string;
  provider: string;
  payment_provider_reference: string;
  amount_minor: number;
  currency: string;
  call_allowed: boolean;
};

export type PayoutDeps = {
  /** Moves the refund approved -> processing as the signed-in approver; call_allowed is true for exactly one caller. */
  start(refundId: string): Promise<PayoutStart>;
  /** The tenant's Paystack secret key. Throws when it cannot be resolved. */
  getSecret(refundId: string): Promise<string>;
  createRefund(
    args: { transactionReference: string; amountMinor: number; currency: string; merchantNote: string },
    secret: string,
  ): Promise<CreateRefundResult>;
  recordResult(args: { refundId: string; eventId: string; status: "succeeded" | "failed"; providerRefundId: string | null; failureReason: string | null }): Promise<void>;
  noteAttention(refundId: string, note: string): Promise<void>;
  log?(level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void;
};

export type PayoutOutcome =
  | { status: "already_started" }
  | { status: "submitted"; providerStatus: string }
  | { status: "succeeded" }
  | { status: "failed"; reason: string }
  | { status: "unknown"; note: string };

/**
 * Pays a provider refund out, at most once. Paystack's refund API has no idempotency key, so:
 *  - only the caller told call_allowed may call the provider; everyone else gets already_started;
 *  - a definite refusal (4xx, or no provider configured) records the refund as failed, which frees the amount;
 *  - an UNKNOWN outcome (timeout, 5xx, 429, odd response) is never retried: the refund stays processing with a
 *    note for a person to check on Paystack. The webhook (refund.processed / refund.failed) reports the real result.
 */
export async function payoutRefund(deps: PayoutDeps, refundId: string): Promise<PayoutOutcome> {
  const log = deps.log ?? (() => {});
  const started = await deps.start(refundId);
  if (!started.call_allowed) return { status: "already_started" };
  const eventId = `payout:${refundId}`;

  let secret: string;
  try {
    secret = await deps.getSecret(refundId);
  } catch {
    // The provider was never called, so failing the refund is safe.
    const reason = "payment provider is not configured for this hotel";
    await deps.recordResult({ refundId, eventId, status: "failed", providerRefundId: null, failureReason: reason });
    return { status: "failed", reason };
  }

  let result: CreateRefundResult;
  try {
    result = await deps.createRefund(
      { transactionReference: started.payment_provider_reference, amountMinor: started.amount_minor, currency: started.currency, merchantNote: `Refund ${started.internal_reference}` },
      secret,
    );
  } catch (e) {
    const note = `payout outcome unknown: ${e instanceof Error ? e.message : "error"}. Check Paystack before retrying.`.slice(0, 500);
    log("error", "refund payout outcome unknown", { refundId, note });
    await deps.noteAttention(refundId, note);
    return { status: "unknown", note };
  }

  if (result.kind === "rejected") {
    await deps.recordResult({ refundId, eventId, status: "failed", providerRefundId: null, failureReason: `Paystack refused: ${result.message}` });
    return { status: "failed", reason: result.message };
  }
  if (result.providerStatus === "processed") {
    await deps.recordResult({ refundId, eventId, status: "succeeded", providerRefundId: result.providerRefundId, failureReason: null });
    return { status: "succeeded" };
  }
  if (result.providerStatus === "failed") {
    await deps.recordResult({ refundId, eventId, status: "failed", providerRefundId: result.providerRefundId, failureReason: "Paystack reported the refund as failed" });
    return { status: "failed", reason: "Paystack reported the refund as failed" };
  }
  if (result.providerStatus === "needs-attention") {
    await deps.noteAttention(refundId, "Paystack needs the customer's bank details to complete this refund (needs-attention)");
  }
  return { status: "submitted", providerStatus: result.providerStatus };
}
