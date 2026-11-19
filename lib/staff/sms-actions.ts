"use server";

import { revalidatePath } from "next/cache";
import { back, ok, staffClient } from "./action-helpers";
import { classifySetupError } from "./room-setup";
import { parseSmsForm } from "./sms-settings";

/**
 * Text message actions (migration 147). They run as the signed-in person; the database requires property.configure at that hotel
 * (or guest.manage for a guest's opt-out) and the sms_notifications plan flag, and answers NOT_FOUND to anyone else.
 */
const PAGE = "/app/settings/messages";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function saveSmsSettings(formData: FormData) {
  const v = parseSmsForm({
    propertyId: formData.get("propertyId"),
    enabled: formData.get("enabled"),
    kinds: formData.getAll("kind"),
    channel: formData.get("channel"),
    monthlyCap: formData.get("monthlyCap"),
    reminderDays: formData.get("reminderDays"),
  });
  if (!v.ok) return back(PAGE, { err: v.code });
  const r = v.value;
  const supabase = await staffClient();
  const { error } = await supabase.rpc("set_sms_settings", {
    p_property: r.propertyId,
    p_enabled: r.enabled,
    p_kinds: r.kinds,
    p_channel: r.channel,
    p_monthly_cap: r.monthlyCap,
    p_reminder_days: r.reminderDays,
  });
  if (error) {
    return back(PAGE, {
      err: /NOT_FOUND/.test(error.message)
        ? "setup_forbidden"
        : /INVALID_SMS_SETTING/.test(error.message)
          ? "sms_invalid"
          : classifySetupError(error),
    });
  }
  revalidatePath(PAGE);
  return ok(PAGE, "sms_saved");
}

/** Staff record that a guest asked not to be texted (or may be texted again), for example after a phone call. */
export async function saveGuestSmsOptOut(formData: FormData) {
  const guestId = formData.get("guestId");
  const optOut = formData.get("optOut") === "on";
  const returnTo = formData.get("returnTo");
  const path = typeof returnTo === "string" && /^\/app\/[a-z0-9/_-]{0,80}$/i.test(returnTo) ? returnTo : "/app";
  if (typeof guestId !== "string" || !UUID.test(guestId)) return back(path, { err: "setup_invalid" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("set_guest_sms_opt_out", { p_guest: guestId, p_opt_out: optOut });
  if (error) return back(path, { err: /NOT_FOUND/.test(error.message) ? "setup_forbidden" : classifySetupError(error) });
  revalidatePath(path);
  return ok(path, optOut ? "guest_sms_opt_out_on" : "guest_sms_opt_out_off");
}
