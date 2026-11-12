import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handlePlatformInvoiceWebhook, platformPaystackSecret, settleInvoiceReference, type InvoicePaymentDeps } from "./invoice-payment";

const REF = "PIP-0123456789abcdef0123456789abcdef";
const SECRET = "sk_test_platform";

function deps(over: Partial<InvoicePaymentDeps> = {}): InvoicePaymentDeps {
  return {
    secret: SECRET,
    verifyTransaction: vi.fn(async () => ({
      ok: true as const,
      transaction: { id: 1, status: "success", reference: REF, amountMinor: 250000, currency: "NGN", channel: "card" },
    })),
    settle: vi.fn(async () => ({ result: "paid" })),
    log: vi.fn(),
    ...over,
  };
}
const sign = (body: string) => createHmac("sha512", SECRET).update(body).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

describe("platformPaystackSecret", () => {
  it("is null when unset or blank", () => {
    expect(platformPaystackSecret({})).toBeNull();
    expect(platformPaystackSecret({ PLATFORM_PAYSTACK_SECRET_KEY: "  " })).toBeNull();
    expect(platformPaystackSecret({ PLATFORM_PAYSTACK_SECRET_KEY: " sk_x " })).toBe("sk_x");
  });
});

describe("settleInvoiceReference", () => {
  it("settles with what Paystack reported", async () => {
    const d = deps();
    expect(await settleInvoiceReference(d, REF)).toBe("paid");
    expect(d.settle).toHaveBeenCalledWith({ reference: REF, status: "success", amountMinor: 250000, currency: "NGN" });
  });
  it("never calls Paystack for a reference that is not ours", async () => {
    const d = deps();
    expect(await settleInvoiceReference(d, "PAY-123")).toBe("unknown");
    expect(d.verifyTransaction).not.toHaveBeenCalled();
    expect(d.settle).not.toHaveBeenCalled();
  });
  it("is unknown when Paystack does not know the reference, and settles nothing", async () => {
    const d = deps({ verifyTransaction: vi.fn(async () => ({ ok: false as const, reason: "not_found" as const })) });
    expect(await settleInvoiceReference(d, REF)).toBe("unknown");
    expect(d.settle).not.toHaveBeenCalled();
  });
  it("logs an error when the money does not fit the invoice", async () => {
    const closed = deps({ settle: vi.fn(async () => ({ result: "invoice_closed" })) });
    await settleInvoiceReference(closed, REF);
    expect(closed.log).toHaveBeenCalledWith("error", expect.stringContaining("already paid or void"), { reference: REF });
    const mismatch = deps({ settle: vi.fn(async () => ({ result: "mismatch" })) });
    await settleInvoiceReference(mismatch, REF);
    expect(mismatch.log).toHaveBeenCalledWith("error", expect.stringContaining("differs"), { reference: REF });
  });
  it("treats an unexpected database answer as unknown", async () => {
    expect(await settleInvoiceReference(deps({ settle: vi.fn(async () => ({ result: "???" })) }), REF)).toBe("unknown");
  });
  it("lets a Paystack failure through so the webhook can be retried", async () => {
    const d = deps({
      verifyTransaction: vi.fn(async () => {
        throw new Error("HTTP 503");
      }),
    });
    await expect(settleInvoiceReference(d, REF)).rejects.toThrow("HTTP 503");
  });
});

describe("handlePlatformInvoiceWebhook", () => {
  const body = JSON.stringify({ event: "charge.success", data: { reference: REF } });
  it("refuses a bad or missing signature without touching Paystack", async () => {
    const d = deps();
    expect((await handlePlatformInvoiceWebhook(d, { rawBody: bytes(body), signature: "nope" })).status).toBe(401);
    expect((await handlePlatformInvoiceWebhook(d, { rawBody: bytes(body), signature: null })).status).toBe(401);
    expect(d.verifyTransaction).not.toHaveBeenCalled();
  });
  it("settles a signed charge.success", async () => {
    const d = deps();
    const out = await handlePlatformInvoiceWebhook(d, { rawBody: bytes(body), signature: sign(body) });
    expect(out).toEqual({ status: 200, body: { ok: true } });
    expect(d.settle).toHaveBeenCalledTimes(1);
  });
  it("ignores other events and other references with 200", async () => {
    const d = deps();
    const other = JSON.stringify({ event: "refund.processed", data: { reference: REF } });
    expect((await handlePlatformInvoiceWebhook(d, { rawBody: bytes(other), signature: sign(other) })).body).toEqual({ ignored: "event" });
    const hotel = JSON.stringify({ event: "charge.success", data: { reference: "pay-1" } });
    expect((await handlePlatformInvoiceWebhook(d, { rawBody: bytes(hotel), signature: sign(hotel) })).body).toEqual({
      ignored: "reference",
    });
    expect(d.settle).not.toHaveBeenCalled();
  });
  it("answers 400 for a body that is not an event", async () => {
    const d = deps();
    expect((await handlePlatformInvoiceWebhook(d, { rawBody: bytes("{"), signature: sign("{") })).status).toBe(400);
    const bad = JSON.stringify({ nope: 1 });
    expect((await handlePlatformInvoiceWebhook(d, { rawBody: bytes(bad), signature: sign(bad) })).status).toBe(400);
  });
  it("answers 500 when it cannot settle, so Paystack retries", async () => {
    const d = deps({
      settle: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const out = await handlePlatformInvoiceWebhook(d, { rawBody: bytes(body), signature: sign(body) });
    expect(out.status).toBe(500);
  });
});
