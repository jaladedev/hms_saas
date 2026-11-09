import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  actionsFor, actorName, collectIds, describeEvent, entityName, FILTER_ACTIONS, fieldLabel, formatValue, historyQuery, parseHistoryFilters,
  type AuditRow, type Format, type Lookup,
} from "./setup-history";

const RT = "11111111-1111-4111-8111-111111111111";
const RM = "22222222-2222-4222-8222-222222222222";
const TX = "33333333-3333-4333-8333-333333333333";
const RP = "44444444-4444-4444-8444-444444444444";
const U1 = "55555555-5555-4555-8555-555555555555";
const U2 = "66666666-6666-4666-8666-666666666666";
const P1 = "77777777-7777-4777-8777-777777777777";

const fmt: Format = { money: (m) => `₦${(m / 100).toFixed(2)}`, date: (d) => `d:${d}` };
const lookup = (over: Partial<Lookup> = {}): Lookup => ({
  roomTypes: new Map([[RT, "Deluxe"]]), rooms: new Map([[RM, "101"]]), ratePlans: new Map([[RP, "Standard"]]),
  taxRules: new Map([[TX, { name: "VAT", basis: "percent" }]]), people: new Map([[U1, "Ada Owner"], [U2, "Tunde"]]),
  roles: new Map([["front_desk", "Front desk"]]), properties: new Map([[P1, "Main House"]]), ...over,
});
const row = (over: Partial<AuditRow>): AuditRow => ({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", property_id: P1, actor_user_id: U1, action: "room_type.updated", entity_type: "room_type", entity_id: RT,
  metadata: {}, created_at: "2026-11-01T10:00:00Z", ...over,
});

describe("filters", () => {
  it("reads property, what and page, and falls back to the defaults for anything else", () => {
    expect(parseHistoryFilters({})).toEqual({ property: null, what: "all", page: 1 });
    expect(parseHistoryFilters({ property: P1, what: "tax", page: "3" })).toEqual({ property: P1, what: "tax", page: 3 });
    expect(parseHistoryFilters({ property: "nope", what: "everything", page: "0" })).toEqual({ property: null, what: "all", page: 1 });
    expect(parseHistoryFilters({ page: "2.5" }).page).toBe(1);
    expect(parseHistoryFilters({ page: ["4", "5"] }).page).toBe(4);
  });
  it("leaves defaults out of the link", () => {
    expect(historyQuery({ property: null, what: "all", page: 1 })).toBe("");
    expect(historyQuery({ property: P1, what: "rates", page: 2 })).toBe(`?property=${P1}&what=rates&page=2`);
    expect(historyQuery({ property: null, what: "all", page: 2 }, { page: 1 })).toBe("");
  });
  it("names actions outright, so room.blocked and room.transferred are never shown as setup", () => {
    const all = actionsFor("all");
    expect(all).toEqual(Object.values(FILTER_ACTIONS).flat());
    for (const notSetup of ["room.blocked", "room.transferred", "room.housekeeping_set", "reservation.cancelled"]) expect(all).not.toContain(notSetup);
    expect(actionsFor("tax")).toEqual(["tax_rule.created", "tax_rule.updated", "tax_rule.deleted"]);
  });
  it("only lists actions the database really writes", () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const sql = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    const entities = new Set([...sql.matchAll(/audit_setup_row\('(\w+)'/g)].map((m) => m[1]));
    for (const action of [...FILTER_ACTIONS.rooms, ...FILTER_ACTIONS.tax, "rate_plan.created", "rate_plan.updated", "rate_plan.deleted"]) {
      const [entity, verb] = action.split(".");
      expect(entities.has(entity!), action).toBe(true);
      expect(["created", "updated", "deleted"]).toContain(verb);
    }
    for (const literal of ["rates.set", "rates.changed", "rates.cleared", ...FILTER_ACTIONS.staff]) expect(sql.includes(`'${literal}'`), literal).toBe(true);
  });
});

