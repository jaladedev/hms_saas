import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { initializeTransaction, verifyTransaction, verifyWebhookSignature } from "@/lib/paystack";

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

describe("initializeTransaction", () => {
  const args = { email: "guest@example.com", amountMinor: 250000, currency: "NGN", reference: "HMS-ABC", callbackUrl: "https://book.example/booking/t?paid=1" };
  it("posts our reference and the kobo amount and returns the checkout URL", async () => {
    let sent: { url?: string; body?: Record<string, unknown>; auth?: string | null } = {};
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      sent = { url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") };
      return new Response(JSON.stringify({ status: true, data: { authorization_url: "https://checkout.paystack.com/abc", access_code: "x", reference: "HMS-ABC" } }), { status: 200 });
    }) as typeof fetch;
    const out = await initializeTransaction(args, SECRET, f);
    expect(out).toEqual({ authorizationUrl: "https://checkout.paystack.com/abc" });
    expect(sent.url).toBe("https://api.paystack.co/transaction/initialize");
    expect(sent.auth).toBe(`Bearer ${SECRET}`);
    expect(sent.body).toEqual({ email: "guest@example.com", amount: 250000, currency: "NGN", reference: "HMS-ABC", callback_url: args.callbackUrl });
  });
  it("throws on HTTP errors, bad shapes and a different reference", async () => {
    await expect(initializeTransaction(args, SECRET, fakeFetch(400, { status: false }))).rejects.toThrow();
    await expect(initializeTransaction(args, SECRET, fakeFetch(200, { status: true }))).rejects.toThrow();
    await expect(initializeTransaction(args, SECRET, fakeFetch(200, { status: true, data: { authorization_url: "https://x.test/a", reference: "OTHER" } }))).rejects.toThrow();
  });
});
