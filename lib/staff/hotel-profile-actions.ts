"use server";

import { revalidatePath } from "next/cache";
import { back, ok, staffClient } from "./action-helpers";
import { parseBasicsForm, parseProfileForm } from "./hotel-profile";
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

/** Saves the hotel's name, address, town, state and check-in and check-out times (migration 089). Same permission as above. */
export async function saveHotelBasics(formData: FormData) {
  const v = parseBasicsForm(Object.fromEntries(formData));
  if (!v.ok) return back(PAGE, { err: v.code });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("update_hotel_basics", {
    p_property: v.value.propertyId, p_name: v.value.name, p_address: v.value.address ?? "", p_city: v.value.city, p_state: v.value.state,
    p_check_in: v.value.checkIn, p_check_out: v.value.checkOut,
  });
  if (error) return back(PAGE, { err: /NOT_FOUND/.test(error.message) ? "setup_forbidden" : classifySetupError(error) });
  revalidatePath(PAGE);
  revalidatePath("/", "layout");
  return ok(PAGE, "hotel_basics_saved");
}
