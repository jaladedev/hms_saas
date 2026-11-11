"use server";

import { revalidatePath } from "next/cache";
import { back, ok, staffClient } from "./action-helpers";
import { parseBasicsForm, parseProfileForm, parseThemeForm } from "./hotel-profile";
import { logoPath, PHOTO_BUCKET, validatePhoto } from "./room-photos";
import { classifySetupError } from "./room-setup";
import { createServiceClient } from "@/lib/supabase/service";
import { randomUUID } from "node:crypto";

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
    p_property: v.value.propertyId,
    p_phone: v.value.phone ?? "",
    p_email: v.value.email ?? "",
    p_intro: v.value.intro ?? "",
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
    p_property: v.value.propertyId,
    p_name: v.value.name,
    p_address: v.value.address ?? "",
    p_city: v.value.city,
    p_state: v.value.state,
    p_check_in: v.value.checkIn,
    p_check_out: v.value.checkOut,
  });
  if (error) return back(PAGE, { err: /NOT_FOUND/.test(error.message) ? "setup_forbidden" : classifySetupError(error) });
  revalidatePath(PAGE);
  revalidatePath("/", "layout");
  return ok(PAGE, "hotel_basics_saved");
}

/**
 * Sets the hotel's logo (migration 090): checks the file, stores it with the service key, then records its path as the signed-in
 * person. If the database refuses (no permission), the stored file is removed again. The old logo's file is queued for removal by
 * the database and deleted by the maintenance job.
 */
export async function uploadHotelLogo(formData: FormData) {
  const id = parseProfileForm({ propertyId: formData.get("propertyId") });
  if (!id.ok) return back(PAGE, { err: id.code });
  const file = formData.get("logo");
  const check = validatePhoto(file instanceof File ? file : null, "");
  if (!check.ok) return back(PAGE, { err: check.code });

  const supabase = await staffClient();
  const { data: prop } = await supabase.from("properties").select("tenant_id").eq("id", id.value.propertyId).maybeSingle();
  if (!prop) return back(PAGE, { err: "setup_forbidden" });

  const path = logoPath(prop.tenant_id, id.value.propertyId, randomUUID(), check.ext);
  const service = createServiceClient();
  const { error: upErr } = await service.storage
    .from(PHOTO_BUCKET)
    .upload(path, await (file as File).arrayBuffer(), { contentType: check.contentType });
  if (upErr) return back(PAGE, { err: "photo_upload" });
  const { error } = await supabase.rpc("set_hotel_logo", { p_property: id.value.propertyId, p_path: path });
  if (error) {
    await service.storage.from(PHOTO_BUCKET).remove([path]);
    return back(PAGE, { err: /NOT_FOUND/.test(error.message) ? "setup_forbidden" : classifySetupError(error) });
  }
  revalidatePath(PAGE);
  revalidatePath("/", "layout");
  return ok(PAGE, "hotel_logo_saved");
}

/** Removes the hotel's logo; its file is deleted by the maintenance job. */
export async function removeHotelLogo(formData: FormData) {
  const id = parseProfileForm({ propertyId: formData.get("propertyId") });
  if (!id.ok) return back(PAGE, { err: id.code });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("set_hotel_logo", { p_property: id.value.propertyId, p_path: "" });
  if (error) return back(PAGE, { err: /NOT_FOUND/.test(error.message) ? "setup_forbidden" : classifySetupError(error) });
  revalidatePath(PAGE);
  revalidatePath("/", "layout");
  return ok(PAGE, "hotel_logo_removed");
}

/**
 * Saves the hotel's look (migration 093): the guest website and the staff screens for this hotel follow it. Same permission as
 * the rest of this page. "Standard" clears the choice.
 */
export async function saveHotelTheme(formData: FormData) {
  const v = parseThemeForm(Object.fromEntries(formData));
  if (!v.ok) return back(PAGE, { err: v.code });
  const supabase = await staffClient();
  const themed = await supabase.rpc("set_hotel_theme", { p_property: v.value.propertyId, p_theme: v.value.theme ?? "" });
  const colored = themed.error
    ? themed
    : await supabase.rpc("set_hotel_primary_color", { p_property: v.value.propertyId, p_color: v.value.primary ?? "" });
  const fonted = colored.error
    ? colored
    : await supabase.rpc("set_hotel_fonts", {
        p_property: v.value.propertyId,
        p_display: v.value.fontDisplay ?? "",
        p_body: v.value.fontBody ?? "",
      });
  const error = fonted.error;
  if (error) return back(PAGE, { err: /NOT_FOUND/.test(error.message) ? "setup_forbidden" : classifySetupError(error) });
  revalidatePath(PAGE);
  revalidatePath("/", "layout");
  revalidatePath("/app", "layout");
  return ok(PAGE, "hotel_theme_saved");
}
