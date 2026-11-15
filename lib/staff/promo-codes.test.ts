import { describe, expect, it } from "vitest";
import { parsePromoForm, parsePromoList, promoValueText, promoWindowText } from "./promo-codes";

const P = "00000000-0000-0000-0000-0000000000a2";
const base = {
  propertyId: P,
  promoId: "",
  code: " spring10 ",
  kind: "percent",
  percent: "10",
  validFrom: "",
  validTo: "",
  minNights: "",
  maxUses: "",
  active: "on",
};

describe("parsePromoForm", () => {
  it("reads a percentage code, capitalising it and defaulting the limits", () => {
    const r = parsePromoForm(base);
    expect(r).toEqual({
      ok: true,
      value: {
        propertyId: P,
        promoId: null,
        code: "SPRING10",
        kind: "percent",
        value: 10,
        validFrom: "",
        validTo: "",
        minNights: 1,
        maxUses: null,
        active: true,
      },
    });
  });
  it("reads an amount in naira as minor units", () => {
    const r = parsePromoForm({ ...base, kind: "amount", amount: "5,000.50", active: undefined });
    expect(r.ok && r.value).toMatchObject({ kind: "amount", value: 500050, active: false });
  });
  it("refuses a percentage outside 1 to 90 and an amount of 0", () => {
    for (const percent of ["0", "91", "100", "5.555", "abc", ""])
      expect(parsePromoForm({ ...base, percent })).toEqual({ ok: false, code: "promo_invalid" });
    expect(parsePromoForm({ ...base, kind: "amount", amount: "0" })).toEqual({ ok: false, code: "promo_invalid" });
    expect(parsePromoForm({ ...base, kind: "amount", amount: "" })).toEqual({ ok: false, code: "promo_invalid" });
  });
  it("refuses bad codes, kinds, ids and limits", () => {
    for (const patch of [
      { code: "ab" },
      { code: "has space" },
      { code: "x".repeat(25) },
      { kind: "free" },
      { propertyId: "x" },
      { promoId: "x" },
      { minNights: "0" },
      { minNights: "31" },
      { maxUses: "0" },
      { maxUses: "1.5" },
    ]) {
      expect(parsePromoForm({ ...base, ...patch })).toEqual({ ok: false, code: "promo_invalid" });
    }
  });
  it("checks the dates", () => {
    expect(parsePromoForm({ ...base, validFrom: "2027-02-30" })).toEqual({ ok: false, code: "promo_dates" });
    expect(parsePromoForm({ ...base, validFrom: "2027-03-02", validTo: "2027-03-01" })).toEqual({ ok: false, code: "promo_dates" });
    expect(parsePromoForm({ ...base, validFrom: "2027-03-01", validTo: "2027-03-01" }).ok).toBe(true);
  });
});

describe("list and wording", () => {
  const row = {
    id: "1",
    code: "A1B",
    kind: "percent",
    percent: 10,
    amount_minor: null,
    valid_from: null,
    valid_to: null,
    min_nights: 2,
    max_uses: 5,
    is_active: true,
    ever_used: false,
    used: 1,
    remaining: 4,
  };
  it("drops malformed rows", () => {
    expect(parsePromoList([row, { id: "2" }, null, { ...row, id: "3", kind: "other" }]).map((r) => r.id)).toEqual(["1"]);
    expect(parsePromoList(null)).toEqual([]);
  });
  it("words the value and the window", () => {
    expect(promoValueText({ kind: "percent", percent: 10, amount_minor: null }, String)).toBe("10% off");
    expect(promoValueText({ kind: "amount", percent: null, amount_minor: 50000 }, (m) => `N${m / 100}`)).toBe("N500 off");
    const d = (s: string) => s;
    expect(promoWindowText(null, null, d)).toBe("any day");
    expect(promoWindowText("a", null, d)).toBe("from a");
    expect(promoWindowText(null, "b", d)).toBe("until b");
    expect(promoWindowText("a", "b", d)).toBe("a to b");
  });
});
