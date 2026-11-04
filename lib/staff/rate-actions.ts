"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, ok, staffClient } from "./action-helpers";
import { expandDates, validateRateRange } from "./rates";
import type { ErrorCode } from "./refunds";

/**
 * Rate setup actions. They run as the signed-in person; the tables' row-level security allows writes only to
 * people with rate.manage, so a refusal from the database is final. Prices are stored per night on the
 * property's default rate plan, which is the plan every booking is priced from.
 */

const PAGE = "/app/settings/rates";
const refresh = () => { revalidatePath(PAGE); revalidatePath("/app/reservations/new"); };
const failWith = (err: { code?: string; message?: string }): never => {
  const code: ErrorCode = err.code === "42501" || /row-level security/i.test(err.message ?? "") ? "rate_forbidden"
    : err.code === "23505" ? "invalid_state" : "unknown";
  return back(PAGE, { err: code });
};

export async function createDefaultPlan(formData: FormData) {
  const parsed = z.object({ propertyId: z.guid() }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(PAGE, { err: "bad_request" });
  const supabase = await staffClient();
  const { data: prop } = await supabase.from("properties").select("tenant_id").eq("id", parsed.data.propertyId).maybeSingle();
  if (!prop) return back(PAGE, { err: "rate_forbidden" });

  const { error } = await supabase.from("rate_plans").insert({
    tenant_id: prop.tenant_id, property_id: parsed.data.propertyId, name: "Standard", code: "STD", is_default: true,
  });
  if (error) return failWith(error);
  refresh();
  return ok(PAGE, "rate_plan_created");
}

async function context(propertyId: string, roomTypeId: string) {
  const supabase = await staffClient();
  const [planQ, typeQ] = await Promise.all([
    supabase.from("rate_plans").select("id, tenant_id").eq("property_id", propertyId).eq("is_default", true).eq("status", "active").maybeSingle(),
    supabase.from("room_types").select("id, tenant_id, currency").eq("id", roomTypeId).eq("property_id", propertyId).maybeSingle(),
  ]);
  return { supabase, plan: planQ.data, type: typeQ.data };
}

export async function setRates(formData: FormData) {
  const v = validateRateRange(Object.fromEntries(formData), true);
  if (!v.ok) return back(PAGE, { err: v.code });
  const { propertyId, roomTypeId, from, to, amountMinor } = v.value;
  // validateRateRange(…, true) already refuses a missing price; this narrows the type for the insert below.
  if (amountMinor === null) return back(PAGE, { err: "rate_range_invalid" });

  const { supabase, plan, type } = await context(propertyId, roomTypeId);
  if (!plan) return back(PAGE, { err: "rate_no_plan" });
  if (!type) return back(PAGE, { err: "room_type_missing" });

  const rows = expandDates(from, to).map((business_date) => ({
    tenant_id: type.tenant_id, property_id: propertyId, room_type_id: roomTypeId, rate_plan_id: plan.id,
    business_date, amount_minor: amountMinor, currency: type.currency,
  }));
  const { error } = await supabase.from("daily_rates").upsert(rows, { onConflict: "property_id,room_type_id,rate_plan_id,business_date" });
  if (error) return failWith(error);
  refresh();
  return ok(PAGE, "rates_set");
}

export async function clearRates(formData: FormData) {
  const v = validateRateRange(Object.fromEntries(formData), false);
  if (!v.ok) return back(PAGE, { err: v.code });
  const { propertyId, roomTypeId, from, to } = v.value;

  const { supabase, plan } = await context(propertyId, roomTypeId);
  if (!plan) return back(PAGE, { err: "rate_no_plan" });
  const { error } = await supabase.from("daily_rates").delete()
    .eq("property_id", propertyId).eq("room_type_id", roomTypeId).eq("rate_plan_id", plan.id)
    .gte("business_date", from).lte("business_date", to);
  if (error) return failWith(error);
  refresh();
  return ok(PAGE, "rates_cleared");
}
