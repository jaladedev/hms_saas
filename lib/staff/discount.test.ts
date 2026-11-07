import { describe, expect, it } from "vitest";
import { classifyDiscountError, discountView, parseDiscountForm, parsePercent, resultCode } from "./discount";

describe("discountView", () => {
  const base = { canApply: true, reservationStatus: "confirmed", paymentCount: 0, liveInvoiceCount: 0, currentPercent: null };
  it("is editable on an unpaid, uninvoiced, confirmed booking for someone who may discount", () => {
    expect(discountView(base)).toEqual({ kind: "editable", currentPercent: null });
    expect(discountView({ ...base, currentPercent: 10 })).toEqual({ kind: "editable", currentPercent: 10 });
  });
  it("stays quiet for people who may not, and for bookings that are not confirmed", () => {
    expect(discountView({ ...base, canApply: false })).toEqual({ kind: "hidden" });
    for (const s of ["pending", "cancelled", "checked_in", "checked_out", "no_show", "expired"]) expect(discountView({ ...base, reservationStatus: s })).toEqual({ kind: "hidden" });
  });
  it("says why when money stops it", () => {
    expect(discountView({ ...base, paymentCount: 1 })).toEqual({ kind: "blocked", why: "paid" });
    expect(discountView({ ...base, liveInvoiceCount: 1 })).toEqual({ kind: "blocked", why: "invoiced" });
  });
});

describe("parsePercent", () => {
  it("accepts 0 to 100 with up to two decimals, and a trailing %", () => {
    expect(parsePercent("10")).toBe(10);
    expect(parsePercent(" 7.5% ")).toBe(7.5);
    expect(parsePercent("0")).toBe(0);
    expect(parsePercent("100")).toBe(100);
    expect(parsePercent("12.25")).toBe(12.25);
  });
  it("refuses everything else", () => {
    for (const bad of ["", "abc", "-1", "100.01", "101", "5.555", "1e2", "10,5", undefined, null, 10]) expect(parsePercent(bad), String(bad)).toBeNull();
  });
});

describe("parseDiscountForm", () => {
  it("needs a percent and a reason", () => {
    expect(parseDiscountForm({ percent: "10", reason: " loyal guest " })).toEqual({ ok: true, value: { percent: 10, reason: "loyal guest" } });
    expect(parseDiscountForm({ percent: "x", reason: "r" })).toEqual({ ok: false, code: "dc_percent" });
    expect(parseDiscountForm({ percent: "10", reason: "  " })).toEqual({ ok: false, code: "dc_reason" });
    expect(parseDiscountForm({ percent: "10", reason: "x".repeat(201) })).toEqual({ ok: false, code: "dc_reason" });
  });
});

describe("classifyDiscountError", () => {
  it("maps every refusal the function raises", () => {
    const cases: [string, string][] = [
      ["POLICY_VIOLATION: percent", "dc_percent"], ["POLICY_VIOLATION: reason", "dc_reason"], ["POLICY_VIOLATION: discount limit 10", "dc_limit"],
      ["INVALID_STATE: money held", "se_paid"], ["INVALID_STATE: invoice", "se_invoiced"], ["INVALID_STATE: payment in progress", "se_payment_started"],
      ["INVALID_STATE: cancelled", "dc_status"], ["NOT_FOUND", "not_found"], ["IDEMPOTENCY_MISMATCH", "se_duplicate"], ["boom", "unknown"],
    ];
    for (const [m, c] of cases) expect(classifyDiscountError(m), m).toBe(c);
  });
});

describe("resultCode", () => {
  it("tells set, removed and unchanged apart", () => {
    expect(resultCode({ changed: true, discount_percent: 10 })).toBe("discount_set");
    expect(resultCode({ changed: true, discount_percent: 0 })).toBe("discount_removed");
    expect(resultCode({ changed: false, discount_percent: 10 })).toBe("discount_unchanged");
  });
});
