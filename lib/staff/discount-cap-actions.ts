"use server";

import { revalidatePath } from "next/cache";
import { back, ok, staffClient } from "./action-helpers";
import { capResultCode, classifyCapError, parseCapForm } from "./discount-caps";

/**
 * Sets one role's discount limit for one hotel, or puts it back to the default (migration 059). Runs as the signed-in person,
 * never the service role, so the database decides who may (the owner, `staff.manage`) and which roles can have a limit.
 * Setting the same value again changes nothing and is not audited.
 */

const PAGE = "/app/settings/discounts";

export async function setDiscountCap(formData: FormData) {
  const v = parseCapForm(Object.fromEntries(formData));
  if (!v.ok) return back(PAGE, { err: v.code });

  const supabase = await staffClient();
  const { data, error } = await supabase.rpc("set_discount_cap", {
    p_property_id: v.value.property,
    p_role_key: v.value.role,
    p_percent: v.value.percent,
  });
  if (error) return back(PAGE, { err: classifyCapError(error.message) });

  revalidatePath(PAGE);
  revalidatePath("/app/reservations/[id]", "page");
  return ok(PAGE, capResultCode(data));
}
