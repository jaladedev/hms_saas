import { describe, expect, it } from "vitest";
import {
  classifyInvError,
  formatQty,
  parseCountForm,
  parseItemForm,
  parseItems,
  parseOutForm,
  parsePurchaseForm,
  parseQty,
  parseRecipeForm,
  parseStockReport,
  parseSupplierForm,
} from "./inventory";

const P = "00000000-0000-0000-0000-0000000000a2";
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const KEY = "abcdefgh12345";

describe("quantities", () => {
  it("accepts up to three decimals and a comma", () => {
    expect(parseQty("2.5")).toBe(2.5);
    expect(parseQty("2,25")).toBe(2.25);
    expect(parseQty("0.001")).toBe(0.001);
  });
  it("refuses zero, negatives, junk and four decimals", () => {
    for (const s of ["0", "-1", "", "abc", "1.2345", "1e3", "9999999999"]) expect(parseQty(s)).toBeNull();
    expect(parseQty("0", true)).toBe(0);
  });
  it("formats without trailing zeros", () => {
    expect(formatQty(2.5)).toBe("2.5");
    expect(formatQty(-13.5)).toBe("-13.5");
    expect(formatQty(10)).toBe("10");
  });
});

describe("error words", () => {
  it("maps database refusals to codes", () => {
    expect(classifyInvError("NOT_FOUND")).toBe("inv_forbidden");
    expect(classifyInvError("POLICY_VIOLATION: inventory off")).toBe("inv_off");
    expect(classifyInvError("POLICY_VIOLATION: name taken")).toBe("inv_name_taken");
    expect(classifyInvError("POLICY_VIOLATION: not enough stock")).toBe("inv_short");
    expect(classifyInvError("POLICY_VIOLATION: supplier")).toBe("inv_supplier");
    expect(classifyInvError("POLICY_VIOLATION: line")).toBe("inv_invalid");
    expect(classifyInvError("IDEMPOTENCY_MISMATCH")).toBe("inv_reused");
    expect(classifyInvError("boom")).toBe("inv_failed");
  });
});

describe("reading", () => {
  it("reads items and flags low and negative stock", () => {
    const items = parseItems([
      { id: A, name: "Rice", unit: "kg", kind: "food", low_level: "5.000", quantity: "4.5", is_active: true },
      { id: B, name: "Soap", unit: "piece", kind: "weird", low_level: 0, quantity: -2, is_active: false },
    ]);
    expect(items[0]).toMatchObject({ low: true, quantity: 4.5, lowLevel: 5 });
    expect(items[1]).toMatchObject({ low: false, kind: "other", isActive: false });
    expect(parseItems(null)).toEqual([]);
  });
  it("keeps hidden money as null", () => {
    const r = parseStockReport({
      from: "2026-11-01",
      to: "2026-11-19",
      spent_minor: null,
      items: [{ item_id: A, name: "Rice", spent_minor: null, bought: 20 }],
    });
    expect(r.spentMinor).toBeNull();
    expect(r.items[0]?.spentMinor).toBeNull();
    expect(r.items[0]?.bought).toBe(20);
    expect(parseStockReport(5).items).toEqual([]);
  });
});

describe("item and supplier forms", () => {
  it("accepts a good item and refuses bad ones", () => {
    const ok = parseItemForm({ propertyId: P, name: "Rice", unit: "kg", kind: "food", low: "5", active: "on" });
    expect(ok).toMatchObject({ ok: true, value: { low: 5, active: true, itemId: null } });
    expect(parseItemForm({ propertyId: P, name: "", unit: "kg", kind: "food" }).ok).toBe(false);
    expect(parseItemForm({ propertyId: P, name: "x", unit: "kg", kind: "gold" }).ok).toBe(false);
    expect(parseItemForm({ propertyId: P, name: "x", unit: "kg", kind: "food", low: "-1" }).ok).toBe(false);
    expect(parseItemForm({ propertyId: "nope", name: "x", unit: "kg", kind: "food" }).ok).toBe(false);
  });
  it("supplier needs a name", () => {
    expect(parseSupplierForm({ propertyId: P, name: "Mama Put", phone: "0803" }).ok).toBe(true);
    expect(parseSupplierForm({ propertyId: P, name: " " }).ok).toBe(false);
  });
});

