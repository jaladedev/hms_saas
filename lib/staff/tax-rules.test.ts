import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appliesLine, canApplyToExtras, classifyTaxError, describeRate, extrasTaxRules, parseToggle, ruleState, sortRules, TAX_RULE_COLUMNS, type TaxRuleRow } from "./tax-rules";

const A = "11111111-1111-4111-8111-111111111111";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const rule = (over: Partial<TaxRuleRow>): TaxRuleRow => ({
  id: A, property_id: P1, name: "VAT", basis: "percent", rate_value: 7.5, sequence: 1, compounds: false,
  effective_from: "2026-01-01", effective_to: null, status: "active", applies_to_charges: false, ...over,
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
    for (const bad of [{ ruleId: "nope", apply: "on" }, { ruleId: A, apply: "yes" }, { ruleId: A }, {}]) expect(parseToggle(bad)).toEqual({ ok: false });
  });
});

describe("classifyTaxError", () => {
  it("separates a permission refusal from a fixed rule and keeps the rest unknown", () => {
    expect(classifyTaxError({ code: "42501" })).toBe("tax_forbidden");
    expect(classifyTaxError({ message: 'new row violates row-level security policy for table "tax_rules"' })).toBe("tax_forbidden");
    expect(classifyTaxError({ code: "23514", message: 'violates check constraint "tax_rules_charges_percent_only"' })).toBe("tax_not_percent");
    expect(classifyTaxError({ code: "XX000", message: "boom" })).toBe("unknown");
  });
});

describe("the columns the screen reads", () => {
  it("exist in the migrations, so a renamed column cannot slip past the tests", () => {
    const sql = ["20261026000005_pricing.sql", "20261026000027_folio_charges.sql"].map((f) => readFileSync(join(process.cwd(), "supabase/migrations", f), "utf8")).join("\n");
    const table = /create table tax_rules \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? "";
    const columns = new Set([...table.matchAll(/^\s{2}(\w+)\s/gm)].map((m) => m[1]));
    columns.add("applies_to_charges");
    for (const c of TAX_RULE_COLUMNS.split(",").map((s) => s.trim())) expect(columns.has(c), c).toBe(true);
  });
});
