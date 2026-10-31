import { describe, expect, it } from "vitest";
import { parseAmountToMinor, minorToInput } from "./money-input";
import { availableAction, classifyRpcError, errorMessage, groupQueue, needsAttention, refundableMinor, type RefundRow } from "./refunds";
import { formatAge, formatDateTime } from "./format";

const NOW = new Date("2026-10-31T12:00:00Z");
const ME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function refund(over: Partial<RefundRow> = {}): RefundRow {
  return {
    id: "r1", reservation_id: "res1", payment_id: "p1", internal_reference: "RF-AAAAAAAAAA", amount_minor: 500000, currency: "NGN",
    refund_status: "requested", reason: "test", requested_by: OTHER, decided_by: null, decided_at: null, decision_note: null,
    payout_reference: null, failure_reason: null, attention_note: null, provider_call_started_at: null,
    created_at: "2026-10-31T09:00:00Z", completed_at: null, ...over,
  };
}

describe("parseAmountToMinor", () => {
  it("reads plain, grouped and decimal amounts", () => {
    expect(parseAmountToMinor("12500")).toBe(1250000);
    expect(parseAmountToMinor("12,500.50")).toBe(1250050);
    expect(parseAmountToMinor("₦ 1,000")).toBe(100000);
    expect(parseAmountToMinor("0.5")).toBe(50);
    expect(parseAmountToMinor("10.05")).toBe(1005);
  });
  it("refuses anything ambiguous", () => {
    for (const bad of ["", "0", "0.00", "-5", "12.345", "1e5", "abc", "12.", ".5", "1 2 3a", "9999999999999"]) {
      expect(parseAmountToMinor(bad), bad).toBeNull();
    }
  });
  it("round-trips for the input prefill", () => {
    expect(minorToInput(1250050)).toBe("12500.50");
    expect(parseAmountToMinor(minorToInput(1250050))).toBe(1250050);
  });
});

describe("needsAttention and groupQueue", () => {
  it("flags a processing refund with a note or one that has been stuck for two hours", () => {
    expect(needsAttention(refund({ refund_status: "processing", attention_note: "unknown" }), NOW)).toBe(true);
    expect(needsAttention(refund({ refund_status: "processing", provider_call_started_at: "2026-10-31T09:59:00Z" }), NOW)).toBe(true);
    expect(needsAttention(refund({ refund_status: "processing", provider_call_started_at: "2026-10-31T11:00:00Z" }), NOW)).toBe(false);
    expect(needsAttention(refund({ refund_status: "approved", attention_note: "x" }), NOW)).toBe(false);
  });
  it("puts every refund in exactly one group, open ones oldest first", () => {
    const rows = [
      refund({ id: "a", created_at: "2026-10-31T10:00:00Z" }),
      refund({ id: "b", created_at: "2026-10-31T08:00:00Z" }),
      refund({ id: "c", refund_status: "approved" }),
      refund({ id: "d", refund_status: "processing", provider_call_started_at: "2026-10-31T11:30:00Z" }),
      refund({ id: "e", refund_status: "processing", attention_note: "check" }),
      refund({ id: "f", refund_status: "failed", completed_at: "2026-10-30T10:00:00Z" }),
      refund({ id: "g", refund_status: "succeeded", completed_at: "2026-10-31T10:00:00Z" }),
      refund({ id: "h", refund_status: "rejected", completed_at: "2026-10-29T10:00:00Z" }),
    ];
    const g = groupQueue(rows, NOW);
    expect(g.awaitingApproval.map((r) => r.id)).toEqual(["b", "a"]);
    expect(g.readyToPay.map((r) => r.id)).toEqual(["c"]);
    expect(g.processing.map((r) => r.id)).toEqual(["d"]);
    expect(g.attention.map((r) => r.id)).toEqual(["e"]);
    expect(g.closed.map((r) => r.id)).toEqual(["g", "f", "h"]);
    const total = Object.values(g).reduce((n, list) => n + list.length, 0);
    expect(total).toBe(rows.length);
  });
});

describe("availableAction", () => {
  it("lets someone else decide a request but not the person who made it", () => {
    expect(availableAction(refund(), "paystack", ME).kind).toBe("decide");
    expect(availableAction(refund({ requested_by: ME }), "paystack", ME).kind).toBe("own_request");
    expect(availableAction(refund({ requested_by: null }), "paystack", ME).kind).toBe("decide");
  });
  it("routes approved refunds by how the money came in", () => {
    expect(availableAction(refund({ refund_status: "approved" }), "manual", ME).kind).toBe("manual_payout");
    expect(availableAction(refund({ refund_status: "approved" }), "paystack", ME).kind).toBe("provider_payout");
  });
  it("offers nothing once a refund is in flight or closed", () => {
    expect(availableAction(refund({ refund_status: "processing" }), "paystack", ME).kind).toBe("wait");
    for (const s of ["succeeded", "rejected", "failed"] as const) expect(availableAction(refund({ refund_status: s }), "paystack", ME).kind).toBe("none");
  });
});

describe("refundableMinor", () => {
  it("subtracts requested, approved, processing and succeeded refunds but not rejected or failed", () => {
    const rs = [
      { amount_minor: 100, refund_status: "requested" as const }, { amount_minor: 200, refund_status: "approved" as const },
      { amount_minor: 300, refund_status: "processing" as const }, { amount_minor: 400, refund_status: "succeeded" as const },
      { amount_minor: 500, refund_status: "rejected" as const }, { amount_minor: 600, refund_status: "failed" as const },
    ];
    expect(refundableMinor(2000, rs)).toBe(1000);
    expect(refundableMinor(500, rs)).toBe(0);
  });
});

describe("classifyRpcError", () => {
  it("recognises the database's refusals", () => {
    expect(classifyRpcError("POLICY_VIOLATION: SELF_APPROVAL").code).toBe("self_approval");
    expect(classifyRpcError("POLICY_VIOLATION: REFUND_EXCEEDS_PAYMENT refundable 150000")).toEqual({ code: "exceeds", refundableMinor: 150000 });
    expect(classifyRpcError("POLICY_VIOLATION: note required to reject").code).toBe("note_required");
    expect(classifyRpcError("POLICY_VIOLATION: reason required").code).toBe("reason_required");
    expect(classifyRpcError("POLICY_VIOLATION: provider payments are refunded through the provider").code).toBe("provider_payment");
    expect(classifyRpcError("INVALID_STATE: approved").code).toBe("invalid_state");
    expect(classifyRpcError("NOT_FOUND").code).toBe("not_found");
    expect(classifyRpcError("connection reset").code).toBe("unknown");
  });
  it("words every code and never echoes raw database text", () => {
    const fmt = (m: number) => `₦${m / 100}`;
    expect(errorMessage("exceeds", 150000, fmt)).toContain("₦1500");
    expect(errorMessage("not-a-code", null, fmt)).toMatch(/Nothing was changed/);
  });
});

describe("formatters", () => {
  it("formats time in the property's timezone and survives bad input", () => {
    expect(formatDateTime("2026-10-31T23:30:00Z", "Africa/Lagos")).toContain("00:30");
    expect(formatDateTime(null, "Africa/Lagos")).toBe("—");
    expect(formatDateTime("2026-10-31T10:00:00Z", "Not/AZone")).toContain("UTC");
  });
  it("words an age", () => {
    expect(formatAge(25)).toBe("25 min");
    expect(formatAge(180)).toBe("3 h");
    expect(formatAge(60 * 72)).toBe("3 days");
    expect(formatAge(null)).toBe("");
  });
});
