"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, ok, staffClient } from "./action-helpers";
import { classifyDiscountError, parseDiscountForm, resultCode } from "./discount";

/**
 * Sets, changes or removes the discount on a booking, as a percentage (migration 058) or a fixed amount (migration 062). Runs as the signed-in person, never the
 * service role, so the database decides who may do it (`discount.apply`), how far (the cap for their role), and whether the
 * booking can still change (confirmed, nothing paid, no live invoice). The form carries an idempotency key made when the
 * page rendered, so a double click returns the first answer.
 */

const LIST = "/app/reservations";
const ids = z.object({ reservationId: z.guid(), idempotencyKey: z.string().min(8).max(100) });

export async function setDiscount(formData: FormData) {
  const raw = Object.fromEntries(formData);
  const head = ids.safeParse(raw);
  if (!head.success) return back(LIST, { err: "bad_request" });
  const page = `${LIST}/${head.data.reservationId}`;

  const v = parseDiscountForm(raw);
  if (!v.ok) return back(page, { err: v.code });

  const supabase = await staffClient();
  const { data, error } =
    v.value.kind === "amount"
      ? await supabase.rpc("apply_discount_amount", {
          p_reservation_id: head.data.reservationId,
          p_amount_minor: v.value.amountMinor,
          p_reason: v.value.reason,
          p_idempotency_key: head.data.idempotencyKey,
        })
      : await supabase.rpc("apply_discount", {
          p_reservation_id: head.data.reservationId,
          p_percent: v.value.percent,
          p_reason: v.value.reason,
          p_idempotency_key: head.data.idempotencyKey,
        });
  if (error) return back(page, { err: classifyDiscountError(error.message) });

  revalidatePath(page);
  revalidatePath(`${page}/settlement`);
  revalidatePath(LIST);
  return ok(page, resultCode(data));
}
