import { z } from "zod";
import { createRefund } from "@/lib/paystack";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { payoutRefund, type PayoutStart } from "@/lib/refunds/payout";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cookie-authenticated POST: only accept it from our own pages. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host.split(",")[0]!.trim();
  } catch {
    return false;
  }
}

/**
 * Staff action: pay out an approved provider refund through Paystack, at most once (see lib/refunds/payout.ts).
 * Permission (refund.approve at that property) is enforced inside start_refund_payout under the caller's own session,
 * so a refund the caller may not see is simply "not found". Everything after that runs with the service role.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!z.guid().safeParse(id).success) return Response.json({ error: "not found" }, { status: 404 });
  if (!sameOrigin(request)) return Response.json({ error: "forbidden" }, { status: 403 });

  const staff = await createClient();
  const { data: auth } = await staff.auth.getUser();
  if (!auth.user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const service = createServiceClient();

  try {
    const outcome = await payoutRefund(
      {
        async start(refundId) {
          const { data, error } = await staff.rpc("start_refund_payout", { p_refund_id: refundId });
          if (error) throw Object.assign(new Error(error.message), { staff: true });
          return data as PayoutStart;
        },
        async getSecret(refundId) {
          const { data, error } = await service.rpc("refund_payout_context", { p_refund_id: refundId });
          if (error) throw new Error(error.message);
          return resolveProviderSecret((data as { secret_reference: string }).secret_reference);
        },
        createRefund: (args, secret) => createRefund(args, secret),
        async recordResult(a) {
          const { error } = await service.rpc("record_refund_result", {
            p_provider: "paystack", p_event_id: a.eventId, p_refund_id: a.refundId, p_status: a.status,
            p_provider_refund_id: a.providerRefundId, p_failure_reason: a.failureReason, p_payload: { source: "payout" },
          });
          if (error) throw new Error(error.message);
        },
        async noteAttention(refundId, note) {
          const { error } = await service.rpc("note_refund_attention", { p_refund_id: refundId, p_note: note });
          if (error) throw new Error(error.message);
        },
        log: (level, message, ctx) => console[level === "info" ? "log" : level](`[refund-payout] ${message}`, ctx ?? {}),
      },
      id,
    );
    return Response.json(outcome, { status: outcome.status === "failed" ? 422 : 200 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (/NOT_FOUND/.test(message)) return Response.json({ error: "not found" }, { status: 404 });
    if (/POLICY_VIOLATION|INVALID_STATE/.test(message)) return Response.json({ error: message.replace(/^.*?(POLICY_VIOLATION|INVALID_STATE)/, "$1") }, { status: 409 });
    console.error("[refund-payout] failed", { refundId: id, message });
    return Response.json({ error: "payout failed" }, { status: 500 });
  }
}
