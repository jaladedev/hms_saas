import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appliesLine,
  canApplyToExtras,
  classifyTaxError,
  describeRate,
  doubleTaxes,
  extrasTaxRules,
  nextSequence,
  parseRateValue,
  parseToggle,
  rateInputValue,
  ruleState,
  sortRules,
  TAX_RULE_COLUMNS,
  validateTaxRule,
  validateTaxRuleEdit,
  type TaxRuleRow,
} from "./tax-rules";

const A = "11111111-1111-4111-8111-111111111111";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const rule = (over: Partial<TaxRuleRow>): TaxRuleRow => ({
  id: A,
  property_id: P1,
  name: "VAT",
  basis: "percent",
  rate_value: 7.5,
  sequence: 1,
  compounds: false,
  effective_from: "2026-01-01",
  effective_to: null,
  status: "active",
  applies_to_charges: false,
  ...over,
});
const naira = (minor: number) => `₦${(minor / 100).toFixed(2)}`;

describe("describeRate", () => {
  it("words a percent and a fixed amount, and trims the decimals the database returns", () => {
    expect(describeRate(rule({ rate_value: 7.5 }), naira)).toBe("7.5%");
    expect(describeRate(rule({ rate_value: "5.0000" }), naira)).toBe("5%");
    expect(describeRate(rule({ basis: "fixed_per_night", rate_value: 100000 }), naira)).toBe("₦1000.00 a night");
    expect(describeRate(rule({ rate_value: "not a number" }), naira)).toBe("Rate unknown");
  });
});

describe("ruleState", () => {
  const today = "2026-11-01";
  it("is in force only when active and inside its dates, the last day included", () => {
    expect(ruleState(rule({}), today)).toBe("in_force");
    expect(ruleState(rule({ effective_to: "2026-11-01" }), today)).toBe("in_force");
    expect(ruleState(rule({ effective_from: "2026-11-01" }), today)).toBe("in_force");
  });
  it("tells apart a rule that starts later, one that ended and one switched off", () => {
    expect(ruleState(rule({ effective_from: "2026-11-02" }), today)).toBe("upcoming");
    expect(ruleState(rule({ effective_to: "2026-10-31" }), today)).toBe("ended");
    expect(ruleState(rule({ status: "inactive", effective_from: "2030-01-01" }), today)).toBe("switched_off");
  });
});

describe("what a rule does", () => {
  it("offers the switch only for percent rules and words each case", () => {
    expect(canApplyToExtras(rule({}))).toBe(true);
    expect(canApplyToExtras(rule({ basis: "fixed_per_night" }))).toBe(false);
    expect(appliesLine(rule({ applies_to_charges: false }))).toMatch(/Extras are not taxed/);
    expect(appliesLine(rule({ applies_to_charges: true }))).toMatch(/and to extras/);
    expect(appliesLine(rule({ basis: "fixed_per_night" }))).toMatch(/Cannot be applied to extras/);
  });
});

describe("sortRules and extrasTaxRules", () => {
  const rules = [
    rule({ id: "0000000b-0000-4000-8000-000000000000", sequence: 2, applies_to_charges: true }),
    rule({ id: "0000000a-0000-4000-8000-000000000000", sequence: 1, applies_to_charges: true }),
    rule({ id: "0000000c-0000-4000-8000-000000000000", sequence: 1, applies_to_charges: true, property_id: P2 }),
    rule({ id: "0000000d-0000-4000-8000-000000000000", sequence: 3, applies_to_charges: true, status: "inactive" }),
    rule({ id: "0000000e-0000-4000-8000-000000000000", sequence: 4, applies_to_charges: false }),
    rule({ id: "0000000f-0000-4000-8000-000000000000", sequence: 5, applies_to_charges: true, effective_to: "2026-01-31" }),
  ];
  it("orders by property, then the order the database applies them", () => {
    expect(sortRules(rules).map((r) => r.id.slice(0, 8))).toEqual(["0000000a", "0000000b", "0000000d", "0000000e", "0000000f", "0000000c"]);
  });
  it("lists what extras are taxed with today: marked, active, in force, for that property only", () => {
    expect(extrasTaxRules(rules, P1, "2026-11-01").map((r) => r.id.slice(0, 8))).toEqual(["0000000a", "0000000b"]);
    expect(extrasTaxRules(rules, P2, "2026-11-01").map((r) => r.id.slice(0, 8))).toEqual(["0000000c"]);
    expect(extrasTaxRules([], P1, "2026-11-01")).toEqual([]);
  });
  it("does not change the list it is given", () => {
    const before = rules.map((r) => r.id);
    sortRules(rules);
    expect(rules.map((r) => r.id)).toEqual(before);
  });
});

