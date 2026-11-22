"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, ok, staffClient } from "./action-helpers";
import { classifyReceiptError, RECEIPT_BUCKET, receiptPath, validateReceipt } from "./payment-receipts";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Receipts on a payment (migration 178). Adding: the row is written first, as the signed-in person, so the table's own
 * row-level security (payment.record) and its limits (3 files, the payment's own property) decide; only then is the file stored
 * with the service key at the path the row names, and if storing fails the row is withdrawn. Removing works the other way round,
 * after the person's permission has been checked: the file goes first, so a failure leaves the row and an error, never a file
 * nobody can find. Neither touches the payment itself.
 */

const uuid = z.guid();
const LIST = "/app/payments";
const pageOf = (paymentId: string) => `${LIST}/${paymentId}`;

export async function addPaymentReceipt(formData: FormData) {
  const paymentId = uuid.safeParse(formData.get("paymentId"));
  if (!paymentId.success) return back(LIST, { err: "bad_request" });
  const PAGE = pageOf(paymentId.data);
  const file = formData.get("receipt");
  const check = validateReceipt(file instanceof File ? file : null);
  if (!check.ok) return back(PAGE, { err: check.code });

  const supabase = await staffClient();
  // Row-level security hides a payment from anyone who may not see money, so "not found" covers both cases.
  const { data: pay } = await supabase.from("payments").select("id, tenant_id, property_id").eq("id", paymentId.data).maybeSingle();
  if (!pay) return back(LIST, { err: "not_found" });

  const path = receiptPath(pay.tenant_id, pay.property_id, pay.id, randomUUID(), check.ext);
  const { data: row, error } = await supabase
    .from("payment_receipts")
    .insert({
      tenant_id: pay.tenant_id,
      property_id: pay.property_id,
      payment_id: pay.id,
      storage_path: path,
      content_type: check.contentType,
      size_bytes: (file as File).size,
    })
    .select("id")
    .single();
  if (error || !row) return back(PAGE, { err: classifyReceiptError(error ?? {}) });

  const service = createServiceClient();
  const { error: upErr } = await service.storage
    .from(RECEIPT_BUCKET)
    .upload(path, await (file as File).arrayBuffer(), { contentType: check.contentType });
  if (upErr) {
    await supabase.from("payment_receipts").delete().eq("id", row.id);
    return back(PAGE, { err: "receipt_storage" });
  }
  revalidatePath(PAGE);
  return ok(PAGE, "receipt_added");
}

export async function removePaymentReceipt(formData: FormData) {
  const id = uuid.safeParse(formData.get("receiptId"));
  if (!id.success) return back(LIST, { err: "bad_request" });
  const supabase = await staffClient();
  const { data: row } = await supabase
    .from("payment_receipts")
    .select("id, payment_id, property_id, storage_path")
    .eq("id", id.data)
    .maybeSingle();
  if (!row) return back(LIST, { err: "not_found" });
  const PAGE = pageOf(row.payment_id);

  // Checked BEFORE the file is touched: a person who may see a receipt but not remove it must not lose the file to a refused delete.
  const { data: allowed } = await supabase.rpc("has_permission", { p_property: row.property_id, p_permission: "payment.record" });
  if (allowed !== true) return back(PAGE, { err: "receipt_forbidden" });

  const service = createServiceClient();
  const { error: rmErr } = await service.storage.from(RECEIPT_BUCKET).remove([row.storage_path]);
  if (rmErr) return back(PAGE, { err: "receipt_storage" });

  const { data: gone, error } = await supabase.from("payment_receipts").delete().eq("id", row.id).select("id");
  if (error) return back(PAGE, { err: classifyReceiptError(error) });
  if (!gone || gone.length === 0) return back(PAGE, { err: "receipt_forbidden" });
  revalidatePath(PAGE);
  return ok(PAGE, "receipt_removed");
}
