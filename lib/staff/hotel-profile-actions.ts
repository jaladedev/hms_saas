"use server";

import { revalidatePath } from "next/cache";
import { back, ok, staffClient } from "./action-helpers";
import { parseDecision } from "./guest-reviews";
import { parsePromoForm } from "./promo-codes";
import { parseOfferForm } from "./hotel-offers";
import { parseExperienceForm } from "./experiences";
import { parsePlaceForm } from "./hotel-places";
import { parseReminderForm } from "./arrival-reminders";
import { parseExtrasForm } from "./hotel-extras";
import { parseBasicsForm, parseProfileForm, parseThemeForm, type ThemeForm } from "./hotel-profile";
import { classifyThemeDraftError, isThemeImageKind, themeImagePath, validateThemeImage } from "./theme-images";
import { extraPhotoPath, logoPath, PHOTO_BUCKET, validatePhoto } from "./room-photos";
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

/** Turns the automatic "a room may be free" email for waiting guests on or off (migration 130). Same permission as the other hotel forms. */
export async function saveWaitlistEmail(formData: FormData) {
  const propertyId = formData.get("propertyId");
  const enabled = formData.get("enabled") === "on";
  if (typeof propertyId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(propertyId)) {
    return back(PAGE, { err: "setup_invalid" });
  }
  const supabase = await staffClient();
  const { error } = await supabase.rpc("set_waitlist_email", { p_property: propertyId, p_enabled: enabled });
  if (error) return back(PAGE, { err: /NOT_FOUND/.test(error.message) ? "setup_forbidden" : classifySetupError(error) });
  revalidatePath(PAGE);
  return ok(PAGE, enabled ? "hotel_waitlist_email_on" : "hotel_waitlist_email_off");
}

/** Sets the address that gets the morning summary (migration 129); empty turns it off. Same permission as the other hotel forms. */
export async function saveDailyDigest(formData: FormData) {
  const propertyId = formData.get("propertyId");
  const email = formData.get("email");
  if (
    typeof propertyId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(propertyId) ||
    typeof email !== "string"
  ) {
    return back(PAGE, { err: "setup_invalid" });
  }
  const supabase = await staffClient();
  const { error } = await supabase.rpc("set_daily_digest", { p_property: propertyId, p_email: email });
  if (error) {
    return back(PAGE, {
      err: /NOT_FOUND/.test(error.message)
        ? "setup_forbidden"
        : /INVALID_EMAIL/.test(error.message)
          ? "digest_email"
          : classifySetupError(error),
    });
  }
  revalidatePath(PAGE);
  return ok(PAGE, email.trim() ? "hotel_digest_on" : "hotel_digest_off");
}

/** Turns the review request email (sent after check-out, migration 128) on or off. Same permission as the other hotel forms. */
export async function saveReviewRequest(formData: FormData) {
  const propertyId = formData.get("propertyId");
  const enabled = formData.get("enabled") === "on";
  if (typeof propertyId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(propertyId)) {
    return back(PAGE, { err: "setup_invalid" });
  }
  const supabase = await staffClient();
  const { error } = await supabase.rpc("set_review_request", { p_property: propertyId, p_enabled: enabled });
  if (error) return back(PAGE, { err: /NOT_FOUND/.test(error.message) ? "setup_forbidden" : classifySetupError(error) });
  revalidatePath(PAGE);
  return ok(PAGE, enabled ? "hotel_review_request_on" : "hotel_review_request_off");
}

