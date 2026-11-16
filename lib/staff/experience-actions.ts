"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, fail, ok, staffClient } from "./action-helpers";

const PAGE = "/app/experiences";

/**
 * Confirms, declines or posts to the folio a guest's experience request. The database checks folio.charge at that hotel, and that a
 * request is only posted once the guest is checked in or out.
 */
export async function setExperienceRequest(formData: FormData) {
  const parsed = z
    .object({ id: z.guid(), action: z.enum(["confirm", "decline", "charge"]), key: z.string().min(8).max(100) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(PAGE, { err: "bad_request" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("experience_request_set", {
    p_request: parsed.data.id,
    p_action: parsed.data.action,
    p_key: parsed.data.key,
  });
  if (error) {
    if (
      /INVALID_STATE: (checked_in|checked_out|confirmed|pending|cancelled|no_show|expired)/.test(error.message) &&
      parsed.data.action === "charge"
    ) {
      return back(PAGE, { err: "experience_not_in_house" });
    }
    return fail(PAGE, error.message);
  }
  revalidatePath(PAGE);
  return ok(
    PAGE,
    parsed.data.action === "confirm"
      ? "experience_confirmed"
      : parsed.data.action === "decline"
        ? "experience_declined"
        : "experience_charged",
  );
}