describe("parseToggle", () => {
  it("accepts a rule id and on or off, and nothing else", () => {
    expect(parseToggle({ ruleId: A, apply: "on" })).toEqual({ ok: true, ruleId: A, apply: true });
    expect(parseToggle({ ruleId: A, apply: "off" })).toEqual({ ok: true, ruleId: A, apply: false });
    for (const bad of [{ ruleId: "nope", apply: "on" }, { ruleId: A, apply: "yes" }, { ruleId: A }, {}])
      expect(parseToggle(bad)).toEqual({ ok: false });
  });
});

describe("classifyTaxError", () => {
  it("separates a permission refusal from a fixed rule and keeps the rest unknown", () => {
    expect(classifyTaxError({ code: "42501" })).toBe("tax_forbidden");
    expect(classifyTaxError({ message: 'new row violates row-level security policy for table "tax_rules"' })).toBe("tax_forbidden");
    expect(classifyTaxError({ code: "23514", message: 'violates check constraint "tax_rules_charges_percent_only"' })).toBe(
      "tax_not_percent",
    );
    expect(classifyTaxError({ code: "XX000", message: "boom" })).toBe("unknown");
  });
  it("calls any other check failure or unusable value an invalid rule, not a fixed-rule refusal", () => {
    expect(classifyTaxError({ code: "23514", message: 'violates check constraint "tax_rules_check"' })).toBe("tax_invalid");
    expect(classifyTaxError({ code: "23514", message: 'violates check constraint "tax_rules_rate_value_check"' })).toBe("tax_invalid");
    expect(classifyTaxError({ code: "22003" })).toBe("tax_invalid");
    expect(classifyTaxError({ code: "22P02" })).toBe("tax_invalid");
    expect(classifyTaxError({ code: "22007" })).toBe("tax_invalid");
  });
});

describe("parseRateValue", () => {
  it("reads a percentage above zero and up to 100, with at most four decimals and an optional % sign", () => {
    expect(parseRateValue("percent", "7.5")).toBe(7.5);
    expect(parseRateValue("percent", " 5 % ")).toBe(5);
    expect(parseRateValue("percent", "100")).toBe(100);
    expect(parseRateValue("percent", "12.3456")).toBe(12.3456);
    for (const bad of ["0", "0.0", "100.01", "101", "-5", "7,5", "7.12345", "abc", "", "7.5.1", "1e2"])
      expect(parseRateValue("percent", bad), bad).toBeNull();
  });
  it("reads a fixed amount in naira into kobo", () => {
    expect(parseRateValue("fixed_per_night", "1,000")).toBe(100000);
    expect(parseRateValue("fixed_per_night", "₦1500.50")).toBe(150050);
    for (const bad of ["0", "-1", "10.999", "abc", ""]) expect(parseRateValue("fixed_per_night", bad), bad).toBeNull();
  });
  it("refuses a basis it does not know", () => {
    expect(parseRateValue("flat", "5")).toBeNull();
    expect(parseRateValue("", "5")).toBeNull();
  });
});

