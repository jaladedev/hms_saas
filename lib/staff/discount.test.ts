import { describe, expect, it } from "vitest";
import { classifyDiscountError, discountView, parseAmount, parseDiscountForm, parsePercent, resultCode } from "./discount";

describe("discountView", () => {
  const base = { canApply: true, reservationStatus: "confirmed", liveInvoiceCount: 0, current: { kind: "none" } as const };
  it("is editable on an unpaid, uninvoiced, confirmed booking for someone who may discount", () => {
    expect(discountView(base)).toEqual({ kind: "editable", current: { kind: "none" } });
    expect(discountView({ ...base, current: { kind: "percent", percent: 10 } })).toEqual({ kind: "editable", current: { kind: "percent", percent: 10 } });
    expect(discountView({ ...base, current: { kind: "amount", amountMinor: 500000 } })).toEqual({ kind: "editable", current: { kind: "amount", amountMinor: 500000 } });
  });
  it("stays quiet for people who may not, and for bookings that are not confirmed", () => {
    expect(discountView({ ...base, canApply: false })).toEqual({ kind: "hidden" });
    for (const s of ["pending", "cancelled", "checked_in", "checked_out", "no_show", "expired"]) expect(discountView({ ...base, reservationStatus: s })).toEqual({ kind: "hidden" });
  });
  it("is still offered when money has been paid, and blocked by a live invoice", () => {
    expect(discountView({ ...base }).kind).toBe("editable");
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
    expect(parseDiscountForm({ percent: "10", reason: " loyal guest " })).toEqual({ ok: true, value: { kind: "percent", percent: 10, reason: "loyal guest" } });
    expect(parseDiscountForm({ percent: "x", reason: "r" })).toEqual({ ok: false, code: "dc_percent" });
    expect(parseDiscountForm({ percent: "10", reason: "  " })).toEqual({ ok: false, code: "dc_reason" });
    expect(parseDiscountForm({ percent: "10", reason: "x".repeat(201) })).toEqual({ ok: false, code: "dc_reason" });
  });
});

describe("classifyDiscountError", () => {
  it("maps every refusal the function raises", () => {
    const cases: [string, string][] = [
      ["POLICY_VIOLATION: percent", "dc_percent"], ["POLICY_VIOLATION: amount", "dc_amount"], ["POLICY_VIOLATION: reason", "dc_reason"], ["POLICY_VIOLATION: discount limit 10", "dc_limit"],
      ["INVALID_STATE: money held", "se_paid"], ["INVALID_STATE: invoice", "se_invoiced"], ["INVALID_STATE: payment in progress", "se_payment_started"],
      ["INVALID_STATE: cancelled", "dc_status"], ["NOT_FOUND", "not_found"], ["IDEMPOTENCY_MISMATCH", "se_duplicate"], ["boom", "unknown"],
    ];
    for (const [m, c] of cases) expect(classifyDiscountError(m), m).toBe(c);
  });
});

describe("resultCode", () => {
  it("tells set, removed and unchanged apart", () => {
    expect(resultCode({ changed: true, discount_minor: 12000 })).toBe("discount_set");
    expect(resultCode({ changed: true, discount_minor: 0 })).toBe("discount_removed");
    expect(resultCode({ changed: false, discount_minor: 12000 })).toBe("discount_unchanged");
    expect(resultCode({ changed: true, discount_minor: 12000, refund_due_minor: 500 })).toBe("discount_set_refund_due");
    expect(resultCode({ changed: true, discount_minor: 12000, refund_due_minor: 0 })).toBe("discount_set");
  });
});

describe("amount discounts", () => {
  it("reads naira into kobo, with 0 meaning remove", () => {
    expect(parseAmount("5,000")).toBe(500000);
    expect(parseAmount("₦2500.50")).toBe(250050);
    expect(parseAmount("0")).toBe(0);
    expect(parseAmount("0.00")).toBe(0);
    for (const bad of ["", "abc", "-5", "10.999", "1e3", undefined, null]) expect(parseAmount(bad), String(bad)).toBeNull();
  });
  it("is chosen by the kind field and checked on its own value", () => {
    expect(parseDiscountForm({ kind: "amount", amount: "5,000", percent: "x", reason: " promo " })).toEqual({ ok: true, value: { kind: "amount", amountMinor: 500000, reason: "promo" } });
    expect(parseDiscountForm({ kind: "amount", amount: "", percent: "10", reason: "r" })).toEqual({ ok: false, code: "dc_amount" });
    expect(parseDiscountForm({ kind: "percent", amount: "x", percent: "10", reason: "r" }).ok).toBe(true);
    expect(parseDiscountForm({ amount: "x", percent: "10", reason: "r" }).ok).toBe(true);
  });
});
