"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, fail, ok, staffClient } from "./action-helpers";

const PAGE = "/app/payments";

/** Marks a manual payment verified as the signed-in person (payment.verify at that hotel is checked in the database). */
export async function verifyPayment(formData: FormData) {
  const parsed = z.object({ paymentId: z.guid(), note: z.string().max(500).optional() }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(PAGE, { err: "bad_request" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("verify_payment", { p_payment_id: parsed.data.paymentId, p_note: parsed.data.note?.trim() || undefined });
  if (error) return fail(PAGE, error.message);
  revalidatePath(PAGE);
  revalidatePath("/app", "layout");
  return ok(PAGE, "verified");
}