describe("validateTaxRule (add)", () => {
  const form = {
    propertyId: P1,
    name: " VAT ",
    basis: "percent",
    rate: "7.5",
    sequence: "",
    effectiveFrom: "2026-11-01",
    effectiveTo: "",
    compounds: "",
  };
  it("accepts a percent rule, trims the name, and leaves a blank order for the action to fill", () => {
    expect(validateTaxRule(form)).toEqual({
      ok: true,
      value: {
        propertyId: P1,
        basis: "percent",
        name: "VAT",
        rateValue: 7.5,
        sequence: null,
        compounds: false,
        effectiveFrom: "2026-11-01",
        effectiveTo: null,
        status: "active",
      },
    });
  });
  it("stores a fixed amount in kobo and ignores 'on top of' for it", () => {
    const r = validateTaxRule({
      ...form,
      name: "Tourism levy",
      basis: "fixed_per_night",
      rate: "1,000",
      compounds: "on",
      sequence: "3",
      effectiveTo: "2027-03-31",
    });
    expect(r).toEqual({
      ok: true,
      value: {
        propertyId: P1,
        basis: "fixed_per_night",
        name: "Tourism levy",
        rateValue: 100000,
        sequence: 3,
        compounds: false,
        effectiveFrom: "2026-11-01",
        effectiveTo: "2027-03-31",
        status: "active",
      },
    });
  });
  it("lets a percent rule be applied on top of the ones before it", () => {
    const r = validateTaxRule({ ...form, compounds: "on" });
    expect(r.ok && r.value.compounds).toBe(true);
  });
  it("always adds a rule as switched on, whatever the form says", () => {
    const r = validateTaxRule({ ...form, status: "inactive" });
    expect(r.ok && r.value.status).toBe("active");
  });
  it("refuses a bad property id as a bad request and every other bad field as invalid", () => {
    expect(validateTaxRule({ ...form, propertyId: "nope" })).toEqual({ ok: false, code: "bad_request" });
    const invalid = [
      { name: "" },
      { name: "x".repeat(61) },
      { basis: "flat" },
      { basis: undefined },
      { rate: "0" },
      { rate: "abc" },
      { sequence: "0" },
      { sequence: "1000" },
      { sequence: "2.5" },
      { effectiveFrom: "" },
      { effectiveFrom: "2026-02-30" },
      { effectiveFrom: "26-01-01" },
      { effectiveFrom: "0026-01-01" },
      { effectiveFrom: "2101-01-01" },
      { effectiveTo: "2026-10-31" },
      { effectiveTo: "soon" },
    ];
    for (const bad of invalid)
      expect(validateTaxRule({ ...form, ...bad }), JSON.stringify(bad)).toEqual({ ok: false, code: "tax_invalid" });
  });
  it("accepts a rule that ends on its first day", () => {
    expect(validateTaxRule({ ...form, effectiveTo: "2026-11-01" }).ok).toBe(true);
  });
});

describe("validateTaxRuleEdit", () => {
  const form = {
    ruleId: A,
    name: "VAT",
    rate: "10",
    sequence: "2",
    effectiveFrom: "2026-01-01",
    effectiveTo: "",
    status: "active",
    compounds: "on",
  };
  it("reads the rate by the stored rule's kind, not by anything in the form", () => {
    expect(validateTaxRuleEdit(form, "percent")).toEqual({
      ok: true,
      value: {
        ruleId: A,
        name: "VAT",
        rateValue: 10,
        sequence: 2,
        compounds: true,
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
        status: "active",
      },
    });
    expect(validateTaxRuleEdit({ ...form, basis: "percent", rate: "250" }, "fixed_per_night")).toEqual({
      ok: true,
      value: {
        ruleId: A,
        name: "VAT",
        rateValue: 25000,
        sequence: 2,
        compounds: false,
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
        status: "active",
      },
    });
  });
  it("switches a rule off with the status field, and anything but 'inactive' means on", () => {
    const off = validateTaxRuleEdit({ ...form, status: "inactive" }, "percent");
    expect(off.ok && off.value.status).toBe("inactive");
    const odd = validateTaxRuleEdit({ ...form, status: "deleted" }, "percent");
    expect(odd.ok && odd.value.status).toBe("active");
  });
  it("refuses a blank order number instead of moving the rule, and a rule of an unknown kind", () => {
    expect(validateTaxRuleEdit({ ...form, sequence: "" }, "percent")).toEqual({ ok: false, code: "tax_invalid" });
    expect(validateTaxRuleEdit(form, "flat")).toEqual({ ok: false, code: "tax_invalid" });
    expect(validateTaxRuleEdit({ ...form, ruleId: "nope" }, "percent")).toEqual({ ok: false, code: "bad_request" });
  });
  it("refuses a last day before the first day", () => {
    expect(validateTaxRuleEdit({ ...form, effectiveTo: "2025-12-31" }, "percent")).toEqual({ ok: false, code: "tax_invalid" });
  });
});

describe("nextSequence", () => {
  it("goes after the highest order number, starts at 1, and stops at the limit", () => {
    expect(nextSequence([])).toBe(1);
    expect(nextSequence([{ sequence: 1 }, { sequence: 4 }, { sequence: 2 }])).toBe(5);
    expect(nextSequence([{ sequence: 999 }])).toBe(999);
  });
});

