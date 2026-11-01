/**
 * Tax rules screen (`/app/settings/tax`): wording, ordering and input checks. Pure functions, so they can be tested.
 * The tables' row-level security decides who may change a rule (property.configure); these helpers only decide what
 * to show and which button is worth offering. The database still decides.
 *
 * Nights and extras are taxed differently (migration 027): a rule taxes the nights of a stay by default, and taxes
 * the extras on a folio (minibar, laundry and so on) only when someone marks it. Only percent rules can be marked.
 * Nothing is marked by default, so until a person does it extras carry no tax.
 */
import { z } from "zod";

export type TaxRuleRow = {
  id: string;
  property_id: string;
  name: string;
  basis: string;
  /** Percent rules: a percentage (7.5 means 7.5%). Fixed-per-night rules: an amount in kobo. */
  rate_value: number | string;
  sequence: number;
  compounds: boolean;
  effective_from: string;
  effective_to: string | null;
  status: string;
  applies_to_charges: boolean;
};

export const TAX_RULE_COLUMNS = "id, property_id, name, basis, rate_value, sequence, compounds, effective_from, effective_to, status, applies_to_charges";

/** "7.5%" or, for a fixed rule, "₦1,000.00 a night" (the caller formats the money so this file stays free of locale code). */
export function describeRate(r: Pick<TaxRuleRow, "basis" | "rate_value">, formatMinor: (minor: number) => string): string {
  const value = Number(r.rate_value);
  if (!Number.isFinite(value)) return "Rate unknown";
  if (r.basis === "percent") return `${Number.parseFloat(value.toFixed(4))}%`;
  return `${formatMinor(Math.round(value))} a night`;
}

export type RuleState = "in_force" | "upcoming" | "ended" | "switched_off";

/** Where a rule stands on a date: only an active rule inside its dates taxes anything. */
export function ruleState(r: Pick<TaxRuleRow, "status" | "effective_from" | "effective_to">, today: string): RuleState {
  if (r.status !== "active") return "switched_off";
  if (r.effective_from > today) return "upcoming";
  if (r.effective_to !== null && r.effective_to < today) return "ended";
  return "in_force";
}

export const STATE_LABEL: Record<RuleState, string> = {
  in_force: "In force",
  upcoming: "Starts later",
  ended: "Ended",
  switched_off: "Switched off",
};

/** Only a percent rule can be marked for extras; the database refuses a fixed-per-night rule. */
export const canApplyToExtras = (r: Pick<TaxRuleRow, "basis">): boolean => r.basis === "percent";

/** Rules in the order the database applies them: sequence, then id. Rules of one property stay together. */
export function sortRules<T extends Pick<TaxRuleRow, "property_id" | "sequence" | "id">>(rules: T[]): T[] {
  return [...rules].sort((a, b) => a.property_id.localeCompare(b.property_id) || a.sequence - b.sequence || a.id.localeCompare(b.id));
}

/** One line saying what a rule does to nights and to extras, for the row on the screen. */
export function appliesLine(r: Pick<TaxRuleRow, "basis" | "applies_to_charges">): string {
  if (r.basis !== "percent") return "Added to each night of a stay. Cannot be applied to extras.";
  return r.applies_to_charges ? "Added to each night of a stay and to extras posted to a guest's folio." : "Added to each night of a stay. Extras are not taxed by this rule.";
}

/** What the extras on a property are taxed with today: the marked rules that are in force, in the order they apply. */
export function extrasTaxRules(rules: TaxRuleRow[], propertyId: string, today: string): TaxRuleRow[] {
  return sortRules(rules.filter((r) => r.property_id === propertyId && r.applies_to_charges && r.basis === "percent" && ruleState(r, today) === "in_force"));
}

const toggleSchema = z.object({ ruleId: z.guid(), apply: z.enum(["on", "off"]) });

/** The form's two fields, checked. `apply` is the new setting: "on" taxes extras with the rule, "off" stops it. */
export function parseToggle(input: Record<string, unknown>): { ok: true; ruleId: string; apply: boolean } | { ok: false } {
  const parsed = toggleSchema.safeParse(input);
  return parsed.success ? { ok: true, ruleId: parsed.data.ruleId, apply: parsed.data.apply === "on" } : { ok: false };
}

/** Which refusal a failed update means: the database's own words are never shown. */
export function classifyTaxError(err: { code?: string; message?: string }): "tax_forbidden" | "tax_not_percent" | "unknown" {
  if (err.code === "42501" || /row-level security/i.test(err.message ?? "")) return "tax_forbidden";
  if (err.code === "23514" || /tax_rules_charges_percent_only/.test(err.message ?? "")) return "tax_not_percent";
  return "unknown";
}
