"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { parseAmountToMinor } from "./money-input";
import { classifyRpcError, type OkCode } from "./refunds";

/**
 * Staff refund actions. Each runs as the signed-in person (never the service role), so the database
 * decides who may do what: permission, self-approval, state. These functions only carry the request
 * and turn the answer into a redirect with a short code the page can explain.
 *
 * Every form carries an idempotency key made when the page rendered. Submitting twice (double click,
 * browser retry) returns the first answer instead of acting twice.
 */

const REFUNDS_PAGE = "/app/refunds";
const key = z.string().min(8).max(100);
const uuid = z.guid();

function back(path: string, params: Record<string, string | number>): never {
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])));
  redirect(`${path}?${qs.toString()}`);
}
const ok = (path: string, code: OkCode): never => back(path, { ok: code });
function fail(path: string, message: string): never {
  const c = classifyRpcError(message);
  return back(path, c.refundableMinor !== undefined ? { err: c.code, n: c.refundableMinor } : { err: c.code });
}

async function staffClient() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");
  return supabase;
}

export async function decideRefund(formData: FormData) {
  const parsed = z.object({
    refundId: uuid, idempotencyKey: key, decision: z.enum(["approve", "reject"]),
    note: z.string().max(500).optional(),
  }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(REFUNDS_PAGE, { err: "bad_request" });
  const { refundId, idempotencyKey, decision, note } = parsed.data;
  if (decision === "reject" && !note?.trim()) return back(REFUNDS_PAGE, { err: "note_required" });

  const supabase = await staffClient();
  const { error } = await supabase.rpc("approve_refund", {
    p_refund_id: refundId, p_approve: decision === "approve", p_note: note?.trim() || null, p_idempotency_key: idempotencyKey,
  });
  if (error) return fail(REFUNDS_PAGE, error.message);
  revalidatePath(REFUNDS_PAGE);
  return ok(REFUNDS_PAGE, decision === "approve" ? "approved" : "rejected");
}

export async function recordManualPayout(formData: FormData) {
  const parsed = z.object({
    refundId: uuid, idempotencyKey: key, payoutReference: z.string().max(200).optional(),
  }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(REFUNDS_PAGE, { err: "bad_request" });

  const supabase = await staffClient();
  const { error } = await supabase.rpc("record_manual_refund", {
    p_refund_id: parsed.data.refundId, p_payout_reference: parsed.data.payoutReference?.trim() || null,
    p_idempotency_key: parsed.data.idempotencyKey,
  });
  if (error) return fail(REFUNDS_PAGE, error.message);
  revalidatePath(REFUNDS_PAGE);
  return ok(REFUNDS_PAGE, "paid_out");
}

export async function requestRefund(formData: FormData) {
  const parsed = z.object({
    reservationId: uuid, paymentId: uuid, idempotencyKey: key,
    amount: z.string().max(40), reason: z.string().max(500),
  }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(REFUNDS_PAGE, { err: "bad_request" });
  const page = `/app/reservations/${parsed.data.reservationId}/settlement`;

  const minor = parseAmountToMinor(parsed.data.amount);
  if (minor === null) return back(page, { err: "amount_invalid" });
  if (!parsed.data.reason.trim()) return back(page, { err: "reason_required" });

  const supabase = await staffClient();
  const { error } = await supabase.rpc("request_refund", {
    p_payment_id: parsed.data.paymentId, p_amount_minor: minor, p_reason: parsed.data.reason.trim(),
    p_idempotency_key: parsed.data.idempotencyKey,
  });
  if (error) return fail(page, error.message);
  revalidatePath(page);
  revalidatePath(REFUNDS_PAGE);
  return ok(page, "requested");
}
