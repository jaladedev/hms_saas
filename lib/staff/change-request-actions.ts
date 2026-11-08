"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, fail, ok, staffClient } from "./action-helpers";

const PAGE = "/app/requests";

/**
 * Answers a guest's change request as the signed-in person (reservation.modify at that hotel is checked in the database).
 * "done" means the staff member has already made the change on the booking; "declined" needs a note the guest will read.
 */
export async function resolveChangeRequest(formData: FormData) {
  const parsed = z.object({ requestId: z.guid(), outcome: z.enum(["done", "declined"]), note: z.string().max(500) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(PAGE, { err: "bad_request" });
  const note = parsed.data.note.trim();
  if (parsed.data.outcome === "declined" && !note) return back(PAGE, { err: "request_note" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("resolve_change_request", { p_request_id: parsed.data.requestId, p_outcome: parsed.data.outcome, p_note: note });
  if (error) return fail(PAGE, error.message);
  revalidatePath(PAGE);
  revalidatePath("/app", "layout");
  return ok(PAGE, parsed.data.outcome === "done" ? "request_done" : "request_declined");
}
