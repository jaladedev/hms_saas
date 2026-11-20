import { describe, expect, it, vi } from "vitest";
import { bearerKey, hashApiKey, parseAuth } from "./keys";
import { drainWebhooks, isSafeWebhookUrl, sendWebhook, signWebhook, verifyWebhook, type Delivery } from "./webhook-send";

const KEY = `hms_${"a".repeat(8)}_${"b".repeat(48)}`;

describe("keys", () => {
  it("reads a bearer key only when it has our shape", () => {
    expect(bearerKey(`Bearer ${KEY}`)).toBe(KEY);
    expect(bearerKey(`bearer ${KEY}`)).toBe(KEY);
    for (const h of [null, "", KEY, "Bearer", "Bearer abc", `Bearer ${KEY}x`, `Basic ${KEY}`, `Bearer ${KEY} extra`])
      expect(bearerKey(h)).toBeNull();
  });
  it("hashes to sha256 hex, the same way the database does", () => {
    expect(hashApiKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("reads the database's answer about a key", () => {
    expect(parseAuth({ ok: true, key_id: "k", property_id: "p", scopes: ["bookings.read", 5] })).toEqual({
      ok: true,
      keyId: "k",
      propertyId: "p",
      scopes: ["bookings.read"],
    });
    expect(parseAuth({ ok: false, reason: "rate_limited", retry_after: 12 })).toEqual({
      ok: false,
      reason: "rate_limited",
      retryAfter: 12,
    });
    expect(parseAuth({ ok: false, reason: "off" })).toMatchObject({ reason: "off" });
    expect(parseAuth({ ok: false, reason: "whatever" })).toEqual({ ok: false, reason: "invalid" });
    expect(parseAuth(null)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("webhook signing", () => {
  it("verifies its own signature and nothing else", () => {
    const header = signWebhook("whsec_x", '{"a":1}', 1000);
    expect(header).toMatch(/^t=1000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhook("whsec_x", '{"a":1}', header, 1100)).toBe(true);
    expect(verifyWebhook("whsec_x", '{"a":2}', header, 1100)).toBe(false);
    expect(verifyWebhook("whsec_y", '{"a":1}', header, 1100)).toBe(false);
    expect(verifyWebhook("whsec_x", '{"a":1}', header, 1000 + 301)).toBe(false);
    expect(verifyWebhook("whsec_x", '{"a":1}', "garbage", 1000)).toBe(false);
  });
});

describe("webhook addresses", () => {
  it("allows public https only", () => {
    expect(isSafeWebhookUrl("https://example.com/hooks/a")).toBe(true);
    expect(isSafeWebhookUrl("https://hooks.example.co.uk:443/x")).toBe(true);
  });
  it("refuses http, odd ports, credentials, local and private addresses", () => {
    for (const u of [
      "http://example.com/a",
      "https://example.com:8443/a",
      "https://user:pw@example.com/a",
      "https://localhost/a",
      "https://intranet/a",
      "https://printer.local/a",
      "https://127.0.0.1/a",
      "https://10.1.2.3/a",
      "https://172.20.0.1/a",
      "https://192.168.0.5/a",
      "https://169.254.169.254/latest/meta-data",
      "https://100.64.0.1/a",
      "https://[::1]/a",
      "https://[fd00::1]/a",
      "not a url",
    ])
      expect(isSafeWebhookUrl(u), u).toBe(false);
  });
});

const delivery = (over: Partial<Delivery> = {}): Delivery => ({
  id: "d1",
  url: "https://example.com/h",
  secret: "whsec_x",
  event: "booking.created",
  payload: { reference: "BK-1" },
  attempts: 1,
  ...over,
});

describe("sending", () => {
  it("posts the signed body without following redirects", async () => {
    const f = vi.fn(async () => new Response("ok", { status: 200 }));
    const out = await sendWebhook(delivery(), f as unknown as typeof fetch, () => 1000);
    expect(out).toEqual({ ok: true, code: 200, error: null });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe("https://example.com/h");
    expect(init.redirect).toBe("manual");
    expect(headers["hms-event"]).toBe("booking.created");
    expect(verifyWebhook("whsec_x", init.body as string, headers["hms-signature"]!, 1000)).toBe(true);
  });
  it("treats a redirect or an error answer as a failure and never throws", async () => {
    expect((await sendWebhook(delivery(), (async () => new Response(null, { status: 302 })) as unknown as typeof fetch)).ok).toBe(false);
    expect(await sendWebhook(delivery(), (async () => new Response("no", { status: 500 })) as unknown as typeof fetch)).toMatchObject({
      ok: false,
      code: 500,
    });
    expect(
      await sendWebhook(delivery(), (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch),
    ).toMatchObject({ ok: false, code: null });
  });
  it("does not send to an address that is not allowed", async () => {
    const f = vi.fn();
    expect(await sendWebhook(delivery({ url: "https://10.0.0.1/a" }), f as unknown as typeof fetch)).toMatchObject({
      ok: false,
      error: "address not allowed",
    });
    expect(f).not.toHaveBeenCalled();
  });
  it("drains: claims, sends each, records each result", async () => {
    const mark = vi.fn(async () => {});
    const f = vi.fn(async (u: string | URL | Request) => new Response("", { status: String(u).includes("bad") ? 500 : 200 }));
    const out = await drainWebhooks(
      { claim: async () => [delivery(), delivery({ id: "d2", url: "https://example.com/bad" })], mark },
      10,
      f as unknown as typeof fetch,
    );
    expect(out).toEqual({ claimed: 2, sent: 1, failed: 1 });
    expect(mark).toHaveBeenCalledWith("d1", { ok: true, code: 200, error: null });
    expect(mark).toHaveBeenCalledWith("d2", expect.objectContaining({ ok: false, code: 500 }));
  });
});
