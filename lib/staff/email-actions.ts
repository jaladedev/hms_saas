"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { drainNow } from "@/lib/email/server";
import { back, fail, ok, staffClient } from "./action-helpers";

const EMAILS_PAGE = "/app/emails";

/**
 * Puts a failed guest email back in the queue as the signed-in person (reservation.modify at that hotel is
 * checked in the database). The send itself is started in the background right away; the maintenance
 * route is the backstop, so nothing here waits on the mail provider.
 */
export async function resendEmail(formData: FormData) {
  const parsed = z.object({ emailId: z.guid() }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(EMAILS_PAGE, { err: "bad_request" });

  const supabase = await staffClient();
  const { error } = await supabase.rpc("resend_email", { p_email_id: parsed.data.emailId });
  if (error) return fail(EMAILS_PAGE, error.message);

  after(() => { drainNow(5).catch(() => {}); });
  revalidatePath(EMAILS_PAGE);
  return ok(EMAILS_PAGE, "resent");
}
