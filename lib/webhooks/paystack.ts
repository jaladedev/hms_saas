import { verifyWebhookSignature, webhookEventSchema, type VerifyResult } from "@/lib/paystack";

/**
 * Decision logic for Paystack webhooks, free of Next.js and Supabase so it can be tested directly.
 * The route supplies the dependencies. Response codes matter: Paystack retries anything that is not 2xx,
 * so use 2xx for "handled or deliberately ignored" and 5xx for "try again later".
 */

export type ConfirmPaymentArgs = {
  providerEventId: string;
  eventType: string;
  reference: string;
  status: "success";
  amountMinor: number;
  currency: string;
  channel: string | null;
  payload: Record<string, unknown>;
  tenantId: string;
};
export type RefundResultArgs = {
  providerEventId: string;
  refundId: string;
  status: "succeeded" | "failed";
  providerRefundId: string | null;
  failureReason: string | null;
  payload: Record<string, unknown>;
};

export type WebhookDeps = {
  loadAccount(accountId: string): Promise<{ tenantId: string; secretReference: string } | null>;
  /** Turns a secret_reference ("env:NAME") into the secret. Throws when it cannot. */
  resolveSecret(secretReference: string): string;
  verifyTransaction(reference: string, secretKey: string): Promise<VerifyResult>;
  confirmPayment(args: ConfirmPaymentArgs): Promise<{ result?: string }>;
  findProcessingRefund(tenantId: string, transactionReference: string, amountMinor: number): Promise<string | null>;
  recordRefundResult(tenantId: string, args: RefundResultArgs): Promise<{ result?: string }>;
  log?(level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void;
};

export type WebhookOutcome = { status: number; body: Record<string, unknown> };

const PENDING_LIKE = new Set(["pending", "ongoing", "processing", "queued"]);

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function int(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

export async function handlePaystackWebhook(
  deps: WebhookDeps,
  input: { accountId: string; rawBody: Uint8Array; signature: string | null },
): Promise<WebhookOutcome> {
  const log = deps.log ?? (() => {});
  try {
    const account = await deps.loadAccount(input.accountId);
    if (!account) return { status: 404, body: { error: "unknown account" } };

    let secret: string;
    try {
      secret = deps.resolveSecret(account.secretReference);
    } catch {
      log("error", "paystack secret could not be resolved", { accountId: input.accountId });
      return { status: 500, body: { error: "account misconfigured" } };
    }

    if (!verifyWebhookSignature(input.rawBody, input.signature, secret)) {
      log("warn", "paystack webhook with invalid signature", { accountId: input.accountId });
      return { status: 401, body: { error: "invalid signature" } };
    }

    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(input.rawBody).toString("utf8"));
    } catch {
      return { status: 400, body: { error: "invalid json" } };
    }
    const parsed = webhookEventSchema.safeParse(json);
    if (!parsed.success) return { status: 400, body: { error: "invalid event" } };
    const { event, data } = parsed.data;

    if (event === "charge.success") {
      const reference = str(data.reference);
      if (!reference) return { status: 400, body: { error: "missing reference" } };
      // Never trust the webhook body for money: ask Paystack.
      const verified = await deps.verifyTransaction(reference, secret);
      if (!verified.ok) {
        log("warn", "charge.success for a reference Paystack does not know", { accountId: input.accountId });
        return { status: 200, body: { received: true, result: "ignored_unverified" } };
      }
      const tx = verified.transaction;
      if (PENDING_LIKE.has(tx.status)) {
        return { status: 503, body: { error: "transaction not final yet, retry" } };
      }
      if (tx.status !== "success" || tx.reference !== reference) {
        log("warn", "charge.success contradicted by verification", { accountId: input.accountId, status: tx.status });
        return { status: 200, body: { received: true, result: "ignored_unverified" } };
      }
      const outcome = await deps.confirmPayment({
        providerEventId: `charge.success:${tx.id ?? reference}`,
        eventType: event,
        reference,
        status: "success",
        amountMinor: tx.amountMinor,
        currency: tx.currency,
        channel: tx.channel,
        // Keep the stored payload minimal: no customer details.
        payload: { event, reference, amount: tx.amountMinor, currency: tx.currency, channel: tx.channel },
        tenantId: account.tenantId,
      });
      return { status: 200, body: { received: true, result: outcome.result ?? null } };
    }

    if (event === "refund.processed" || event === "refund.failed") {
      // Payload shape taken from third-party documentation: confirm in Paystack test mode (see HANDOFF).
      const transaction = typeof data.transaction === "object" && data.transaction !== null ? (data.transaction as Record<string, unknown>) : {};
      const txRef = str(data.transaction_reference) ?? str(transaction.reference);
      const amount = int(data.amount);
      if (!txRef || amount === null) return { status: 400, body: { error: "missing transaction reference or amount" } };
      const refundId = await deps.findProcessingRefund(account.tenantId, txRef, amount);
      if (!refundId) {
        log("warn", "refund webhook with no matching refund in processing", { accountId: input.accountId, event });
        return { status: 200, body: { received: true, result: "ignored_no_match" } };
      }
      const providerRefundId = data.id !== undefined && data.id !== null ? String(data.id) : null;
      const outcome = await deps.recordRefundResult(account.tenantId, {
        providerEventId: `${event}:${providerRefundId ?? `${txRef}:${amount}`}`,
        refundId,
        status: event === "refund.processed" ? "succeeded" : "failed",
        providerRefundId,
        failureReason: event === "refund.failed" ? "provider reported refund.failed" : null,
        payload: { event, transaction_reference: txRef, amount },
      });
      return { status: 200, body: { received: true, result: outcome.result ?? null } };
    }

    // refund.pending, refund.processing and everything else: acknowledge so Paystack stops retrying.
    return { status: 200, body: { received: true, result: "ignored_event" } };
  } catch (error) {
    log("error", "paystack webhook processing failed", {
      accountId: input.accountId,
      message: error instanceof Error ? error.message : "unknown error",
    });
    return { status: 500, body: { error: "processing failed" } };
  }
}
