"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, ok, staffClient } from "./action-helpers";
import { classifyTaxError, doubleTaxes, nextSequence, parseToggle, TAX_RULE_COLUMNS, validateTaxRule, validateTaxRuleEdit, type TaxRuleRow } from "./tax-rules";

/**
 * Tax rule actions. They run as the signed-in person; the table's row-level security allows a write only to
 * people with property.configure at that rule's property, so a refusal from the database is final. Posted charges
 * keep the tax they were posted with (migration 027 stores it on the charge), bookings keep the tax they were made
 * with, and every insert and update is recorded in the audit log by migration 028.
 *
 * `setExtrasTax` writes only the column that decides whether extras are taxed. `addTaxRule` and `updateTaxRule`
 * never touch that column: a new rule starts with extras untaxed, and an edit leaves the setting as it was.
 */

const PAGE = "/app/settings/tax";

export async function setExtrasTax(formData: FormData) {
  const parsed = parseToggle(Object.fromEntries(formData));
  if (!parsed.ok) return back(PAGE, { err: "bad_request" });

  const supabase = await staffClient();
  // Select the changed row back: a rule that is not visible, or not changeable by this person, updates zero rows
  // without an error, and that must not be shown as a success.
  const { data, error } = await supabase.from("tax_rules").update({ applies_to_charges: parsed.apply }).eq("id", parsed.ruleId).select("id");
  if (error) return back(PAGE, { err: classifyTaxError(error) });
  if (!data || data.length === 0) return back(PAGE, { err: "tax_not_found" });
  revalidatePath(PAGE);
  return ok(PAGE, parsed.apply ? "tax_extras_on" : "tax_extras_off");
}

/** Adds a rule. It starts switched on for nights and off for extras; the order defaults to after the property's other rules. */
export async function addTaxRule(formData: FormData) {
  const v = validateTaxRule(Object.fromEntries(formData));
  if (!v.ok) return back(PAGE, { err: v.code });
  const { value } = v;

  const supabase = await staffClient();
  const { data: prop } = await supabase.from("properties").select("tenant_id").eq("id", value.propertyId).maybeSingle();
  if (!prop) return back(PAGE, { err: "tax_forbidden" });

  const { data: existing, error: existingError } = await supabase.from("tax_rules").select(TAX_RULE_COLUMNS).eq("property_id", value.propertyId).limit(500);
  if (existingError) return back(PAGE, { err: classifyTaxError(existingError) });
  const others = (existing ?? []) as TaxRuleRow[];
  // Checked here, not in the database, so two people saving at the same moment could still both get through.
  if (doubleTaxes({ name: value.name, status: value.status, effective_from: value.effectiveFrom, effective_to: value.effectiveTo }, others)) {
    return back(PAGE, { err: "tax_duplicate" });
  }

  const { data, error } = await supabase.from("tax_rules").insert({
    tenant_id: prop.tenant_id, property_id: value.propertyId, name: value.name, basis: value.basis, rate_value: value.rateValue,
    sequence: value.sequence ?? nextSequence(others), compounds: value.compounds,
    effective_from: value.effectiveFrom, effective_to: value.effectiveTo, status: "active",
  }).select("id");
  if (error) return back(PAGE, { err: classifyTaxError(error) });
  if (!data || data.length === 0) return back(PAGE, { err: "tax_forbidden" });
  revalidatePath(PAGE);
  return ok(PAGE, "tax_rule_created");
}

/**
 * Changes a rule's name, rate, order, dates, "applied on top" setting and whether it is switched on. The kind of tax
 * (percent or fixed) comes from the stored rule and cannot be edited. A rule the person cannot change updates zero
 * rows without an error, so an empty result is a refusal, not a success.
 */
export async function updateTaxRule(formData: FormData) {
  const raw = Object.fromEntries(formData);
  const id = z.guid().safeParse(raw.ruleId);
  if (!id.success) return back(PAGE, { err: "bad_request" });
  const supabase = await staffClient();

  // Read the stored rule first: its basis decides how the rate is read, and its property scopes the double-tax check.
  const { data: current, error: currentError } = await supabase.from("tax_rules").select(TAX_RULE_COLUMNS).eq("id", id.data).maybeSingle();
  if (currentError) return back(PAGE, { err: classifyTaxError(currentError) });
  if (!current) return back(PAGE, { err: "tax_not_found" });
  const rule = current as TaxRuleRow;

  const v = validateTaxRuleEdit(raw, rule.basis);
  if (!v.ok) return back(PAGE, { err: v.code });
  const { value } = v;

  const { data: siblings, error: siblingsError } = await supabase.from("tax_rules").select(TAX_RULE_COLUMNS).eq("property_id", rule.property_id).neq("id", rule.id).limit(500);
  if (siblingsError) return back(PAGE, { err: classifyTaxError(siblingsError) });
  if (doubleTaxes({ name: value.name, status: value.status, effective_from: value.effectiveFrom, effective_to: value.effectiveTo }, (siblings ?? []) as TaxRuleRow[])) {
    return back(PAGE, { err: "tax_duplicate" });
  }

  const { data, error } = await supabase.from("tax_rules").update({
    name: value.name, rate_value: value.rateValue, sequence: value.sequence, compounds: value.compounds,
    effective_from: value.effectiveFrom, effective_to: value.effectiveTo, status: value.status,
  }).eq("id", rule.id).select("id");
  if (error) return back(PAGE, { err: classifyTaxError(error) });
  if (!data || data.length === 0) return back(PAGE, { err: "tax_not_found" });
  revalidatePath(PAGE);
  return ok(PAGE, "tax_rule_updated");
}
