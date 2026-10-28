import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { handlePaystackWebhook, type WebhookDeps } from "@/lib/webhooks/paystack";
import type { VerifyResult } from "@/lib/paystack";

const SECRET = "sk_test_abcdef123456";
const TENANT = "00000000-0000-0000-0000-0000000000a1";
const ACCOUNT = "00000000-0000-0000-0000-0000000000f1";

function request(event: unknown, secret = SECRET) {
  const raw = new TextEncoder().encode(JSON.stringify(event));
  return { accountId: ACCOUNT, rawBody: raw, signature: createHmac("sha512", secret).update(raw).digest("hex") };
}
function deps(overrides: Partial<WebhookDeps> = {}) {
  const d = {
    loadAccount: vi.fn(async () => ({ tenantId: TENANT, secretReference: "env:X" })),
    resolveSecret: vi.fn(() => SECRET),
    verifyTransaction: vi.fn(async (): Promise<VerifyResult> => ({ ok: true, transaction: { id: 77, status: "success", reference: "HMS-1", amountMinor: 250000, currency: "NGN", channel: "card" } })),
    confirmPayment: vi.fn(async () => ({ result: "confirmed" })),
    findProcessingRefund: vi.fn(async () => "refund-1" as string | null),
    recordRefundResult: vi.fn(async () => ({ result: "succeeded" })),
    log: vi.fn(),
    ...overrides,
  };
  return d;
}
const charge = (data: Record<string, unknown> = {}) => ({ event: "charge.success", data: { reference: "HMS-1", amount: 1, currency: "USD", ...data } });