describe("collectIds", () => {
  it("collects what needs a name, from the row and from inside its metadata, once each", () => {
    const rows = [
      row({}), row({ action: "rates.set", metadata: { rate_plan_id: RP } }),
      row({ action: "room.updated", entity_type: "room", entity_id: RM, metadata: { changed: { room_type_id: { from: RT, to: "88888888-8888-4888-8888-888888888888" } } } }),
      row({ action: "tax_rule.updated", entity_type: "tax_rule", entity_id: TX, actor_user_id: U2 }),
      row({ action: "staff.role_added", entity_type: "membership", entity_id: null, metadata: { user_id: U2, role: "front_desk" } }),
      row({ actor_user_id: null, metadata: { values: { room_type_id: "not-an-id" } } }),
    ];
    const ids = collectIds(rows);
    expect(ids.roomTypes.sort()).toEqual([RT, "88888888-8888-4888-8888-888888888888"].sort());
    expect(ids.rooms).toEqual([RM]);
    expect(ids.ratePlans).toEqual([RP]);
    expect(ids.taxRules).toEqual([TX]);
    expect(ids.users.sort()).toEqual([U1, U2].sort());
  });
});

describe("actorName", () => {
  it("names the person, or says who it cannot", () => {
    expect(actorName({ actor_user_id: U1 }, lookup().people)).toBe("Ada Owner");
    expect(actorName({ actor_user_id: "99999999-9999-4999-8999-999999999999" }, lookup().people)).toBe("A staff member");
    expect(actorName({ actor_user_id: null }, lookup().people)).toBe("The system");
  });
});

describe("formatValue and labels", () => {
  const L = lookup();
  it("words money, booleans, dates, words and missing values", () => {
    expect(formatValue("base_rate_minor", 4500000, L, fmt)).toBe("₦45000.00");
    expect(formatValue("base_rate_minor", "4500000", L, fmt)).toBe("₦45000.00");
    expect(formatValue("is_public", true, L, fmt)).toBe("Yes");
    expect(formatValue("amenities", ["Wi-Fi", "Safe"], L, fmt)).toBe("Wi-Fi, Safe");
    expect(formatValue("amenities", [], L, fmt)).toBe("none");
    expect(formatValue("bed_config", [{ type: "queen" }], L, fmt)).toBe("changed");
    expect(fieldLabel("amenities")).toBe("Amenities");
    expect(formatValue("compounds", false, L, fmt)).toBe("No");
    expect(formatValue("effective_from", "2026-11-01", L, fmt)).toBe("d:2026-11-01");
    expect(formatValue("effective_to", null, L, fmt)).toBe("none");
    expect(formatValue("status", "inactive", L, fmt)).toBe("Switched off");
    expect(formatValue("operational_status", "out_of_service", L, fmt)).toBe("Out of service");
    expect(formatValue("room_type_id", RT, L, fmt)).toBe("Deluxe");
    expect(formatValue("room_type_id", "x", L, fmt)).toBe("another room type");
    expect(formatValue("cancellation_policy", { a: 1 }, L, fmt)).toBe("changed");
  });
  it("reads a tax rate by the rule's kind", () => {
    expect(formatValue("rate_value", "7.5000", L, fmt, "percent")).toBe("7.5%");
    expect(formatValue("rate_value", 100000, L, fmt, "fixed_per_night")).toBe("₦1000.00 a night");
    expect(formatValue("rate_value", 5, L, fmt, null)).toBe("5");
  });
  it("labels known columns and makes a readable label for an unknown one", () => {
    expect(fieldLabel("base_rate_minor")).toBe("Standard price a night");
    expect(fieldLabel("some_new_column")).toBe("Some new column");
  });
});

