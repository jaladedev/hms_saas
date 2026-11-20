import { describe, expect, it } from "vitest";
import {
  normaliseVoucherCode,
  parseBookingVoucher,
  parseIssueForm,
  parseRedeemForm,
  parseVoidForm,
  parseVoucherList,
  voucherError,
} from "./vouchers";

const P = "11111111-1111-4111-8111-111111111111";

describe("parseIssueForm", () => {
  it("reads a gift voucher with an expiry and a note", () => {
    const r = parseIssueForm({ propertyId: P, kind: "gift", amount: "50,000", expiresOn: "2027-06-30", note: " For Mr Bello " });
    expect(r).toEqual({
      ok: true,
      value: { propertyId: P, kind: "gift", amountMinor: 5000000, expiresOn: "2027-06-30", note: "For Mr Bello" },
    });
  });
  it("treats an empty expiry and note as none", () => {
    const r = parseIssueForm({ propertyId: P, kind: "discount", amount: "100", expiresOn: "", note: "" });
    expect(r).toMatchObject({ ok: true, value: { kind: "discount", amountMinor: 10000, expiresOn: null, note: null } });
  });
  it("refuses a bad kind, amount, date, note or hotel", () => {
    const base = { propertyId: P, kind: "gift", amount: "500" };
    expect(parseIssueForm({ ...base, kind: "magic" }).ok).toBe(false);
    expect(parseIssueForm({ ...base, amount: "99" }).ok).toBe(false);
    expect(parseIssueForm({ ...base, amount: "1000001" }).ok).toBe(false);
    expect(parseIssueForm({ ...base, amount: "" }).ok).toBe(false);
    expect(parseIssueForm({ ...base, expiresOn: "30/06/2027" }).ok).toBe(false);
    expect(parseIssueForm({ ...base, expiresOn: "2027-13-45" }).ok).toBe(false);
    expect(parseIssueForm({ ...base, note: "x".repeat(201) }).ok).toBe(false);
    expect(parseIssueForm({ ...base, propertyId: "nope" }).ok).toBe(false);
  });
});

describe("codes and redeem forms", () => {
  it("normalises a typed code", () => {
    expect(normaliseVoucherCode("  gv-ab2c-d3ef ")).toBe("GV-AB2C-D3EF");
    expect(normaliseVoucherCode("ab")).toBeNull();
    expect(normaliseVoucherCode("GV AB2C")).toBeNull();
    expect(normaliseVoucherCode(null)).toBeNull();
  });
  it("reads the redeem and void forms", () => {
    expect(parseRedeemForm({ reservationId: P, code: "gv-ab2c-d3ef" })).toEqual({
      ok: true,
      value: { reservationId: P, code: "GV-AB2C-D3EF" },
    });
    expect(parseRedeemForm({ reservationId: P, code: "x" }).ok).toBe(false);
    expect(parseRedeemForm({ reservationId: "bad", code: "GV-AB2C-D3EF" }).ok).toBe(false);
    expect(parseVoidForm({ voucherId: P, reason: " lost " })).toEqual({ ok: true, value: { voucherId: P, reason: "lost" } });
    expect(parseVoidForm({ voucherId: P, reason: " " }).ok).toBe(false);
    expect(parseVoidForm({ voucherId: P, reason: "x".repeat(201) }).ok).toBe(false);
  });
});

describe("parsers for database answers", () => {
  const row = {
    id: P,
    code: "GV-AB2C-D3EF",
    kind: "gift",
    face_value_minor: 5000000,
    balance_minor: "3000000",
    status: "active",
    expires_on: null,
    note: "n",
    created_at: "2026-11-20T10:00:00Z",
  };
  it("keeps good voucher rows and drops bad ones", () => {
    const out = parseVoucherList([row, { ...row, status: "weird" }, { ...row, kind: "x" }, null, { ...row, balance_minor: "abc" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ code: "GV-AB2C-D3EF", balance_minor: 3000000, expires_on: null, note: "n" });
    expect(parseVoucherList("nope")).toEqual([]);
  });
  it("reads the booking card state", () => {
    expect(parseBookingVoucher(null)).toEqual({ enabled: false });
    expect(parseBookingVoucher({ enabled: false })).toEqual({ enabled: false });
    expect(parseBookingVoucher({ enabled: true, applied: false })).toEqual({ enabled: true, applied: false });
    expect(parseBookingVoucher({ enabled: true, applied: true, code: "GV-AB2C-D3EF", kind: "discount", applied_minor: 1000 })).toEqual({
      enabled: true,
      applied: true,
      code: "GV-AB2C-D3EF",
      kind: "discount",
      appliedMinor: 1000,
    });
  });
});

describe("voucherError", () => {
  it("maps the database's refusals", () => {
    expect(voucherError("NOT_FOUND")).toBe("setup_forbidden");
    expect(voucherError("POLICY_VIOLATION: loyalty off")).toBe("voucher_flag");
    expect(voucherError("POLICY_VIOLATION: voucher")).toBe("voucher_unknown");
    expect(voucherError("POLICY_VIOLATION: voucher expired")).toBe("voucher_expired");
    expect(voucherError("POLICY_VIOLATION: voucher used")).toBe("voucher_used");
    expect(voucherError("POLICY_VIOLATION: voucher void")).toBe("voucher_void");
    expect(voucherError("INVALID_STATE: discount")).toBe("voucher_discount");
    expect(voucherError("INVALID_STATE: money held")).toBe("voucher_state");
    expect(voucherError("INVALID_STATE: void")).toBe("voucher_state");
    expect(voucherError("POLICY_VIOLATION: expiry")).toBe("voucher_invalid");
    expect(voucherError("POLICY_VIOLATION: amount")).toBe("voucher_invalid");
    expect(voucherError("boom")).toBeNull();
  });
});