describe("paystack webhook handler", () => {
  it("rejects a bad signature before doing any work", async () => {
    const d = deps();
    const out = await handlePaystackWebhook(d, { ...request(charge()), signature: "0".repeat(128) });
    expect(out.status).toBe(401);
    expect(d.verifyTransaction).not.toHaveBeenCalled();
    expect(d.confirmPayment).not.toHaveBeenCalled();
  });

  it("rejects an event signed with another account's secret", async () => {
    const d = deps();
    const out = await handlePaystackWebhook(d, request(charge(), "sk_test_someone_else"));
    expect(out.status).toBe(401);
    expect(d.confirmPayment).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown or inactive account and 500 when the secret cannot be resolved", async () => {
    expect((await handlePaystackWebhook(deps({ loadAccount: vi.fn(async () => null) }), request(charge()))).status).toBe(404);
    const d = deps({ resolveSecret: vi.fn(() => { throw new Error("nope"); }) });
    expect((await handlePaystackWebhook(d, request(charge()))).status).toBe(500);
    expect(d.confirmPayment).not.toHaveBeenCalled();
  });

  it("records money from the VERIFIED transaction, not from the webhook body", async () => {
    const d = deps();
    const out = await handlePaystackWebhook(d, request(charge({ amount: 1, currency: "USD", channel: "ussd" })));
    expect(out).toEqual({ status: 200, body: { received: true, result: "confirmed" } });
    expect(d.verifyTransaction).toHaveBeenCalledWith("HMS-1", SECRET);
    expect(d.confirmPayment).toHaveBeenCalledTimes(1);
    const args = (d.confirmPayment as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(args).toMatchObject({ providerEventId: "charge.success:77", reference: "HMS-1", status: "success", amountMinor: 250000, currency: "NGN", channel: "card", tenantId: TENANT });
    expect(JSON.stringify(args.payload)).not.toContain("USD");
  });

  it("ignores a reference Paystack does not know, and a verification that contradicts the event", async () => {
    const unknown = deps({ verifyTransaction: vi.fn(async (): Promise<VerifyResult> => ({ ok: false, reason: "not_found" })) });
    expect((await handlePaystackWebhook(unknown, request(charge()))).body).toMatchObject({ result: "ignored_unverified" });
    expect(unknown.confirmPayment).not.toHaveBeenCalled();

    for (const status of ["failed", "abandoned", "reversed"]) {
      const d = deps({ verifyTransaction: vi.fn(async (): Promise<VerifyResult> => ({ ok: true, transaction: { id: 1, status, reference: "HMS-1", amountMinor: 1, currency: "NGN", channel: null } })) });
      const out = await handlePaystackWebhook(d, request(charge()));
      expect(out.status).toBe(200);
      expect(d.confirmPayment).not.toHaveBeenCalled();
    }
    const mismatch = deps({ verifyTransaction: vi.fn(async (): Promise<VerifyResult> => ({ ok: true, transaction: { id: 1, status: "success", reference: "HMS-OTHER", amountMinor: 1, currency: "NGN", channel: null } })) });
    await handlePaystackWebhook(mismatch, request(charge()));
    expect(mismatch.confirmPayment).not.toHaveBeenCalled();
  });

  it("asks Paystack to retry while the transaction is not final", async () => {
    const d = deps({ verifyTransaction: vi.fn(async (): Promise<VerifyResult> => ({ ok: true, transaction: { id: 1, status: "pending", reference: "HMS-1", amountMinor: 1, currency: "NGN", channel: null } })) });
    expect((await handlePaystackWebhook(d, request(charge()))).status).toBe(503);
    expect(d.confirmPayment).not.toHaveBeenCalled();
  });

  it("answers 5xx when verification or the database fails, so Paystack retries", async () => {
    const verifyDown = deps({ verifyTransaction: vi.fn(async () => { throw new Error("HTTP 500"); }) });
    expect((await handlePaystackWebhook(verifyDown, request(charge()))).status).toBe(500);
    const dbDown = deps({ confirmPayment: vi.fn(async () => { throw new Error("connection reset"); }) });
    const out = await handlePaystackWebhook(dbDown, request(charge()));
    expect(out).toEqual({ status: 500, body: { error: "processing failed" } });
  });

  it("400s on malformed but correctly signed bodies", async () => {
    const raw = new TextEncoder().encode("not json");
    const sig = createHmac("sha512", SECRET).update(raw).digest("hex");
    expect((await handlePaystackWebhook(deps(), { accountId: ACCOUNT, rawBody: raw, signature: sig })).status).toBe(400);
    expect((await handlePaystackWebhook(deps(), request({ event: "charge.success", data: {} }))).status).toBe(400);
    expect((await handlePaystackWebhook(deps(), request({ nope: true }))).status).toBe(400);
  });

  it("maps refund.processed and refund.failed onto the matching processing refund", async () => {
    const d = deps();
    const ok = await handlePaystackWebhook(d, request({ event: "refund.processed", data: { id: 555, amount: 250000, transaction_reference: "HMS-1" } }));
    expect(ok.status).toBe(200);
    expect(d.findProcessingRefund).toHaveBeenCalledWith(TENANT, "HMS-1", 250000);
    expect(d.recordRefundResult).toHaveBeenCalledWith(TENANT, expect.objectContaining({ providerEventId: "refund.processed:555", refundId: "refund-1", status: "succeeded", providerRefundId: "555" }));

    const failed = deps();
    await handlePaystackWebhook(failed, request({ event: "refund.failed", data: { id: 556, amount: 100, transaction: { reference: "HMS-2" } } }));
    expect(failed.findProcessingRefund).toHaveBeenCalledWith(TENANT, "HMS-2", 100);
    expect(failed.recordRefundResult).toHaveBeenCalledWith(TENANT, expect.objectContaining({ status: "failed", failureReason: expect.any(String) }));
  });

  it("acknowledges refund events that match nothing, and events it does not act on", async () => {
    const none = deps({ findProcessingRefund: vi.fn(async () => null) });
    const out = await handlePaystackWebhook(none, request({ event: "refund.processed", data: { id: 1, amount: 5, transaction_reference: "HMS-9" } }));
    expect(out).toEqual({ status: 200, body: { received: true, result: "ignored_no_match" } });
    expect(none.recordRefundResult).not.toHaveBeenCalled();

    for (const event of ["refund.pending", "refund.processing", "transfer.success", "customeridentification.success"]) {
      const d = deps();
      const res = await handlePaystackWebhook(d, request({ event, data: {} }));
      expect(res.status).toBe(200);
      expect(d.confirmPayment).not.toHaveBeenCalled();
      expect(d.recordRefundResult).not.toHaveBeenCalled();
    }
    expect((await handlePaystackWebhook(deps(), request({ event: "refund.processed", data: { id: 1 } }))).status).toBe(400);
  });
});
