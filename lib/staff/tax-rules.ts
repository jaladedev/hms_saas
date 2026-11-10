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
import { parseAmountToMinor } from "./money-input";
import type { ErrorCode } from "./refunds";

export type TaxRuleRow = {
  id: string;
  property_id: string;
  name: string;
  basis: string;
  /** Percent rules: a percentage (7.5 means 7.5%). Fixed rules (a night or a stay): an amount in kobo. */
  rate_value: number | string;
  sequence: number;
  compounds: boolean;
  effective_from: string;
  effective_to: string | null;
  status: string;
  applies_to_charges: boolean;
};

export const TAX_RULE_COLUMNS =
  "id, property_id, name, basis, rate_value, sequence, compounds, effective_from, effective_to, status, applies_to_charges";

/** "7.5%" or, for a fixed rule, "₦1,000.00 a night" (the caller formats the money so this file stays free of locale code). */
export function describeRate(r: Pick<TaxRuleRow, "basis" | "rate_value">, formatMinor: (minor: number) => string): string {
  const value = Number(r.rate_value);
  if (!Number.isFinite(value)) return "Rate unknown";
  if (r.basis === "percent") return `${Number.parseFloat(value.toFixed(4))}%`;
  return r.basis === "fixed_per_stay" ? `${formatMinor(Math.round(value))} a stay, per room` : `${formatMinor(Math.round(value))} a night`;
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

export type TaxBasis = "percent" | "fixed_per_night" | "fixed_per_stay";
export const isTaxBasis = (v: unknown): v is TaxBasis => v === "percent" || v === "fixed_per_night" || v === "fixed_per_stay";

/** One line saying what a rule does to nights and to extras, for the row on the screen. */
export function appliesLine(r: Pick<TaxRuleRow, "basis" | "applies_to_charges">): string {
  if (r.basis === "fixed_per_stay") return "Charged once for each room, on its first night. Cannot be applied to extras.";
  if (r.basis !== "percent") return "Added to each night of a stay. Cannot be applied to extras.";
  return r.applies_to_charges
    ? "Added to each night of a stay and to extras posted to a guest's folio."
    : "Added to each night of a stay. Extras are not taxed by this rule.";
}

/** What the extras on a property are taxed with today: the marked rules that are in force, in the order they apply. */
export function extrasTaxRules(rules: TaxRuleRow[], propertyId: string, today: string): TaxRuleRow[] {
  return sortRules(
    rules.filter(
      (r) => r.property_id === propertyId && r.applies_to_charges && r.basis === "percent" && ruleState(r, today) === "in_force",
    ),
  );
}

const toggleSchema = z.object({ ruleId: z.guid(), apply: z.enum(["on", "off"]) });

/** The form's two fields, checked. `apply` is the new setting: "on" taxes extras with the rule, "off" stops it. */
export function parseToggle(input: Record<string, unknown>): { ok: true; ruleId: string; apply: boolean } | { ok: false } {
  const parsed = toggleSchema.safeParse(input);
  return parsed.success ? { ok: true, ruleId: parsed.data.ruleId, apply: parsed.data.apply === "on" } : { ok: false };
}

/** Which refusal a failed write means: the database's own words are never shown. */
export function classifyTaxError(err: {
  code?: string;
  message?: string;
}): "tax_forbidden" | "tax_not_percent" | "tax_invalid" | "unknown" {
  const msg = err.message ?? "";
  if (err.code === "42501" || /row-level security/i.test(msg)) return "tax_forbidden";
  if (/tax_rules_charges_percent_only/.test(msg)) return "tax_not_percent";
  // Other check constraints (rate below zero, last day before the first day) and values the column cannot hold.
  if (err.code === "23514" || err.code === "22003" || err.code === "22P02" || err.code === "22007" || err.code === "22008")
    return "tax_invalid";
  return "unknown";
}

// ---------------------------------------------------------------------------------------------------------------
// Adding and editing a rule
//
// A rule's basis (percent or fixed amount a night) is chosen when it is added and never edited: switching one into
// the other would change what the number means, and a fixed rule cannot be marked for extras. To change the kind of
// tax, switch the old rule off and add a new one. Whether extras are taxed (applies_to_charges) is not part of these
// forms; it stays a separate, deliberate switch, and a new rule starts with it off.
//
// Changing a rate, a date or the order only affects prices worked out from then on (quotes and new bookings). A
// booking keeps the tax it was made with, and a posted charge keeps the tax it was posted with.
// ---------------------------------------------------------------------------------------------------------------

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "");
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const RULE_NAME_MAX = 60;
export const SEQUENCE_MAX = 999;
/** Dates outside this window are almost always a typo (a year of 0026, say), so they are refused. */
const FIRST_YEAR = 2000;
const LAST_YEAR = 2100;

function isoDate(v: unknown): string | null {
  const m = ISO_DATE.exec(clean(v, 10));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < FIRST_YEAR || y > LAST_YEAR) return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** What is stored in `rate_value`: a percentage for a percent rule (7.5), kobo for a fixed rule. Null when not usable. */
export function parseRateValue(basis: string, raw: unknown): number | null {
  const text = clean(raw, 40);
  if (basis === "percent") {
    const m = /^(\d{1,3}(?:\.\d{1,4})?)\s*%?$/.exec(text);
    if (!m) return null;
    const value = Number(m[1]);
    return value > 0 && value <= 100 ? value : null;
  }
  if (basis === "fixed_per_night" || basis === "fixed_per_stay") return parseAmountToMinor(text);
  return null;
}

