"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, fail, ok, staffClient } from "./action-helpers";

const PAGE = "/app/waitlist";

/** Marks a waiting-list request contacted, waiting again, or closed. The database checks reservation.modify at that hotel. */
export async function setWaitlistStatus(formData: FormData) {
  const parsed = z.object({ id: z.guid(), status: z.enum(["waiting", "contacted", "closed"]) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(PAGE, { err: "bad_request" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("waitlist_set_status", { p_id: parsed.data.id, p_status: parsed.data.status });
  if (error) return fail(PAGE, error.message);
  revalidatePath(PAGE);
  return ok(PAGE, "waitlist_updated");
}
