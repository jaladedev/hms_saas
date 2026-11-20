"use server";

import { revalidatePath } from "next/cache";
import { back, ok, staffClient } from "./action-helpers";
import { parseLimitsForm, parseRuleForm } from "./pricing-rules";
import { classifySetupError } from "./room-setup";

/**
 * Pricing rule actions (migration 146). They run as the signed-in person; the database requires rate.manage at that hotel and the
 * dynamic_pricing flag, and answers NOT_FOUND to anyone else, shown as a permission refusal. The rule and limit actions change no real price; the automatic pricing switch does (see below).
 */
const PAGE = "/app/settings/pricing";

function pricingError(
  message: string,
  code?: string,
):
  | "setup_forbidden"
  | "pricing_invalid"
  | "pricing_limit"
  | "pricing_flag"
  | "pricing_auto_needed"
  | ReturnType<typeof classifySetupError> {
  if (/NOT_FOUND/.test(message)) return "setup_forbidden";
  if (/POLICY_VIOLATION: limit/.test(message)) return "pricing_limit";
  if (/POLICY_VIOLATION: dynamic pricing off/.test(message)) return "pricing_flag";
  if (/POLICY_VIOLATION: auto apply off/.test(message)) return "pricing_auto_needed";
  if (/POLICY_VIOLATION: (name|kind|percent|band|weekdays|dates|room type|limits)/.test(message)) return "pricing_invalid";
  return classifySetupError({ message, code });
}

export async function savePricingRule(formData: FormData) {
  const v = parseRuleForm(Object.fromEntries(formData));
  if (!v.ok) return back(PAGE, { err: v.code });
  const r = v.value;
  const supabase = await staffClient();
  const { error } = await supabase.rpc("save_pricing_rule", {
    p_property: r.propertyId,
    p_rule: r.ruleId as string,
    p_room_type: r.roomTypeId as string,
    p_name: r.name,
    p_kind: r.kind,
    p_from: r.from as number,
    p_to: r.to as number,
    p_weekdays: r.kind === "weekday" ? r.weekdays : (null as unknown as number[]),
    p_date_from: r.dateFrom as string,
    p_date_to: r.dateTo as string,
    p_percent: r.percent,
    p_active: r.active,
  });
  if (error) return back(PAGE, { err: pricingError(error.message, error.code) });
  revalidatePath(PAGE);
  return ok(PAGE, "pricing_saved");
}

export async function deletePricingRule(formData: FormData) {
  const id = String(formData.get("ruleId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return back(PAGE, { err: "pricing_invalid" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("delete_pricing_rule", { p_rule: id });
  if (error) return back(PAGE, { err: pricingError(error.message, error.code) });
  revalidatePath(PAGE);
  return ok(PAGE, "pricing_deleted");
}

/** Floor and ceiling for one room type; both empty clears them. */
export async function savePricingLimits(formData: FormData) {
  const v = parseLimitsForm(Object.fromEntries(formData));
  if (!v.ok) return back(PAGE, { err: v.code });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("set_pricing_limits", {
    p_property: v.value.propertyId,
    p_room_type: v.value.roomTypeId,
    p_floor: v.value.floor as number,
    p_ceiling: v.value.ceiling as number,
  });
  if (error) return back(PAGE, { err: pricingError(error.message, error.code) });
  revalidatePath(PAGE);
  return ok(PAGE, "pricing_limits_saved");
}

/**
 * Switches automatic pricing on or off for a hotel (migration 152). On: the next 60 nights are priced from the rules at once and again
 * every day. Off: every night it changed goes back to the price it had. Existing bookings and holds keep the price they were made at.
 */
export async function setPricingAutoApply(formData: FormData) {
  const id = String(formData.get("propertyId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return back(PAGE, { err: "pricing_invalid" });
  const on = formData.get("on") === "1";
  const supabase = await staffClient();
  const { error } = await supabase.rpc("set_pricing_auto_apply", { p_property: id, p_on: on });
  if (error) return back(PAGE, { err: pricingError(error.message, error.code) });
  revalidatePath(PAGE);
  return ok(PAGE, on ? "pricing_auto_on" : "pricing_auto_off");
}

/** Runs the automatic pricing now, for after the rules or limits changed. */
export async function applyPricingNow(formData: FormData) {
  const id = String(formData.get("propertyId") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return back(PAGE, { err: "pricing_invalid" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("pricing_apply_now", { p_property: id });
  if (error) return back(PAGE, { err: pricingError(error.message, error.code) });
  revalidatePath(PAGE);
  return ok(PAGE, "pricing_applied");
}
