import { describe, expect, it, vi } from "vitest";
import { checkDetails, submitRefundDetails, type DetailsDeps, type DetailsStart } from "@/lib/refunds/details";
import type { RetryRefundResult } from "@/lib/paystack";

const START: DetailsStart = { refund_id: "r1", provider_refund_id: "3018", currency: "NGN", call_allowed: true };
const INPUT = { bankId: "9", accountNumber: "0123456789" };

function deps(over: Partial<DetailsDeps> = {}) {
  return {
    start: vi.fn(async () => START),
    getSecret: vi.fn(async () => "sk_test_abcdef123456"),
    retry: vi.fn(async (): Promise<RetryRefundResult> => ({ kind: "accepted" })),
    finish: vi.fn(async () => {}),
    log: vi.fn(),
    ...over,
  };
}

describe("checkDetails", () => {
  it("accepts a 10-digit Nigerian account and a numeric bank id, ignoring spaces and dashes", () => {
    expect(checkDetails("NGN", { bankId: " 9 ", accountNumber: "0123 456-789" })).toEqual({
      ok: true,
      value: { bankId: "9", accountNumber: "0123456789" },
    });
  });
  it("refuses a missing or non-numeric bank", () => {
    for (const bankId of [undefined, "", "abc", "9; drop", 9])
      expect(checkDetails("NGN", { bankId, accountNumber: "0123456789" })).toEqual({ ok: false, error: "bank_required" });
  });
  it("refuses NGN account numbers that are not exactly 10 digits, and anything non-numeric", () => {
    for (const accountNumber of ["012345678", "01234567890", "01234abcde", "", undefined, 123456789]) {
      expect(checkDetails("NGN", { bankId: "9", accountNumber })).toEqual({ ok: false, error: "account_invalid" });
    }
  });
  it("allows 5 to 20 digits for other currencies", () => {
    expect(checkDetails("GHS", { bankId: "9", accountNumber: "12345" }).ok).toBe(true);
    expect(checkDetails("GHS", { bankId: "9", accountNumber: "1".repeat(20) }).ok).toBe(true);
    expect(checkDetails("GHS", { bankId: "9", accountNumber: "1234" }).ok).toBe(false);
    expect(checkDetails("GHS", { bankId: "9", accountNumber: "1".repeat(21) }).ok).toBe(false);
  });
});

describe("submitRefundDetails", () => {
  it("sends the details once to Paystack with the provider refund id, then records the acceptance", async () => {
    const d = deps();
    expect(await submitRefundDetails(d, "r1", INPUT)).toEqual({ status: "submitted" });
    expect(d.retry).toHaveBeenCalledTimes(1);
    expect(d.retry).toHaveBeenCalledWith(
      { providerRefundId: "3018", currency: "NGN", accountNumber: "0123456789", bankId: "9" },
      "sk_test_abcdef123456",
    );
    expect(d.finish).toHaveBeenCalledWith("r1", "accepted", null);
  });

  it("never calls Paystack when someone else already started the attempt", async () => {
    const d = deps({ start: vi.fn(async () => ({ ...START, call_allowed: false })) });
    expect(await submitRefundDetails(d, "r1", INPUT)).toEqual({ status: "already_started" });
    expect(d.getSecret).not.toHaveBeenCalled();
    expect(d.retry).not.toHaveBeenCalled();
    expect(d.finish).not.toHaveBeenCalled();
  });

  it("gives the attempt back, without calling Paystack, when no secret is available", async () => {
    const d = deps({
      getSecret: vi.fn(async () => {
        throw new Error("secret not available");
      }),
    });
    expect(await submitRefundDetails(d, "r1", INPUT)).toMatchObject({ status: "rejected" });
    expect(d.retry).not.toHaveBeenCalled();
    expect(d.finish).toHaveBeenCalledWith("r1", "rejected", expect.stringContaining("not configured"));
  });

  it("gives the attempt back when Paystack refuses the details", async () => {
    const d = deps({
      retry: vi.fn(async (): Promise<RetryRefundResult> => ({ kind: "rejected", httpStatus: 422, message: "Invalid account" })),
    });
    expect(await submitRefundDetails(d, "r1", INPUT)).toEqual({ status: "rejected", reason: "Invalid account" });
    expect(d.finish).toHaveBeenCalledWith("r1", "rejected", "Paystack refused the bank details: Invalid account");
  });

  it("keeps the attempt used, and says so, when the outcome is unknown", async () => {
    const d = deps({
      retry: vi.fn(async () => {
        throw new Error("Paystack refund retry failed with HTTP 503");
      }),
    });
    const out = await submitRefundDetails(d, "r1", INPUT);
    expect(out).toMatchObject({ status: "unknown" });
    expect(d.retry).toHaveBeenCalledTimes(1);
    expect(d.finish).toHaveBeenCalledWith("r1", "unknown", expect.stringContaining("Check Paystack"));
  });

  it("never lets the account number reach a note, a log or the result", async () => {
    const finish = vi.fn(async () => {});
    const log = vi.fn();
    const d = deps({
      retry: vi.fn(async () => {
        throw new Error("bad gateway for 0123456789");
      }),
      finish,
      log,
    });
    const out = await submitRefundDetails(d, "r1", INPUT);
    const everything = JSON.stringify([out, finish.mock.calls, log.mock.calls]);
    expect(everything).not.toContain("0123456789");
  });
});
