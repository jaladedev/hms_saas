"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, fail, ok, staffClient } from "./action-helpers";
import { checkGuestForm } from "./guests";

/** Saves a guest's contact details through update_guest (permission, validation and audit are in the database). */
export async function updateGuest(formData: FormData) {
  const parsed = z.object({
    guestId: z.guid(), full_name: z.string().max(400), email: z.string().max(400), phone: z.string().max(400),
    address: z.string().max(1000), country_code: z.string().max(10),
  }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back("/app/guests", { err: "bad_request" });
  const { guestId, ...form } = parsed.data;
  const page = `/app/guests/${guestId}`;
  const problem = checkGuestForm(form);
  if (problem) return back(page, { err: problem });

  const supabase = await staffClient();
  const { error } = await supabase.rpc("update_guest", {
    p_guest: guestId, p_full_name: form.full_name, p_email: form.email, p_phone: form.phone, p_address: form.address, p_country_code: form.country_code,
  });
  if (error) return fail(page, error.message);
  revalidatePath(page);
  revalidatePath("/app/guests");
  return ok(page, "guest_updated");
}
