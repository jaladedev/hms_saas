import { after } from "next/server";
import { z } from "zod";
import { drainNow } from "@/lib/email/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyTransaction } from "@/lib/paystack";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { handlePaystackWebhook, type WebhookDeps } from "@/lib/webhooks/paystack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;
const accountIdSchema = z.guid();

function buildDeps(): WebhookDeps {
  const db = createServiceClient();
  return {
    async loadAccount(accountId) {
      const { data, error } = await db.rpc("payment_provider_account_for_webhook", { p_account_id: accountId });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      return row ? { tenantId: row.tenant_id as string, secretReference: row.secret_reference as string } : null;
    },
    resolveSecret: (reference) => resolveProviderSecret(reference),
    verifyTransaction: (reference, secret) => verifyTransaction(reference, secret),
    async confirmPayment(a) {
      const { data, error } = await db.rpc("confirm_payment", {
        p_provider: "paystack",
        p_event_id: a.providerEventId,
        p_event_type: a.eventType,
        p_reference: a.reference,
        p_status: a.status,
        p_amount_minor: a.amountMinor,
        p_currency: a.currency,
        p_channel: a.channel,
        p_payload: a.payload,
        p_tenant_id: a.tenantId,
      });
      if (error) throw new Error(error.message);
      const out = data as { result?: string; duplicate?: boolean } | null;
      return { result: out?.result, duplicate: out?.duplicate === true };
    },
    async findProcessingRefund(tenantId, transactionReference, amountMinor) {
      const { data, error } = await db.rpc("find_processing_refund", {
        p_tenant_id: tenantId,
        p_provider: "paystack",
        p_transaction_reference: transactionReference,
        p_amount_minor: amountMinor,
      });
      if (error) throw new Error(error.message);
      return (data as string | null) ?? null;
    },
    async recordRefundResult(_tenantId, a) {
      const { data, error } = await db.rpc("record_refund_result", {
        p_provider: "paystack",
        p_event_id: a.providerEventId,
        p_refund_id: a.refundId,
        p_status: a.status,
        p_provider_refund_id: a.providerRefundId,
        p_failure_reason: a.failureReason,
        p_payload: a.payload,
      });
      if (error) throw new Error(error.message);
      const out = data as { result?: string; duplicate?: boolean } | null;
      return { result: out?.result, duplicate: out?.duplicate === true };
    },
    log(level, message, context) {
      console[level === "info" ? "log" : level](`[paystack-webhook] ${message}`, context ?? {});
    },
  };
}

export async function POST(request: Request, context: { params: Promise<{ account: string }> }) {
  const { account } = await context.params;
  if (!accountIdSchema.safeParse(account).success) return Response.json({ error: "unknown account" }, { status: 404 });

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return Response.json({ error: "payload too large" }, { status: 413 });
  const rawBody = new Uint8Array(await request.arrayBuffer());
  if (rawBody.byteLength > MAX_BODY_BYTES) return Response.json({ error: "payload too large" }, { status: 413 });

  const outcome = await handlePaystackWebhook(buildDeps(), {
    accountId: account,
    rawBody,
    signature: request.headers.get("x-paystack-signature"),
  });
  if (outcome.status === 200) after(() => { drainNow(5).catch(() => {}); });   // confirmation and refund emails go out quickly
  return Response.json(outcome.body, { status: outcome.status });
}
