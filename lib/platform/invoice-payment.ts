import { verifyWebhookSignature, webhookEventSchema, type VerifyResult } from "@/lib/paystack";

/**
 * Paying a platform invoice online (migration 117), free of Next.js and Supabase so it can be tested directly.
 * The platform's own Paystack secret comes from PLATFORM_PAYSTACK_SECRET_KEY. Money is only ever recorded after the transaction has
 * been verified with Paystack: status, amount and currency come from that reply, never from the webhook body or the return URL.
 */

/** Our reference for an invoice payment: PIP- and 32 hex characters (made by the database). */
export const INVOICE_REFERENCE = /^PIP-[0-9a-f]{32}$/;

/** The platform's Paystack secret, or null when online invoice payment is not set up. */
export function platformPaystackSecret(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.PLATFORM_PAYSTACK_SECRET_KEY?.trim();
  return v ? v : null;
}

export type SettleResult = "paid" | "duplicate" | "not_success" | "mismatch" | "invoice_closed" | "unknown";

export type InvoicePaymentDeps = {
  secret: string;
  verifyTransaction: (reference: string, secret: string) => Promise<VerifyResult>;
  settle: (a: { reference: string; status: string; amountMinor: number; currency: string }) => Promise<{ result: SettleResult | string }>;
  log: (level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>) => void;
};

/**
 * Verifies a reference with Paystack and settles it. Safe to call any number of times (the return page and the webhook both do):
 * the database settles an attempt once. "unknown" is a reference that is not ours or that Paystack does not know.
 * Throws when Paystack or the database cannot be reached, so a webhook is answered with an error and retried.
 */
export async function settleInvoiceReference(deps: InvoicePaymentDeps, reference: string): Promise<SettleResult> {
  if (!INVOICE_REFERENCE.test(reference)) return "unknown";
  const verified = await deps.verifyTransaction(reference, deps.secret);
  if (!verified.ok) return "unknown";
  const t = verified.transaction;
  const { result } = await deps.settle({ reference, status: t.status, amountMinor: t.amountMinor, currency: t.currency });
  if (result === "invoice_closed")
    deps.log("error", "invoice payment taken for an invoice that was already paid or void: a person must decide about the money", {
      reference,
    });
  if (result === "mismatch")
    deps.log("error", "invoice payment amount or currency differs from the attempt: nothing was marked paid", { reference });
  const known: SettleResult[] = ["paid", "duplicate", "not_success", "mismatch", "invoice_closed", "unknown"];
  return known.includes(result as SettleResult) ? (result as SettleResult) : "unknown";
}

export type WebhookOutcome = { status: number; body: { ok?: true; ignored?: string; error?: string } };

/** The platform webhook: checks the signature, handles charge.success for our references, ignores everything else with 200. */
export async function handlePlatformInvoiceWebhook(
  deps: InvoicePaymentDeps,
  input: { rawBody: Uint8Array; signature: string | null },
): Promise<WebhookOutcome> {
  if (!verifyWebhookSignature(input.rawBody, input.signature, deps.secret)) return { status: 401, body: { error: "bad signature" } };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(input.rawBody));
  } catch {
    return { status: 400, body: { error: "bad body" } };
  }
  const event = webhookEventSchema.safeParse(json);
  if (!event.success) return { status: 400, body: { error: "bad event" } };
  if (event.data.event !== "charge.success") return { status: 200, body: { ignored: "event" } };
  const reference = event.data.data.reference;
  if (typeof reference !== "string" || !INVOICE_REFERENCE.test(reference)) return { status: 200, body: { ignored: "reference" } };
  try {
    await settleInvoiceReference(deps, reference);
  } catch (error) {
    deps.log("error", "could not settle an invoice payment", { reference, message: error instanceof Error ? error.message : "unknown" });
    return { status: 500, body: { error: "try again" } };
  }
  return { status: 200, body: { ok: true } };
}
