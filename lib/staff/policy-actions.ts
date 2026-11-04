"use server";

import { revalidatePath } from "next/cache";
import { back, ok, staffClient } from "./action-helpers";
import { checkEffectiveDate, classifyPolicyError, mergeConfig, POLICY_COLUMNS, validatePolicy, versionsOn, type PolicyRow } from "./policies";
import { todayIn } from "./reservations";
import type { Json } from "@/types/database";

/**
 * Publishes a new policy version. It runs as the signed-in person; the table's row-level security allows an insert
 * only to people with property.configure at that property, so a refusal from the database is final. Rows are never
 * edited (a trigger refuses it): a new version is inserted, and `current_policy` reads the latest one that has
 * started. Bookings copy the policy into their own snapshot when they are made, so nothing already booked changes.
 * Keys the screen does not manage are carried over from the previous version.
 */
const PAGE = "/app/settings/policies";

export async function publishPolicy(formData: FormData) {
  const v = validatePolicy(Object.fromEntries(formData));
  if (!v.ok) return back(PAGE, { err: v.field === "deposit" ? "policy_deposit" : v.field === "date" ? "policy_date" : "policy_rules" });
  const { propertyId, effectiveFrom, config } = v.value;

  const supabase = await staffClient();
  const { data: auth } = await supabase.auth.getUser();
  const { data: prop } = await supabase.from("properties").select("tenant_id, timezone").eq("id", propertyId).maybeSingle();
  if (!prop) return back(PAGE, { err: "policy_forbidden" });

  const { data: rows, error: rowsError } = await supabase.from("property_policies").select(POLICY_COLUMNS).eq("property_id", propertyId).limit(500);
  if (rowsError) return back(PAGE, { err: classifyPolicyError(rowsError) });
  const existing = (rows ?? []) as PolicyRow[];
  const latest = [...existing].sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];

  const today = todayIn(prop.timezone, new Date());
  const date = checkEffectiveDate(effectiveFrom, today, latest ? latest.effective_from : null);
  if (date === "past") return back(PAGE, { err: "policy_past" });
  if (date === "not_after_latest") return back(PAGE, { err: "policy_order" });

  // The merged config is JSON by construction (a jsonb column plus fields this screen validated), so the cast below is safe.
  // Checked here, so two people saving at the same moment hit the unique (property, version) rule: the loser is told to reload.
  const { data, error } = await supabase.from("property_policies").insert({
    tenant_id: prop.tenant_id, property_id: propertyId, version: versionsOn(existing, today).nextVersion,
    effective_from: effectiveFrom, config: mergeConfig(latest?.config, config) as NonNullable<Json>, created_by: auth.user?.id ?? null,
  }).select("id");
  if (error) return back(PAGE, { err: classifyPolicyError(error) });
  if (!data || data.length === 0) return back(PAGE, { err: "policy_forbidden" });
  revalidatePath(PAGE);
  return ok(PAGE, "policy_published");
}