function parseSequence(raw: unknown): { ok: true; value: number | null } | { ok: false } {
  const text = clean(raw, 10);
  if (text === "") return { ok: true, value: null };
  if (!/^\d{1,3}$/.test(text)) return { ok: false };
  const n = Number(text);
  return n >= 1 && n <= SEQUENCE_MAX ? { ok: true, value: n } : { ok: false };
}

export type TaxRuleFields = {
  name: string;
  rateValue: number;
  /** Null on a new rule when left blank: the action then puts it after the property's other rules. */
  sequence: number | null;
  compounds: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: "active" | "inactive";
};
export type TaxRuleInput = TaxRuleFields & { propertyId: string; basis: TaxBasis };
export type TaxRuleEdit = TaxRuleFields & { ruleId: string; sequence: number };

function parseFields(raw: Record<string, unknown>, basis: TaxBasis): { ok: true; value: TaxRuleFields } | { ok: false; code: ErrorCode } {
  const name = clean(raw.name, RULE_NAME_MAX + 20);
  if (!name || name.length > RULE_NAME_MAX) return { ok: false, code: "tax_invalid" };
  const rateValue = parseRateValue(basis, raw.rate);
  if (rateValue === null) return { ok: false, code: "tax_invalid" };
  const sequence = parseSequence(raw.sequence);
  if (!sequence.ok) return { ok: false, code: "tax_invalid" };
  const effectiveFrom = isoDate(raw.effectiveFrom);
  if (!effectiveFrom) return { ok: false, code: "tax_invalid" };
  const toText = clean(raw.effectiveTo, 10);
  const effectiveTo = toText === "" ? null : isoDate(toText);
  if (toText !== "" && (effectiveTo === null || effectiveTo < effectiveFrom)) return { ok: false, code: "tax_invalid" };
  const status = raw.status === "inactive" ? "inactive" : "active";
  // "Applied on top of the rules before it" only means something for a percentage.
  const compounds = basis === "percent" && raw.compounds === "on";
  return { ok: true, value: { name, rateValue, sequence: sequence.value, compounds, effectiveFrom, effectiveTo, status } };
}

export function validateTaxRule(raw: Record<string, unknown>): { ok: true; value: TaxRuleInput } | { ok: false; code: ErrorCode } {
  const propertyId = clean(raw.propertyId, 40);
  if (!GUID.test(propertyId)) return { ok: false, code: "bad_request" };
  const basis = isTaxBasis(raw.basis) ? raw.basis : null;
  if (!basis) return { ok: false, code: "tax_invalid" };
  const fields = parseFields({ ...raw, status: "active" }, basis);
  return fields.ok ? { ok: true, value: { propertyId, basis, ...fields.value } } : fields;
}

/** The rule's basis comes from the database row, never from the form. */
export function validateTaxRuleEdit(
  raw: Record<string, unknown>,
  basis: string,
): { ok: true; value: TaxRuleEdit } | { ok: false; code: ErrorCode } {
  const ruleId = clean(raw.ruleId, 40);
  if (!GUID.test(ruleId)) return { ok: false, code: "bad_request" };
  if (!isTaxBasis(basis)) return { ok: false, code: "tax_invalid" };
  const fields = parseFields(raw, basis);
  if (!fields.ok) return fields;
  // An edit always carries the order number, so a blank one is refused instead of silently moving the rule.
  if (fields.value.sequence === null) return { ok: false, code: "tax_invalid" };
  return { ok: true, value: { ruleId, ...fields.value, sequence: fields.value.sequence } };
}

/** Where a new rule goes when no order number is given: after every rule the property already has. */
export function nextSequence(rules: Pick<TaxRuleRow, "sequence">[]): number {
  const highest = rules.reduce((max, r) => Math.max(max, r.sequence), 0);
  return Math.min(highest + 1, SEQUENCE_MAX);
}

const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * True when saving this rule would leave two switched-on rules with the same name in force on the same day, which
 * charges that tax twice on those nights. A guard against slips, not a database rule: switch the old rule off or end
 * it the day before the new one starts. `others` are the property's other rules (not the one being edited).
 */
export function doubleTaxes(
  candidate: Pick<TaxRuleRow, "name" | "status" | "effective_from" | "effective_to">,
  others: Pick<TaxRuleRow, "name" | "status" | "effective_from" | "effective_to">[],
): boolean {
  if (candidate.status !== "active") return false;
  return others.some(
    (o) =>
      o.status === "active" &&
      sameName(o.name, candidate.name) &&
      o.effective_from <= (candidate.effective_to ?? "9999-12-31") &&
      candidate.effective_from <= (o.effective_to ?? "9999-12-31"),
  );
}

/** The figure to show in the rate box when editing: 7.5 for a percentage, 1000.00 (naira) for a fixed amount. */
export function rateInputValue(r: Pick<TaxRuleRow, "basis" | "rate_value">): string {
  const value = Number(r.rate_value);
  if (!Number.isFinite(value)) return "";
  return r.basis === "percent" ? String(Number.parseFloat(value.toFixed(4))) : (value / 100).toFixed(2);
}