describe("entityName", () => {
  it("prefers the live name, then the name stored with the row, then a plain noun", () => {
    expect(entityName(row({}), lookup())).toBe("Deluxe");
    expect(entityName(row({ metadata: { values: { name: "Old Suite" } } }), lookup({ roomTypes: new Map() }))).toBe("Old Suite");
    expect(entityName(row({}), lookup({ roomTypes: new Map() }))).toBe("a room type");
    expect(entityName(row({ entity_type: "room", entity_id: RM }), lookup())).toBe("room 101");
    expect(entityName(row({ entity_type: "room", entity_id: RM }), lookup({ rooms: new Map() }))).toBe("a room");
  });
});

describe("describeEvent", () => {
  it("shows an edit as from and to", () => {
    const e = describeEvent(row({ metadata: { changed: { base_rate_minor: { from: 4000000, to: 4500000 }, is_public: { from: false, to: true } } } }), lookup(), fmt);
    expect(e.summary).toBe("Changed the room type \u201cDeluxe\u201d");
    expect(e.details).toEqual(["Standard price a night: ₦40000.00 \u2192 ₦45000.00", "Bookable online: No \u2192 Yes"]);
  });
  it("shows an amenities change as the old and new list, and any other structure only as changed", () => {
    const e = describeEvent(row({ metadata: { changed: {
      amenities: { from: [], to: ["Air conditioning", "Wi-Fi"] },
      bed_config: { from: [], to: [{ type: "queen" }] },
    } } }), lookup(), fmt);
    expect(e.details).toEqual(["Amenities: none \u2192 Air conditioning, Wi-Fi", "Beds changed"]);
    const back = describeEvent(row({ metadata: { changed: { amenities: { from: ["Safe"], to: [] } } } }), lookup(), fmt);
    expect(back.details).toEqual(["Amenities: Safe \u2192 none"]);
  });
  it("shows a new tax rule with its rate in the right unit and leaves out empty values", () => {
    const e = describeEvent(row({
      action: "tax_rule.created", entity_type: "tax_rule", entity_id: TX,
      metadata: { values: { name: "VAT", basis: "percent", rate_value: 7.5, compounds: false, effective_from: "2026-11-01", effective_to: null, applies_to_charges: false } },
    }), lookup(), fmt);
    expect(e.summary).toBe("Added the tax rule \u201cVAT\u201d");
    expect(e.details).toContain("Rate: 7.5%");
    expect(e.details).toContain("Kind of tax: A percentage of the night's price");
    expect(e.details).toContain("Taxes extras: No");
    expect(e.details.some((d) => d.startsWith("Last day"))).toBe(false);
  });
  it("reads a tax rate edit by the rule's stored kind", () => {
    const e = describeEvent(row({ action: "tax_rule.updated", entity_type: "tax_rule", entity_id: TX, metadata: { changed: { rate_value: { from: 7.5, to: 10 } } } }), lookup(), fmt);
    expect(e.details).toEqual(["Rate: 7.5% \u2192 10%"]);
  });
  it("words a removed thing from the name stored with the row when it is gone", () => {
    const e = describeEvent(row({ action: "room.deleted", entity_type: "room", entity_id: RM, metadata: { values: { room_number: "205", floor: 2 } } }), lookup({ rooms: new Map() }), fmt);
    expect(e.summary).toBe("Removed room 205");
    expect(e.details).toEqual(["Room number: 205", "Floor: 2"]);
  });
  it("summarises nightly price changes", () => {
    const base = { rate_plan_id: RP, nights: 9, from: "2026-12-20", to: "2026-12-28" };
    const set = describeEvent(row({ action: "rates.set", metadata: { ...base, amount_minor_min: 5000000, amount_minor_max: 6000000 } }), lookup(), fmt);
    expect(set.summary).toBe("Set nightly prices for the room type \u201cDeluxe\u201d");
    expect(set.details).toEqual(["9 nights: d:2026-12-20 to d:2026-12-28", "Price: ₦50000.00 to ₦60000.00"]);
    const changed = describeEvent(row({ action: "rates.changed", metadata: { ...base, nights: 1, to: "2026-12-20", old_amount_minor_min: 5000000, old_amount_minor_max: 5000000, new_amount_minor_min: 5500000, new_amount_minor_max: 5500000 } }), lookup(), fmt);
    expect(changed.details).toEqual(["1 night: d:2026-12-20", "Price: ₦50000.00 \u2192 ₦55000.00"]);
    const cleared = describeEvent(row({ action: "rates.cleared", metadata: { ...base, old_amount_minor_min: 5000000, old_amount_minor_max: 5000000 } }), lookup(), fmt);
    expect(cleared.summary).toMatch(/^Cleared nightly prices for the room type/);
    expect(cleared.details[1]).toBe("Was: ₦50000.00");
  });
  it("words staff access changes", () => {
    const added = describeEvent(row({ action: "staff.role_added", entity_type: "membership", entity_id: null, metadata: { user_id: U2, role: "front_desk", property_id: P1, new_member: false } }), lookup(), fmt);
    expect(added.summary).toBe("Gave Tunde the role Front desk");
    expect(added.details).toEqual(["Covers: Main House"]);
    const first = describeEvent(row({ action: "staff.role_added", entity_type: "membership", entity_id: null, metadata: { user_id: U2, role: "front_desk", property_id: null, new_member: true } }), lookup(), fmt);
    expect(first.summary).toBe("Added Tunde as Front desk");
    expect(first.details).toEqual(["Covers: all properties"]);
    const removed = describeEvent(row({ action: "staff.role_removed", entity_type: "membership", entity_id: null, metadata: { user_id: "99999999-9999-4999-8999-999999999999", role: "unknown_role" } }), lookup(), fmt);
    expect(removed.summary).toBe("Removed the role unknown_role from a staff member");
  });
  it("copes with missing metadata and unknown actions without throwing", () => {
    expect(describeEvent(row({ metadata: null }), lookup(), fmt)).toEqual({ summary: "Changed the room type \u201cDeluxe\u201d", details: [] });
    expect(describeEvent(row({ action: "mystery.thing" }), lookup(), fmt)).toEqual({ summary: "mystery.thing", details: [] });
    expect(describeEvent(row({ action: "rates.set", metadata: {} }), lookup(), fmt).details).toEqual([]);
  });
  it("does not show a policy's contents, only that it changed", () => {
    const e = describeEvent(row({ action: "rate_plan.updated", entity_type: "rate_plan", entity_id: RP, metadata: { changed: { cancellation_policy: { from: { a: 1 }, to: { a: 2 } } } } }), lookup(), fmt);
    expect(e.details).toEqual(["Cancellation policy changed"]);
  });
});

