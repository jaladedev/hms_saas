"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, fail, ok, staffClient } from "./action-helpers";

const PAGE = "/app/messages";

/** Marks a guest message handled, or new again. The database checks reservation.modify at that hotel. */
export async function setMessageStatus(formData: FormData) {
  const parsed = z.object({ id: z.guid(), status: z.enum(["new", "handled"]) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(PAGE, { err: "bad_request" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("contact_message_set_status", { p_id: parsed.data.id, p_status: parsed.data.status });
  if (error) return fail(PAGE, error.message);
  revalidatePath(PAGE);
  return ok(PAGE, "contact_updated");
}
