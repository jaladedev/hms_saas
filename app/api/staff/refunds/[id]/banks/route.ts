import { z } from "zod";
import { listBanks } from "@/lib/paystack";
import { resolveProviderSecret } from "@/lib/provider-secret";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Staff read: the banks Paystack can refund to, for the "bank details needed" form. Only someone who may approve
 * refunds at the refund's hotel gets the list (anyone else sees "not found"). Nothing here moves money.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!z.guid().safeParse(id).success) return Response.json({ error: "not found" }, { status: 404 });

  const staff = await createClient();
  const { data: auth } = await staff.auth.getUser();
  if (!auth.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { data: refund } = await staff
    .from("refunds")
    .select("id, property_id, currency, refund_status, needs_bank_details")
    .eq("id", id)
    .maybeSingle<{ id: string; property_id: string; currency: string; refund_status: string; needs_bank_details: boolean }>();
  if (!refund) return Response.json({ error: "not found" }, { status: 404 });
  const { data: allowed } = await staff.rpc("has_permission", { p_property: refund.property_id, p_permission: "refund.approve" });
  if (allowed !== true) return Response.json({ error: "not found" }, { status: 404 });
  if (refund.refund_status !== "processing" || !refund.needs_bank_details) return Response.json({ error: "INVALID_STATE" }, { status: 409 });

  try {
    const service = createServiceClient();
    const { data, error } = await service.rpc("refund_payout_context", { p_refund_id: id });
    if (error) throw new Error(error.message);
    const secret = resolveProviderSecret((data as { secret_reference: string }).secret_reference);
    const banks = await listBanks(refund.currency, secret);
    return Response.json({ banks, currency: refund.currency });
  } catch (e) {
    console.error("[refund-banks] failed", { refundId: id, message: e instanceof Error ? e.message : "" });
    return Response.json({ error: "could not load banks" }, { status: 502 });
  }
}