describe("policy versions", () => {
  const policyRow = row({
    action: "property_policy.created", entity_type: "property_policy", entity_id: "99999999-9999-4999-8999-999999999999",
    metadata: { values: { version: 4, effective_from: "2026-11-09", config: {
      online_payment: { mode: "deposit_percent", value: 30 },
      cancellation_rules: [{ within_hours: 48, charge: { type: "percent", value: 50 } }],
    } } },
  });
  it("is listed under its own filter and under everything", () => {
    expect(actionsFor("policies")).toEqual(["property_policy.created"]);
    expect(actionsFor("all")).toContain("property_policy.created");
    expect(parseHistoryFilters({ what: "policies" }).what).toBe("policies");
  });
  it("words a published version with its start date and what guests are told", () => {
    const e = describeEvent(policyRow, lookup(), fmt);
    expect(e.summary).toBe("Published policy version 4, starting d:2026-11-09");
    expect(e.details).toEqual([
      "Pay a 30% deposit online to confirm your booking. The balance is due at the hotel.",
      "Cancel free of charge until 2 days before check-in.",
      "Within 2 days of check-in, you pay 50% of the total.",
    ]);
  });
  it("copes with a row that has no values", () => {
    expect(describeEvent(row({ action: "property_policy.created", entity_type: "property_policy", metadata: null }), lookup(), fmt).summary).toBe("Published a new policy version");
  });
});
