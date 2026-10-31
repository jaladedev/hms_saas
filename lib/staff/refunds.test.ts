import { describe, expect, it } from "vitest";
import { availableAction, groupQueue, type RefundRow } from "@/lib/staff/refunds";

const NOW = new Date("2026-10-31T12:00:00Z");
function refund(over: Partial<RefundRow> = {}): RefundRow {
  return {
    id: "r1", reservation_id: "res1", payment_id: "p1", internal_reference: "RF-1", amount_minor: 250000, currency: "NGN",
    refund_status: "processing", reason: "cancelled", requested_by: "u1", decided_by: "u2", decided_at: "2026-10-31T10:00:00Z", decision_note: null,
    payout_reference: null, failure_reason: null, attention_note: null, provider_call_started_at: "2026-10-31T11:00:00Z",
    created_at: "2026-10-31T09:00:00Z", completed_at: null, ...over,
  };
}

describe("availableAction for refunds waiting on bank details", () => {
  it("shows the bank details form while Paystack is waiting and no attempt has been made", () => {
    expect(availableAction(refund({ needs_bank_details: true, details_retry_started_at: null }), "paystack", "u3")).toEqual({ kind: "bank_details" });
    expect(availableAction(refund({ needs_bank_details: true }), "paystack", "u3")).toEqual({ kind: "bank_details" });
  });
  it("only waits once details were sent, so a second submission is not offered", () => {
    expect(availableAction(refund({ needs_bank_details: true, details_retry_started_at: "2026-10-31T11:30:00Z" }), "paystack", "u3")).toEqual({ kind: "wait" });
  });
  it("waits when Paystack does not need anything, and never offers the form for a closed refund", () => {
    expect(availableAction(refund(), "paystack", "u3")).toEqual({ kind: "wait" });
    expect(availableAction(refund({ refund_status: "succeeded", needs_bank_details: true }), "paystack", "u3")).toEqual({ kind: "none" });
  });
});

describe("groupQueue with bank details", () => {
  it("keeps a refund that needs details in the needs-a-person group while it carries a note", () => {
    const r = refund({ needs_bank_details: true, attention_note: "Paystack needs the customer's bank details" });
    expect(groupQueue([r], NOW).attention).toEqual([r]);
  });
  it("returns it to the normal processing group once Paystack accepted the details and the note is cleared", () => {
    const r = refund({ needs_bank_details: false, attention_note: null, details_retry_started_at: "2026-10-31T11:30:00Z" });
    const g = groupQueue([r], NOW);
    expect(g.attention).toEqual([]);
    expect(g.processing).toEqual([r]);
  });
});
