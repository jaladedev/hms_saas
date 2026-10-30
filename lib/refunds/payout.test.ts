import { describe, expect, it, vi } from "vitest";
import { payoutRefund, type PayoutDeps, type PayoutStart } from "@/lib/refunds/payout";
import type { CreateRefundResult } from "@/lib/paystack";

const START: PayoutStart = { refund_id: "r1", internal_reference: "RF-1", provider: "paystack", payment_provider_reference: "HMS-ABC", amount_minor: 250000, currency: "NGN", call_allowed: true };

function deps(over: Partial<PayoutDeps> = {}) {
  const d = {
    start: vi.fn(async () => START),
    getSecret: vi.fn(async () => "sk_test_abcdef123456"),
    createRefund: vi.fn(async (): Promise<CreateRefundResult> => ({ kind: "accepted", providerStatus: "pending", providerRefundId: "3018" })),
    recordResult: vi.fn(async () => {}),
    noteAttention: vi.fn(async () => {}),
    log: vi.fn(),
    ...over,
  };
  return d;
}

describe("payoutRefund", () => {
  it("calls the provider once with the stored amount, reference and a note, then waits for the webhook", async () => {
    const d = deps();
    const out = await payoutRefund(d, "r1");
    expect(out).toEqual({ status: "submitted", providerStatus: "pending" });
    expect(d.createRefund).toHaveBeenCalledTimes(1);
    expect(d.createRefund).toHaveBeenCalledWith({ transactionReference: "HMS-ABC", amountMinor: 250000, currency: "NGN", merchantNote: "Refund RF-1" }, "sk_test_abcdef123456");
    expect(d.recordResult).not.toHaveBeenCalled();
  });

  it("never calls the provider when someone else already did", async () => {
    const d = deps({ start: vi.fn(async () => ({ ...START, call_allowed: false })) });
    expect(await payoutRefund(d, "r1")).toEqual({ status: "already_started" });
    expect(d.getSecret).not.toHaveBeenCalled();
    expect(d.createRefund).not.toHaveBeenCalled();
  });

  it("records an immediate processed or failed answer", async () => {
    const ok = deps({ createRefund: vi.fn(async (): Promise<CreateRefundResult> => ({ kind: "accepted", providerStatus: "processed", providerRefundId: "9" })) });
    expect(await payoutRefund(ok, "r1")).toEqual({ status: "succeeded" });
    expect(ok.recordResult).toHaveBeenCalledWith({ refundId: "r1", eventId: "payout:r1", status: "succeeded", providerRefundId: "9", failureReason: null });
    const bad = deps({ createRefund: vi.fn(async (): Promise<CreateRefundResult> => ({ kind: "accepted", providerStatus: "failed", providerRefundId: null })) });
    expect(await payoutRefund(bad, "r1")).toMatchObject({ status: "failed" });
    expect(bad.recordResult).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("marks the refund failed on a definite refusal, which frees the amount", async () => {
    const d = deps({ createRefund: vi.fn(async (): Promise<CreateRefundResult> => ({ kind: "rejected", httpStatus: 400, message: "Insufficient balance" })) });
    expect(await payoutRefund(d, "r1")).toEqual({ status: "failed", reason: "Insufficient balance" });
    expect(d.recordResult).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", failureReason: "Paystack refused: Insufficient balance" }));
    expect(d.noteAttention).not.toHaveBeenCalled();
  });

  it("on an UNKNOWN outcome leaves the refund processing with a note and never retries", async () => {
    const d = deps({ createRefund: vi.fn(async () => { throw new Error("socket hang up"); }) });
    const out = await payoutRefund(d, "r1");
    expect(out.status).toBe("unknown");
    expect(d.createRefund).toHaveBeenCalledTimes(1);
    expect(d.recordResult).not.toHaveBeenCalled();                 // not marked failed: money may have moved
    expect(d.noteAttention).toHaveBeenCalledWith("r1", expect.stringContaining("Check Paystack before retrying"));
  });

  it("flags needs-attention answers for a person", async () => {
    const d = deps({ createRefund: vi.fn(async (): Promise<CreateRefundResult> => ({ kind: "accepted", providerStatus: "needs-attention", providerRefundId: "5" })) });
    expect(await payoutRefund(d, "r1")).toEqual({ status: "submitted", providerStatus: "needs-attention" });
    expect(d.noteAttention).toHaveBeenCalledWith("r1", expect.stringContaining("bank details"));
  });

  it("fails the refund, without calling the provider, when no secret is available", async () => {
    const d = deps({ getSecret: vi.fn(async () => { throw new Error("secret not available"); }) });
    expect(await payoutRefund(d, "r1")).toMatchObject({ status: "failed" });
    expect(d.createRefund).not.toHaveBeenCalled();
    expect(d.recordResult).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("lets staff-permission and state errors from start() propagate untouched", async () => {
    const d = deps({ start: vi.fn(async () => { throw new Error("NOT_FOUND"); }) });
    await expect(payoutRefund(d, "r1")).rejects.toThrow("NOT_FOUND");
    expect(d.createRefund).not.toHaveBeenCalled();
  });
});
