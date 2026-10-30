import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Paystack helpers (checked against Paystack's docs, October 2026):
 *  - Webhooks carry `x-paystack-signature`: hex HMAC-SHA512 of the RAW request body, keyed with the secret key.
 *  - `charge.success` fires only for successful charges, but the transaction is re-verified with
 *    GET /transaction/verify/:reference before any money is recorded. Status, amount (kobo for NGN),
 *    currency and channel come from that response, never from the webhook body.
 *  - Refund events: refund.pending, refund.processing, refund.processed, refund.failed.
 */

/** Paystack API base. Overridable only so the end-to-end test can point at a fake server. */
export function paystackBaseUrl(): string {
  return process.env.PAYSTACK_API_BASE_URL ?? "https://api.paystack.co";
}

export function verifyWebhookSignature(rawBody: Uint8Array | string, signature: string | null | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = Buffer.from(createHmac("sha512", secret).update(rawBody).digest("hex"), "utf8");
  const given = Buffer.from(signature.trim().toLowerCase(), "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const webhookEventSchema = z.object({
  event: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
});
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

const verifyResponseSchema = z.object({
  status: z.boolean(),
  data: z
    .object({
      id: z.number().optional(),
      status: z.string(),
      reference: z.string(),
      amount: z.number().int(),
      currency: z.string(),
      channel: z.string().optional().nullable(),
    })
    .optional(),
});

export type VerifiedTransaction = {
  id: number | null;
  status: string; // success, failed, abandoned, pending, ongoing, processing, queued, reversed
  reference: string;
  amountMinor: number;
  currency: string;
  channel: string | null;
};
export type VerifyResult = { ok: true; transaction: VerifiedTransaction } | { ok: false; reason: "not_found" };

/**
 * Throws on network errors, 5xx, rate limits and unexpected shapes so the webhook is answered with an
 * error and Paystack retries. A clean 404 means the reference is not known to this account.
 */
export async function verifyTransaction(
  reference: string,
  secretKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<VerifyResult> {
  const res = await fetchFn(`${paystackBaseUrl()}/transaction/verify/${encodeURIComponent(reference)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${secretKey}` },
    cache: "no-store",
  });
  if (res.status === 404) return { ok: false, reason: "not_found" };
  if (!res.ok) throw new Error(`Paystack verify failed with HTTP ${res.status}`);
  const parsed = verifyResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error("Paystack verify returned an unexpected response");
  if (!parsed.data.status || !parsed.data.data) return { ok: false, reason: "not_found" };
  const d = parsed.data.data;
  return {
    ok: true,
    transaction: {
      id: d.id ?? null,
      status: d.status,
      reference: d.reference,
      amountMinor: d.amount,
      currency: d.currency.toUpperCase(),
      channel: d.channel ?? null,
    },
  };
}

const initializeResponseSchema = z.object({
  status: z.boolean(),
  data: z.object({ authorization_url: z.string().url(), reference: z.string() }).optional(),
});

/**
 * Opens a hosted checkout. `amountMinor` is kobo for NGN, exactly the amount stored on the payment attempt.
 * The reference is OUR attempt reference, so the webhook and verify call find the attempt later.
 * Throws on any failure; the caller shows a retry message and the unused attempt expires harmlessly.
 */
export async function initializeTransaction(
  args: { email: string; amountMinor: number; currency: string; reference: string; callbackUrl: string },
  secretKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ authorizationUrl: string }> {
  const res = await fetchFn(`${paystackBaseUrl()}/transaction/initialize`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: args.email,
      amount: args.amountMinor,
      currency: args.currency,
      reference: args.reference,
      callback_url: args.callbackUrl,
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Paystack initialize failed with HTTP ${res.status}`);
  const parsed = initializeResponseSchema.safeParse(await res.json());
  if (!parsed.success || !parsed.data.status || !parsed.data.data) throw new Error("Paystack initialize returned an unexpected response");
  if (parsed.data.data.reference !== args.reference) throw new Error("Paystack initialize returned a different reference");
  return { authorizationUrl: parsed.data.data.authorization_url };
}

const refundResponseSchema = z.object({
  status: z.boolean(),
  data: z.object({ id: z.union([z.number(), z.string()]).optional(), status: z.string() }).optional(),
});

export type CreateRefundResult =
  | { kind: "accepted"; providerStatus: string; providerRefundId: string | null }
  | { kind: "rejected"; httpStatus: number; message: string };

/**
 * Asks Paystack to refund part or all of a transaction (`POST /refund`: transaction reference, optional
 * amount in subunits, currency, merchant note). The API has NO idempotency key, so a duplicate call can refund twice:
 * callers must call at most once per refund and never retry after an unknown outcome.
 *  - accepted: Paystack took it; providerStatus is pending, processing, processed, failed or needs-attention.
 *  - rejected: a 4xx other than 429, so no refund exists and the refund can safely be marked failed.
 *  - throws: 429, 5xx, network errors and unexpected shapes. The outcome is UNKNOWN: a person must check Paystack.
 */
export async function createRefund(
  args: { transactionReference: string; amountMinor: number; currency: string; merchantNote: string },
  secretKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<CreateRefundResult> {
  const res = await fetchFn(`${paystackBaseUrl()}/refund`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: args.transactionReference, amount: args.amountMinor, currency: args.currency, merchant_note: args.merchantNote }),
    cache: "no-store",
  });
  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    let message = `Paystack refused the refund (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { message?: unknown };
      if (typeof body.message === "string" && body.message) message = body.message.slice(0, 200);
    } catch {
      /* not JSON */
    }
    return { kind: "rejected", httpStatus: res.status, message };
  }
  if (!res.ok) throw new Error(`Paystack refund call failed with HTTP ${res.status}`);
  const parsed = refundResponseSchema.safeParse(await res.json());
  if (!parsed.success || !parsed.data.status || !parsed.data.data) throw new Error("Paystack refund returned an unexpected response");
  return { kind: "accepted", providerStatus: parsed.data.data.status, providerRefundId: parsed.data.data.id !== undefined ? String(parsed.data.data.id) : null };
}