/** Turns the arrival reminder email on (1 to 7 days before arrival) or off (migration 122). Same permission as the other hotel forms. */
export async function saveArrivalReminder(formData: FormData) {
  const v = parseReminderForm(Object.fromEntries(formData));
  if (!v.ok) return back(PAGE, { err: v.code });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("set_arrival_reminder_days", { p_property: v.value.propertyId, p_days: v.value.days as number });
  if (error)
    return back(PAGE, {
      err: /NOT_FOUND/.test(error.message)
        ? "setup_forbidden"
        : /INVALID_DAYS/.test(error.message)
          ? "setup_invalid"
          : classifySetupError(error),
    });
  revalidatePath(PAGE);
  return ok(PAGE, "hotel_reminder_saved");
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
 * The hotel's look is a DRAFT until it is published (migrations 093 to 118 set it live at once; migration 182 puts a draft between).
 * Saving the form stores the theme, main colour, fonts and corners in the draft; nothing on the website or the staff screens reads a
 * draft. "Save and publish" does both in one step. Same permission as the rest of this page, and the branding plan flag: the database
 * answers NOT_FOUND to anyone else, which is shown as a permission refusal.
 */
async function saveDraftFields(supabase: Awaited<ReturnType<typeof staffClient>>, v: ThemeForm) {
  return supabase.rpc("theme_draft_save", {
    p_property: v.propertyId,
    p_theme: v.theme ?? "",
    p_primary: v.primary ?? "",
    p_font_display: v.fontDisplay ?? "",
    p_font_body: v.fontBody ?? "",
    p_radius: v.radius ?? "",
  });
}

function themeFailure(error: { code?: string; message: string }) {
  const c = classifyThemeDraftError(error);
  return back(PAGE, { err: c === "unknown" ? classifySetupError(error) : c });
}

export async function saveThemeDraft(formData: FormData) {
  const v = parseThemeForm(Object.fromEntries(formData));
  if (!v.ok) return back(PAGE, { err: v.code });
  const supabase = await staffClient();
  const { error } = await saveDraftFields(supabase, v.value);
  if (error) return themeFailure(error);
  revalidatePath(PAGE);
  return ok(PAGE, "theme_draft_saved");
}

/** Saves the form into the draft and publishes the draft in one step (including any favicon or hero image already added to it). */
export async function saveAndPublishTheme(formData: FormData) {
  const v = parseThemeForm(Object.fromEntries(formData));
  if (!v.ok) return back(PAGE, { err: v.code });
  const supabase = await staffClient();
  const saved = await saveDraftFields(supabase, v.value);
  if (saved.error) return themeFailure(saved.error);
  const { error } = await supabase.rpc("theme_publish", { p_property: v.value.propertyId });
  if (error) return themeFailure(error);
  revalidatePath(PAGE);
  revalidatePath("/", "layout");
  revalidatePath("/app", "layout");
  return ok(PAGE, "theme_published");
}

/** Publishes the saved draft as it is. */
export async function publishThemeDraft(formData: FormData) {
  const id = parseProfileForm({ propertyId: formData.get("propertyId") });
  if (!id.ok) return back(PAGE, { err: id.code });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("theme_publish", { p_property: id.value.propertyId });
  if (error) return themeFailure(error);
  revalidatePath(PAGE);
  revalidatePath("/", "layout");
  revalidatePath("/app", "layout");
  return ok(PAGE, "theme_published");
}

/** Throws the draft away; the published look is untouched. Files only the draft used are removed by the maintenance job. */
export async function discardThemeDraft(formData: FormData) {
  const id = parseProfileForm({ propertyId: formData.get("propertyId") });
  if (!id.ok) return back(PAGE, { err: id.code });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("theme_draft_discard", { p_property: id.value.propertyId });
  if (error) return themeFailure(error);
  revalidatePath(PAGE);
  return ok(PAGE, "theme_draft_discarded");
}

/**
 * A favicon or hero image for the draft (migration 182): checks the file, stores it with the service key in the hotel's own folder,
 * then records its path in the draft as the signed-in person. If the database refuses, the stored file is removed again. A file the
 * draft stops using is queued for removal by the database (unless the published look still uses it).
 */
export async function uploadThemeImage(formData: FormData) {
  const id = parseProfileForm({ propertyId: formData.get("propertyId") });
  const kind = formData.get("kind");
  if (!id.ok || !isThemeImageKind(kind)) return back(PAGE, { err: "setup_invalid" });
  const file = formData.get("image");
  const check = validateThemeImage(kind, file instanceof File ? file : null);
  if (!check.ok) return back(PAGE, { err: check.code });

  const supabase = await staffClient();
  const { data: prop } = await supabase.from("properties").select("tenant_id").eq("id", id.value.propertyId).maybeSingle();
  if (!prop) return back(PAGE, { err: "setup_forbidden" });

  const path = themeImagePath(kind, prop.tenant_id, id.value.propertyId, randomUUID(), check.ext);
  const service = createServiceClient();
  const { error: upErr } = await service.storage
    .from(PHOTO_BUCKET)
    .upload(path, await (file as File).arrayBuffer(), { contentType: check.contentType });
  if (upErr) return back(PAGE, { err: "photo_upload" });
  const { error } = await supabase.rpc("theme_draft_set_image", { p_property: id.value.propertyId, p_kind: kind, p_path: path });
  if (error) {
    await service.storage.from(PHOTO_BUCKET).remove([path]);
    return themeFailure(error);
  }
  revalidatePath(PAGE);
  return ok(PAGE, "theme_image_saved");
}

/** Takes the favicon or hero image out of the draft (the published look keeps its own until the draft is published). */
export async function removeThemeImage(formData: FormData) {
  const id = parseProfileForm({ propertyId: formData.get("propertyId") });
  const kind = formData.get("kind");
  if (!id.ok || !isThemeImageKind(kind)) return back(PAGE, { err: "setup_invalid" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("theme_draft_set_image", { p_property: id.value.propertyId, p_kind: kind, p_path: "" });
  if (error) return themeFailure(error);
  revalidatePath(PAGE);
  return ok(PAGE, "theme_image_removed");
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

const PROMO_PAGE = "/app/settings/promo-codes";

function promoError(
  message: string,
): "setup_forbidden" | "promo_duplicate" | "promo_limit" | "promo_used" | "promo_flag" | "promo_invalid" | "promo_dates" {
  if (/NOT_FOUND/.test(message)) return "setup_forbidden";
  if (/POLICY_VIOLATION: duplicate/.test(message)) return "promo_duplicate";
  if (/POLICY_VIOLATION: limit/.test(message)) return "promo_limit";
  if (/INVALID_STATE: used/.test(message)) return "promo_used";
  if (/POLICY_VIOLATION: discounts off/.test(message)) return "promo_flag";
  if (/POLICY_VIOLATION: dates/.test(message)) return "promo_dates";
  return "promo_invalid";
}

/** Creates or edits a promo code (migration 131). The database requires property.configure at that hotel and the discounts flag. */
export async function savePromoCode(formData: FormData) {
  const v = parsePromoForm(Object.fromEntries(formData));
  if (!v.ok) return back(PROMO_PAGE, { err: v.code });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("save_promo_code", {
    p_property: v.value.propertyId,
    p_promo: v.value.promoId as string,
    p_code: v.value.code,
    p_kind: v.value.kind,
    p_value: v.value.value,
    p_valid_from: (v.value.validFrom || null) as string,
    p_valid_to: (v.value.validTo || null) as string,
    p_min_nights: v.value.minNights,
    p_max_uses: v.value.maxUses as number,
    p_active: v.value.active,
  });
  if (error) return back(PROMO_PAGE, { err: promoError(error.message) });
  revalidatePath(PROMO_PAGE);
  return ok(PROMO_PAGE, "promo_saved");
}

/** Deletes a promo code no booking has used. */
export async function deletePromoCode(formData: FormData) {
  const id = String(formData.get("promoId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return back(PROMO_PAGE, { err: "promo_invalid" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("delete_promo_code", { p_promo: id });
  if (error) return back(PROMO_PAGE, { err: promoError(error.message) });
  revalidatePath(PROMO_PAGE);
  return ok(PROMO_PAGE, "promo_deleted");
}

const PLACES_PAGE = "/app/settings/places";

function placeError(
  message: string,
  code?: string,
): "setup_forbidden" | "place_invalid" | "place_limit" | ReturnType<typeof classifySetupError> {
  if (/NOT_FOUND/.test(message)) return "setup_forbidden";
  if (/POLICY_VIOLATION: limit/.test(message)) return "place_limit";
  if (/POLICY_VIOLATION: (name|text|category|link)/.test(message)) return "place_invalid";
  return classifySetupError({ message, code });
}

/** Creates or edits a "near the hotel" place for the guest homepage (migration 119). The database requires property.configure there. */
export async function saveHotelPlace(formData: FormData) {
  const v = parsePlaceForm(Object.fromEntries(formData));
  if (!v.ok) return back(PLACES_PAGE, { err: v.code });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("save_hotel_place", {
    p_property: v.value.propertyId,
    p_place: v.value.placeId as string,
    p_name: v.value.name,
    p_body: v.value.body,
    p_active: v.value.active,
    p_sort: v.value.sort,
    p_category: v.value.category,
    p_link: v.value.link === "" ? (null as unknown as string) : v.value.link,
  });
  if (error) return back(PLACES_PAGE, { err: placeError(error.message, error.code) });
  revalidatePath(PLACES_PAGE);
  revalidatePath("/");
  return ok(PLACES_PAGE, "place_saved");
}

/** Deletes a place. */
export async function deleteHotelPlace(formData: FormData) {
  const id = String(formData.get("placeId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return back(PLACES_PAGE, { err: "place_invalid" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("delete_hotel_place", { p_place: id });
  if (error) return back(PLACES_PAGE, { err: placeError(error.message, error.code) });
  revalidatePath(PLACES_PAGE);
  revalidatePath("/");
  return ok(PLACES_PAGE, "place_deleted");
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

const EXPERIENCES_PAGE = "/app/settings/experiences";

function experienceError(
  message: string,
  code?: string,
): "setup_forbidden" | "experience_invalid" | "experience_limit" | "experience_used" | ReturnType<typeof classifySetupError> {
  if (/NOT_FOUND/.test(message)) return "setup_forbidden";
  if (/POLICY_VIOLATION: limit/.test(message)) return "experience_limit";
  if (/INVALID_STATE: used/.test(message)) return "experience_used";
  if (/POLICY_VIOLATION: (name|text|price|unit)/.test(message)) return "experience_invalid";
  return classifySetupError({ message, code });
}

/** Creates or edits an experience a guest can ask for (migration 134). The database requires property.configure there. */
export async function saveHotelExperience(formData: FormData) {
  const v = parseExperienceForm(Object.fromEntries(formData));
  if (!v.ok) return back(EXPERIENCES_PAGE, { err: v.code });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("save_hotel_experience", {
    p_property: v.value.propertyId,
    p_experience: v.value.experienceId as string,
    p_name: v.value.name,
    p_body: v.value.body,
    p_price: v.value.priceMinor,
    p_unit: v.value.unit,
    p_active: v.value.active,
    p_sort: v.value.sort,
  });
  if (error) return back(EXPERIENCES_PAGE, { err: experienceError(error.message, error.code) });
  revalidatePath(EXPERIENCES_PAGE);
  revalidatePath("/");
  return ok(EXPERIENCES_PAGE, "experience_saved");
}

/** Deletes an experience nobody has asked for; one with requests can only be switched off. */
export async function deleteHotelExperience(formData: FormData) {
  const id = String(formData.get("experienceId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return back(EXPERIENCES_PAGE, { err: "experience_invalid" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("delete_hotel_experience", { p_experience: id });
  if (error) return back(EXPERIENCES_PAGE, { err: experienceError(error.message, error.code) });
  revalidatePath(EXPERIENCES_PAGE);
  revalidatePath("/");
  return ok(EXPERIENCES_PAGE, "experience_deleted");
}

type PhotoTarget = {
  kind: "places" | "experiences";
  table: "hotel_places" | "hotel_experiences";
  rpc: "set_place_photo" | "set_experience_photo";
  page: string;
};
const PLACE_TARGET: PhotoTarget = { kind: "places", table: "hotel_places", rpc: "set_place_photo", page: PLACES_PAGE };
const EXPERIENCE_TARGET: PhotoTarget = {
  kind: "experiences",
  table: "hotel_experiences",
  rpc: "set_experience_photo",
  page: EXPERIENCES_PAGE,
};

async function storeExtraPhoto(t: PhotoTarget, formData: FormData, saved: "place_photo_saved" | "experience_photo_saved") {
  const id = String(formData.get("id") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return back(t.page, { err: "setup_invalid" });
  const file = formData.get("photo");
  const check = validatePhoto(file instanceof File ? file : null, "");
  if (!check.ok) return back(t.page, { err: check.code });

  const supabase = await staffClient();
  const { data: row } = await supabase.from(t.table).select("tenant_id, property_id").eq("id", id).maybeSingle();
  if (!row) return back(t.page, { err: "setup_forbidden" });

  const path = extraPhotoPath(t.kind, row.tenant_id, row.property_id, randomUUID(), check.ext);
  const service = createServiceClient();
  const { error: upErr } = await service.storage
    .from(PHOTO_BUCKET)
    .upload(path, await (file as File).arrayBuffer(), { contentType: check.contentType });
  if (upErr) return back(t.page, { err: "photo_upload" });
  const arg = t.rpc === "set_place_photo" ? { p_place: id, p_path: path } : { p_experience: id, p_path: path };
  const { error } = await supabase.rpc(t.rpc as "set_place_photo", arg as { p_place: string; p_path: string });
  if (error) {
    await service.storage.from(PHOTO_BUCKET).remove([path]);
    return back(t.page, { err: /NOT_FOUND/.test(error.message) ? "setup_forbidden" : classifySetupError(error) });
  }
  revalidatePath(t.page);
  revalidatePath("/");
  return ok(t.page, saved);
}

async function clearExtraPhoto(t: PhotoTarget, formData: FormData, removed: "place_photo_removed" | "experience_photo_removed") {
  const id = String(formData.get("id") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return back(t.page, { err: "setup_invalid" });
  const supabase = await staffClient();
  const arg = t.rpc === "set_place_photo" ? { p_place: id, p_path: "" } : { p_experience: id, p_path: "" };
  const { error } = await supabase.rpc(t.rpc as "set_place_photo", arg as { p_place: string; p_path: string });
  if (error) return back(t.page, { err: /NOT_FOUND/.test(error.message) ? "setup_forbidden" : classifySetupError(error) });
  revalidatePath(t.page);
  revalidatePath("/");
  return ok(t.page, removed);
}

/** A picture for a place (migration 136): same flow as the logo. The old file is queued for removal by the database. */
export async function uploadPlacePhoto(formData: FormData) {
  return storeExtraPhoto(PLACE_TARGET, formData, "place_photo_saved");
}
export async function removePlacePhoto(formData: FormData) {
  return clearExtraPhoto(PLACE_TARGET, formData, "place_photo_removed");
}
/** A picture for an experience (migration 136). */
export async function uploadExperiencePhoto(formData: FormData) {
  return storeExtraPhoto(EXPERIENCE_TARGET, formData, "experience_photo_saved");
}
export async function removeExperiencePhoto(formData: FormData) {
  return clearExtraPhoto(EXPERIENCE_TARGET, formData, "experience_photo_removed");
}
