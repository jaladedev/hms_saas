import { z } from "zod";
import { retryRefundWithCustomerDetails } from "@/lib/paystack";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { checkDetails, submitRefundDetails, type DetailsStart } from "@/lib/refunds/details";
import { sameOrigin } from "@/lib/staff/same-origin";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Staff action: send the customer's bank details to Paystack for a refund it reported as needs-attention, at most
 * once per attempt (see lib/refunds/details.ts). Permission (refund.approve at that hotel) is enforced inside
 * start_refund_details_retry under the caller's own session. The account number is read from the body, passed to
 * Paystack and dropped: it is not stored, logged or returned.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!z.guid().safeParse(id).success) return Response.json({ error: "not found" }, { status: 404 });
  if (!sameOrigin(request)) return Response.json({ error: "forbidden" }, { status: 403 });

  const staff = await createClient();
  const { data: auth } = await staff.auth.getUser();
  if (!auth.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const raw = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

  // The currency decides the account-number rule, and it is read before the one-shot guard so a typo never burns the attempt.
  const { data: refund } = await staff.from("refunds").select("currency").eq("id", id).maybeSingle<{ currency: string }>();
  if (!refund) return Response.json({ error: "not found" }, { status: 404 });
  const checked = checkDetails(refund.currency, raw);
  if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });

  const service = createServiceClient();
  try {
    const outcome = await submitRefundDetails(
      {
        async start(refundId) {
          const { data, error } = await staff.rpc("start_refund_details_retry", { p_refund_id: refundId });
          if (error) throw new Error(error.message);
          return data as DetailsStart;
        },
        async getSecret(refundId) {
          const { data, error } = await service.rpc("refund_payout_context", { p_refund_id: refundId });
          if (error) throw new Error(error.message);
          return resolveProviderSecret((data as { secret_reference: string }).secret_reference);
        },
        retry: (args, secret) => retryRefundWithCustomerDetails(args, secret),
        async finish(refundId, result, note) {
          const { error } = await service.rpc("finish_refund_details_retry", { p_refund_id: refundId, p_outcome: result, p_note: note });
          if (error) throw new Error(error.message);
        },
        log: (level, message, ctx) => console[level === "info" ? "log" : level](`[refund-details] ${message}`, ctx ?? {}),
      },
      id,
      checked.value,
    );
    return Response.json(outcome, { status: outcome.status === "rejected" ? 422 : 200 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (/NOT_FOUND/.test(message)) return Response.json({ error: "not found" }, { status: 404 });
    if (/INVALID_STATE/.test(message)) return Response.json({ error: message.replace(/^.*?INVALID_STATE/, "INVALID_STATE") }, { status: 409 });
    console.error("[refund-details] failed", { refundId: id });
    return Response.json({ error: "failed" }, { status: 500 });
  }
}
