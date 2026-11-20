"use server";

import { revalidatePath } from "next/cache";
import { back, ok, staffClient } from "./action-helpers";
import { loyaltyError, parseAdjustForm, parseRedeemForm, parseSettingsForm } from "./loyalty";
import { classifySetupError } from "./room-setup";

/**
 * Loyalty points actions (migration 150). They run as the signed-in person; the database checks permission (property.configure for
 * settings and adjustments, discount.apply for spending), the loyalty flag, the balance and the state of the booking, and answers
 * NOT_FOUND to anyone else, shown as a permission refusal.
 */
const PAGE = "/app/settings/loyalty";

function fromDb(message: string, code: string | undefined, adminAction: boolean) {
  return loyaltyError(message, adminAction) ?? classifySetupError({ message, code });
}

export async function saveLoyaltyPointsSettings(formData: FormData) {
  const v = parseSettingsForm(Object.fromEntries(formData));
  if (!v.ok) return back(PAGE, { err: v.code });
  const s = v.value;
  const supabase = await staffClient();
  const { error } = await supabase.rpc("save_loyalty_settings", {
    p_property: s.propertyId,
    p_enabled: s.enabled,
    p_earn: s.earnPer100,
    p_value: s.pointValueMinor,
    p_min: s.minRedeem,
  });
  if (error) return back(PAGE, { err: fromDb(error.message, error.code, true) });
  revalidatePath(PAGE);
  return ok(PAGE, "loyalty_saved");
}

export async function adjustLoyaltyPoints(formData: FormData) {
  const v = parseAdjustForm(Object.fromEntries(formData));
  if (!v.ok) return back(PAGE, { err: v.code });
  const a = v.value;
  const supabase = await staffClient();
  const { error } = await supabase.rpc("loyalty_adjust", {
    p_property: a.propertyId,
    p_email: a.email,
    p_points: a.points,
    p_reason: a.reason,
  });
  if (error) return back(PAGE, { err: fromDb(error.message, error.code, true) });
  revalidatePath(PAGE);
  return ok(PAGE, "loyalty_adjusted");
}

/** Spends points as the discount on a booking. The page the person came from is passed back so they land where they were. */
export async function redeemLoyaltyPoints(formData: FormData) {
  const v = parseRedeemForm(Object.fromEntries(formData));
  const page = reservationPage(formData);
  if (!v.ok) return back(page, { err: v.code });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("loyalty_redeem", {
    p_reservation: v.value.reservationId,
    p_points: v.value.points,
    p_idempotency_key: String(formData.get("key") ?? crypto.randomUUID()).slice(0, 80),
  });
  if (error) return back(page, { err: fromDb(error.message, error.code, false) });
  revalidatePath(page);
  return ok(page, "loyalty_redeemed");
}

export async function releaseLoyaltyPoints(formData: FormData) {
  const reservationId = String(formData.get("reservationId") ?? "");
  const page = reservationPage(formData);
  if (!/^[0-9a-f-]{36}$/i.test(reservationId)) return back(page, { err: "loyalty_invalid" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("loyalty_release", {
    p_reservation: reservationId,
    p_idempotency_key: String(formData.get("key") ?? crypto.randomUUID()).slice(0, 80),
  });
  if (error) return back(page, { err: fromDb(error.message, error.code, false) });
  revalidatePath(page);
  return ok(page, "loyalty_released");
}

/** Only an in-app path under /app/reservations may be returned to, so a form cannot send a person elsewhere. */
function reservationPage(formData: FormData): string {
  const p = String(formData.get("returnTo") ?? "");
  return /^\/app\/reservations\/[0-9a-f-]{36}$/i.test(p) ? p : PAGE;
}
