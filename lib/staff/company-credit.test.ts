import { describe, expect, it } from "vitest";
import { classifyGroupError } from "./groups";
import {
  parseCreditApplyForm,
  parseCreditBalances,
  parseCreditDepositForm,
  parseCreditLedger,
  parseCreditWithdrawForm,
} from "./company-credit";

const C = "11111111-1111-4111-8111-111111111111";
const KEY = "key-12345678";

describe("credit forms", () => {
  it("reads a deposit", () => {
    expect(
      parseCreditDepositForm({ companyId: C, amount: "250,000", method: "bank_transfer", reference: " TRF-1 ", note: "", key: KEY }),
    ).toEqual({
      ok: true,
      value: { companyId: C, amountMinor: 25000000, method: "bank_transfer", reference: "TRF-1", note: null, key: KEY },
    });
  });
  it("refuses a bad deposit", () => {
    const base = { companyId: C, amount: "1000", method: "cash", key: KEY };
    expect(parseCreditDepositForm({ ...base, amount: "0" }).ok).toBe(false);
    expect(parseCreditDepositForm({ ...base, amount: "abc" }).ok).toBe(false);
    expect(parseCreditDepositForm({ ...base, method: "cheque" }).ok).toBe(false);
    expect(parseCreditDepositForm({ ...base, reference: "x".repeat(61) }).ok).toBe(false);
    expect(parseCreditDepositForm({ ...base, companyId: "nope" }).ok).toBe(false);
    expect(parseCreditDepositForm({ ...base, key: "short" }).ok).toBe(false);
  });
  it("needs a reason to take credit out", () => {
    expect(parseCreditWithdrawForm({ companyId: C, amount: "500", reason: " refund ", key: KEY })).toEqual({
      ok: true,
      value: { companyId: C, amountMinor: 50000, reason: "refund", key: KEY },
    });
    expect(parseCreditWithdrawForm({ companyId: C, amount: "500", reason: " ", key: KEY })).toEqual({ ok: false, code: "group_reason" });
    expect(parseCreditWithdrawForm({ companyId: C, amount: "-5", reason: "x", key: KEY }).ok).toBe(false);
  });
  it("reads the apply form", () => {
    expect(parseCreditApplyForm({ groupId: C, amount: "1500.50", key: KEY })).toEqual({
      ok: true,
      value: { groupId: C, amountMinor: 150050, key: KEY },
    });
    expect(parseCreditApplyForm({ groupId: C, amount: "", key: KEY }).ok).toBe(false);
  });
});

describe("credit answers", () => {
  it("keeps good balances and drops the rest", () => {
    expect(parseCreditBalances({ [C]: 5000, "bad-id": 1, "22222222-2222-4222-8222-222222222222": "7000" })).toEqual({
      [C]: 5000,
      "22222222-2222-4222-8222-222222222222": 7000,
    });
    expect(parseCreditBalances(null)).toEqual({});
    expect(parseCreditBalances([1, 2])).toEqual({});
  });
  it("reads ledger entries", () => {
    const out = parseCreditLedger([
      { kind: "apply", amount_minor: -5000, group_name: "Retreat", created_at: "2026-11-21T10:00:00Z", method: null },
      { kind: "weird", amount_minor: 1, created_at: "x" },
      { kind: "deposit", amount_minor: "9000", method: "cash", created_at: "2026-11-20T10:00:00Z", reference: "R1" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: "apply", amountMinor: -5000, groupName: "Retreat" });
    expect(out[1]).toMatchObject({ kind: "deposit", amountMinor: 9000, reference: "R1" });
  });
  it("words an empty balance refusal", () => {
    expect(classifyGroupError("POLICY_VIOLATION: credit balance")).toBe("credit_short");
    expect(classifyGroupError("POLICY_VIOLATION: credit limit")).toBe("group_credit_limit");
  });
});
