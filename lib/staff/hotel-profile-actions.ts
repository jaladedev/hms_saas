"use server";

import { revalidatePath } from "next/cache";
import { back, ok, staffClient } from "./action-helpers";
import { parseDecision } from "./guest-reviews";
import { parseOfferForm } from "./hotel-offers";
import { parseExtrasForm } from "./hotel-extras";
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

/**
 * Saves the hotel's facilities and its Instagram and Facebook links (migration 105). A typed @name becomes the stored link first.
 * Same permission as the other hotel forms: the database function requires property.configure and answers NOT_FOUND to anyone else.
 */
export async function saveHotelExtras(formData: FormData) {
  const v = parseExtrasForm(Object.fromEntries(formData));
  if (!v.ok) return back(PAGE, { err: v.code });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("set_hotel_extras", {
    p_property: v.value.propertyId,
    p_facilities: v.value.facilities,
    p_instagram: v.value.instagram ?? "",
    p_facebook: v.value.facebook ?? "",
  });
  if (error)
    return back(PAGE, {
      err: /NOT_FOUND/.test(error.message)
        ? "setup_forbidden"
        : /POLICY_VIOLATION/.test(error.message)
          ? "setup_invalid"
          : classifySetupError(error),
    });
  revalidatePath(PAGE);
  revalidatePath("/");
  return ok(PAGE, "hotel_extras_saved");
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

const OFFERS_PAGE = "/app/settings/offers";

function offerError(
  message: string,
  code?: string,
): "setup_forbidden" | "offer_invalid" | "offer_dates" | "offer_limit" | ReturnType<typeof classifySetupError> {
  if (/NOT_FOUND/.test(message)) return "setup_forbidden";
  if (/POLICY_VIOLATION: dates/.test(message)) return "offer_dates";
  if (/POLICY_VIOLATION: limit/.test(message)) return "offer_limit";
  if (/POLICY_VIOLATION: (title|text|badge)/.test(message)) return "offer_invalid";
  return classifySetupError({ message, code });
}

/** Creates or edits an offer for the guest homepage (migration 102). The database requires property.configure at that hotel. */
export async function saveHotelOffer(formData: FormData) {
  const v = parseOfferForm(Object.fromEntries(formData));
  if (!v.ok) return back(OFFERS_PAGE, { err: v.code });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("save_hotel_offer", {
    p_property: v.value.propertyId,
    p_offer: v.value.offerId as string,
    p_title: v.value.title,
    p_body: v.value.body,
    p_badge: v.value.badge,
    p_valid_from: (v.value.validFrom || null) as string,
    p_valid_to: (v.value.validTo || null) as string,
    p_active: v.value.active,
    p_sort: v.value.sort,
  });
  if (error) return back(OFFERS_PAGE, { err: offerError(error.message, error.code) });
  revalidatePath(OFFERS_PAGE);
  revalidatePath("/");
  return ok(OFFERS_PAGE, "offer_saved");
}

/** Deletes an offer. */
export async function deleteHotelOffer(formData: FormData) {
  const id = String(formData.get("offerId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return back(OFFERS_PAGE, { err: "offer_invalid" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("delete_hotel_offer", { p_offer: id });
  if (error) return back(OFFERS_PAGE, { err: offerError(error.message, error.code) });
  revalidatePath(OFFERS_PAGE);
  revalidatePath("/");
  return ok(OFFERS_PAGE, "offer_deleted");
}

const REVIEWS_PAGE = "/app/settings/reviews";

/** Approves or rejects a guest review (migration 104). The database requires property.configure at that hotel. */
export async function moderateGuestReview(formData: FormData) {
  const id = String(formData.get("reviewId") ?? "");
  const decision = parseDecision(formData.get("decision"));
  if (!/^[0-9a-f-]{36}$/i.test(id) || !decision) return back(REVIEWS_PAGE, { err: "review_invalid" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("moderate_guest_review", { p_review: id, p_decision: decision });
  if (error) return back(REVIEWS_PAGE, { err: /NOT_FOUND/.test(error.message) ? "setup_forbidden" : classifySetupError(error) });
  revalidatePath(REVIEWS_PAGE);
  revalidatePath("/");
  return ok(REVIEWS_PAGE, decision === "approved" ? "review_approved" : "review_rejected");
}
