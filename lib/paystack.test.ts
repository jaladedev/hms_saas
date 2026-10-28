import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyTransaction, verifyWebhookSignature } from "@/lib/paystack";

const SECRET = "sk_test_abcdef123456";
const BODY = '{"event":"charge.success","data":{"reference":"HMS-1"}}';
const sig = (body: string, secret = SECRET) => createHmac("sha512", secret).update(body).digest("hex");

describe("verifyWebhookSignature", () => {
  it("accepts the HMAC-SHA512 of the raw body", () => {
    expect(verifyWebhookSignature(BODY, sig(BODY), SECRET)).toBe(true);
    expect(verifyWebhookSignature(new TextEncoder().encode(BODY), sig(BODY).toUpperCase(), SECRET)).toBe(true);
  });
  it("rejects a changed body, even whitespace", () => {
    expect(verifyWebhookSignature(BODY + " ", sig(BODY), SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY.replace("HMS-1", "HMS-2"), sig(BODY), SECRET)).toBe(false);
  });
  it("rejects a wrong secret, missing, short or non-hex signatures", () => {
    expect(verifyWebhookSignature(BODY, sig(BODY, "other-secret-value"), SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, "", SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, "abc123", SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, "z".repeat(128), SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, sig(BODY), "")).toBe(false);
  });
});

function fakeFetch(status: number, body: unknown, seen: { url?: string; auth?: string | null } = {}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.auth = new Headers(init?.headers).get("authorization");
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("verifyTransaction", () => {
  it("maps a successful verify response, in kobo, and sends the bearer key to the encoded URL", async () => {
    const seen: { url?: string; auth?: string | null } = {};
    const res = await verifyTransaction("HMS-ABC 1", SECRET, fakeFetch(200, {
      status: true, message: "Verification successful",
      data: { id: 4099260516, status: "success", reference: "HMS-ABC 1", amount: 250000, currency: "ngn", channel: "card" },
    }, seen));
    expect(seen.url).toBe("https://api.paystack.co/transaction/verify/HMS-ABC%201");
    expect(seen.auth).toBe(`Bearer ${SECRET}`);
    expect(res).toEqual({ ok: true, transaction: { id: 4099260516, status: "success", reference: "HMS-ABC 1", amountMinor: 250000, currency: "NGN", channel: "card" } });
  });
  it("treats 404 and status:false as not found", async () => {
    expect(await verifyTransaction("x", SECRET, fakeFetch(404, { status: false }))).toEqual({ ok: false, reason: "not_found" });
    expect(await verifyTransaction("x", SECRET, fakeFetch(200, { status: false }))).toEqual({ ok: false, reason: "not_found" });
  });
  it("throws on server errors, rate limits and unexpected shapes so the webhook is retried", async () => {
    await expect(verifyTransaction("x", SECRET, fakeFetch(500, {}))).rejects.toThrow();
    await expect(verifyTransaction("x", SECRET, fakeFetch(429, {}))).rejects.toThrow();
    await expect(verifyTransaction("x", SECRET, fakeFetch(200, { status: true, data: { status: "success", amount: "1" } }))).rejects.toThrow();
  });
});
