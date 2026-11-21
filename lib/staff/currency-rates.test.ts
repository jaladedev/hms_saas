import { describe, expect, it } from "vitest";
import { isSupportedCurrency, PAYSTACK_COUNTRY } from "@/lib/currency";
import { classifyFxError, parseRateForm, parseRates } from "./currency-rates";

const P = "00000000-0000-0000-0000-0000000000a2";

describe("currencies", () => {
  it("knows the five Paystack currencies", () => {
    expect(["NGN", "GHS", "KES", "ZAR", "USD"].every(isSupportedCurrency)).toBe(true);
    expect(isSupportedCurrency("EUR")).toBe(false);
    expect(isSupportedCurrency("ngn")).toBe(false);
  });
  it("asks Paystack for the right country's banks", () => {
    expect(PAYSTACK_COUNTRY.NGN).toBe("nigeria");
    expect(PAYSTACK_COUNTRY.GHS).toBe("ghana");
    expect(PAYSTACK_COUNTRY.USD).toBeNull();
  });
});

describe("error words", () => {
  it("maps database refusals to codes", () => {
    expect(classifyFxError("NOT_FOUND")).toBe("fx_forbidden");
    expect(classifyFxError("POLICY_VIOLATION: multi_currency off")).toBe("fx_off");
    expect(classifyFxError("POLICY_VIOLATION: currency")).toBe("fx_currency");
    expect(classifyFxError("POLICY_VIOLATION: rate")).toBe("fx_rate");
    expect(classifyFxError("POLICY_VIOLATION: date")).toBe("fx_date");
    expect(classifyFxError("POLICY_VIOLATION: text")).toBe("fx_invalid");
    expect(classifyFxError("boom")).toBe("fx_failed");
  });
});

describe("rate form", () => {
  const good = { propertyId: P, from: "usd", to: "NGN", date: "2026-11-01", rate: "1,450.5", note: " CBN " };
  it("reads a rate", () => {
    expect(parseRateForm(good)).toEqual({
      ok: true,
      value: { propertyId: P, from: "USD", to: "NGN", date: "2026-11-01", rate: "1450.5", note: "CBN" },
    });
  });
  it("refuses bad currencies, rates and dates", () => {
    expect(parseRateForm({ ...good, to: "USD" })).toEqual({ ok: false, code: "fx_currency" });
    expect(parseRateForm({ ...good, from: "EUR" })).toEqual({ ok: false, code: "fx_currency" });
    expect(parseRateForm({ ...good, rate: "0" })).toEqual({ ok: false, code: "fx_rate" });
    expect(parseRateForm({ ...good, rate: "1.123456789" })).toEqual({ ok: false, code: "fx_rate" });
    expect(parseRateForm({ ...good, rate: "-3" })).toEqual({ ok: false, code: "fx_rate" });
    expect(parseRateForm({ ...good, date: "yesterday" })).toEqual({ ok: false, code: "fx_date" });
    expect(parseRateForm({ ...good, propertyId: "x" }).ok).toBe(false);
  });
});

describe("reading rows", () => {
  it("trims trailing zeros and skips unknown currencies", () => {
    const rows = parseRates([
      { id: "1", from_currency: "NGN", to_currency: "USD", rate_date: "2026-11-01", rate: "0.00062000", note: null },
      { id: "2", from_currency: "NGN", to_currency: "EUR", rate_date: "2026-11-01", rate: "1" },
      { id: "3", from_currency: "USD", to_currency: "NGN", rate_date: "2026-11-02", rate: "1450.00000000", note: "CBN" },
    ]);
    expect(rows.map((r) => r.rate)).toEqual(["0.00062", "1450"]);
    expect(rows[1]?.note).toBe("CBN");
    expect(parseRates(null)).toEqual([]);
  });
});
