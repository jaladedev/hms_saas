import { verifyTransaction } from "@/lib/paystack";
import { handlePlatformInvoiceWebhook, platformPaystackSecret } from "@/lib/platform/invoice-payment";
import { buildInvoicePaymentDeps } from "@/lib/platform/invoice-payment-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

/** The platform's own Paystack webhook (invoice payments, migration 117). Set this URL on the platform's Paystack account. */
export async function POST(request: Request) {
  const secret = platformPaystackSecret();
  if (!secret) return Response.json({ error: "not configured" }, { status: 404 });
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return Response.json({ error: "payload too large" }, { status: 413 });
  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > MAX_BODY_BYTES) return Response.json({ error: "payload too large" }, { status: 413 });
  const outcome = await handlePlatformInvoiceWebhook(buildInvoicePaymentDeps(secret, verifyTransaction), {
    rawBody,
    signature: request.headers.get("x-paystack-signature"),
  });
  return Response.json(outcome.body, { status: outcome.status });
}
