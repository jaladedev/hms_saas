"use server";

import { revalidatePath } from "next/cache";
import { back, ok, staffClient } from "./action-helpers";
import { parseProfileForm } from "./hotel-profile";
import { classifySetupError } from "./room-setup";

/**
 * Saves the hotel's public profile (migration 087). Runs as the signed-in person; the database function requires
 * property.configure at that hotel and answers NOT_FOUND to anyone else, which is shown as a permission refusal.
 */

const PAGE = "/app/settings/hotel";

export async function saveHotelProfile(formData: FormData) {
  const v = parseProfileForm(Object.fromEntries(formData));
  if (!v.ok) return back(PAGE, { err: v.code });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("update_hotel_profile", {
    p_property: v.value.propertyId, p_phone: v.value.phone ?? "", p_email: v.value.email ?? "", p_intro: v.value.intro ?? "",
  });
  if (error) return back(PAGE, { err: /NOT_FOUND/.test(error.message) ? "setup_forbidden" : classifySetupError(error) });
  revalidatePath(PAGE);
  revalidatePath("/");
  return ok(PAGE, "hotel_profile_saved");
}