describe("use and waste form", () => {
  const base = { itemId: A, kind: "usage", quantity: "2", reason: "minibar", key: KEY };
  it("checks the reason against the kind", () => {
    expect(parseOutForm(base).ok).toBe(true);
    expect(parseOutForm({ ...base, kind: "waste", reason: "spoiled" }).ok).toBe(true);
    expect(parseOutForm({ ...base, kind: "waste", reason: "minibar" }).ok).toBe(false);
    expect(parseOutForm({ ...base, reason: "party" }).ok).toBe(false);
    expect(parseOutForm({ ...base, kind: "sale" }).ok).toBe(false);
    expect(parseOutForm({ ...base, quantity: "0" }).ok).toBe(false);
    expect(parseOutForm({ ...base, key: "x" }).ok).toBe(false);
  });
});

describe("purchase form", () => {
  const base = { propertyId: P, key: KEY };
  it("collects filled rows, skips empty ones and converts cost to kobo", () => {
    const v = parsePurchaseForm({
      ...base,
      item_1: A,
      qty_1: "20",
      cost_1: "1200",
      item_2: "",
      qty_2: "",
      cost_2: "",
      item_3: B,
      qty_3: "2.5",
      cost_3: "",
    });
    expect(v).toMatchObject({ ok: true });
    if (v.ok)
      expect(v.value.lines).toEqual([
        { item: A, quantity: 20, unit_cost_minor: 120000 },
        { item: B, quantity: 2.5, unit_cost_minor: 0 },
      ]);
  });
  it("refuses no rows, a half row, a repeated item and bad numbers", () => {
    expect(parsePurchaseForm(base).ok).toBe(false);
    expect(parsePurchaseForm({ ...base, item_1: A }).ok).toBe(false);
    expect(parsePurchaseForm({ ...base, item_1: A, qty_1: "1", item_2: A, qty_2: "2" }).ok).toBe(false);
    expect(parsePurchaseForm({ ...base, item_1: A, qty_1: "0" }).ok).toBe(false);
    expect(parsePurchaseForm({ ...base, item_1: A, qty_1: "1", cost_1: "abc" }).ok).toBe(false);
  });
});

describe("count form", () => {
  it("skips blank boxes and keeps zero", () => {
    const v = parseCountForm({ propertyId: P, key: KEY, [`count_${A}`]: "0", [`count_${B}`]: "" });
    expect(v).toMatchObject({ ok: true, value: { counts: [{ item: A, counted: 0 }] } });
  });
  it("refuses an empty count, a bad number or a bad id", () => {
    expect(parseCountForm({ propertyId: P, key: KEY, [`count_${A}`]: "" }).ok).toBe(false);
    expect(parseCountForm({ propertyId: P, key: KEY, [`count_${A}`]: "-1" }).ok).toBe(false);
    expect(parseCountForm({ propertyId: P, key: KEY, count_zzz: "1" }).ok).toBe(false);
  });
});

describe("recipe form", () => {
  it("no rows clears the recipe; repeats are refused", () => {
    expect(parseRecipeForm({ posItemId: A })).toMatchObject({ ok: true, value: { lines: [] } });
    expect(parseRecipeForm({ posItemId: A, item_1: B, qty_1: "0.3" })).toMatchObject({
      ok: true,
      value: { lines: [{ item: B, quantity: 0.3 }] },
    });
    expect(parseRecipeForm({ posItemId: A, item_1: B, qty_1: "1", item_2: B, qty_2: "1" }).ok).toBe(false);
    expect(parseRecipeForm({ posItemId: A, item_1: B }).ok).toBe(false);
  });
});