describe("doubleTaxes", () => {
  const other = { name: "VAT", status: "active", effective_from: "2026-01-01", effective_to: null as string | null };
  const cand = (over: Partial<typeof other>) => ({ ...other, ...over });
  it("flags a switched-on rule with the same name that overlaps in time, ignoring case and spacing", () => {
    expect(doubleTaxes(cand({ name: " vat " }), [other])).toBe(true);
    expect(doubleTaxes(cand({ name: "V  at", effective_from: "2030-01-01" }), [{ ...other, name: "v at" }])).toBe(true);
  });
  it("lets a new rule start the day after the old one ends, and the day it ends is shared", () => {
    const old = { ...other, effective_to: "2026-12-31" };
    expect(doubleTaxes(cand({ effective_from: "2027-01-01" }), [old])).toBe(false);
    expect(doubleTaxes(cand({ effective_from: "2026-12-31" }), [old])).toBe(true);
  });
  it("lets a rule ending before the other starts sit beside it", () => {
    expect(doubleTaxes(cand({ effective_from: "2025-01-01", effective_to: "2025-12-31" }), [other])).toBe(false);
  });
  it("ignores switched-off rules on either side and rules with other names", () => {
    expect(doubleTaxes(cand({}), [{ ...other, status: "inactive" }])).toBe(false);
    expect(doubleTaxes(cand({ status: "inactive" }), [other])).toBe(false);
    expect(doubleTaxes(cand({ name: "Tourism levy" }), [other])).toBe(false);
    expect(doubleTaxes(cand({}), [])).toBe(false);
  });
});

describe("rateInputValue", () => {
  it("prefills a percentage plainly and a fixed amount in naira", () => {
    expect(rateInputValue(rule({ rate_value: "7.5000" }))).toBe("7.5");
    expect(rateInputValue(rule({ rate_value: 5 }))).toBe("5");
    expect(rateInputValue(rule({ basis: "fixed_per_night", rate_value: "100000" }))).toBe("1000.00");
    expect(rateInputValue(rule({ rate_value: "x" }))).toBe("");
  });
});

describe("the columns the screen reads", () => {
  it("exist in the migrations, so a renamed column cannot slip past the tests", () => {
    const sql = ["20261026000005_pricing.sql", "20261026000027_folio_charges.sql"]
      .map((f) => readFileSync(join(process.cwd(), "supabase/migrations", f), "utf8"))
      .join("\n");
    const table = /create table tax_rules \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? "";
    const columns = new Set([...table.matchAll(/^\s{2}(\w+)\s/gm)].map((m) => m[1]));
    columns.add("applies_to_charges");
    for (const c of TAX_RULE_COLUMNS.split(",").map((s) => s.trim())) expect(columns.has(c), c).toBe(true);
  });
});

describe("fixed amount once per stay", () => {
  const form = {
    propertyId: P1,
    name: "Fee",
    basis: "percent",
    rate: "7.5",
    sequence: "",
    effectiveFrom: "2026-11-01",
    effectiveTo: "",
    compounds: "",
  };
  it("is described as a stay amount per room, and cannot be applied to extras", () => {
    expect(describeRate(rule({ basis: "fixed_per_stay", rate_value: 500000 }), naira)).toBe("₦5000.00 a stay, per room");
    expect(canApplyToExtras(rule({ basis: "fixed_per_stay" }))).toBe(false);
    expect(appliesLine(rule({ basis: "fixed_per_stay" }))).toMatch(/once for each room, on its first night.*Cannot be applied to extras/);
  });
  it("reads its amount like a nightly amount", () => {
    expect(parseRateValue("fixed_per_stay", "5,000")).toBe(500000);
    for (const bad of ["0", "-1", "10.999", "abc", ""]) expect(parseRateValue("fixed_per_stay", bad), bad).toBeNull();
  });
  it("is accepted when a rule is added and never as a compounding rule", () => {
    const r = validateTaxRule({
      ...form,
      name: "Destination fee",
      basis: "fixed_per_stay",
      rate: "5,000",
      compounds: "on",
      sequence: "4",
      effectiveFrom: "2027-01-01",
    });
    expect(r.ok && r.value.basis).toBe("fixed_per_stay");
    expect(r.ok && r.value.rateValue).toBe(500000);
    expect(r.ok && r.value.compounds).toBe(false);
    expect(validateTaxRule({ ...form, basis: "fixed_per_week", rate: "5,000" })).toEqual({ ok: false, code: "tax_invalid" });
  });
  it("is accepted when an existing rule is edited, taking its basis from the row", () => {
    expect(validateTaxRuleEdit({ ...form, ruleId: P1, rate: "6,000", sequence: "2" }, "fixed_per_stay").ok).toBe(true);
  });
});
