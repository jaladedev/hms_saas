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
  const res = await fetchFn(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
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
