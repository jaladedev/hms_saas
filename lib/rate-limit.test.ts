import { describe, expect, it, vi } from "vitest";
import { RATE_RULES, clientIp, enforceRateLimits, subjectKey } from "@/lib/rate-limit";
import { isAuthorizedCron, runMaintenance } from "@/lib/maintenance";

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

describe("clientIp", () => {
  it("takes the first valid forwarded address, falls back to x-real-ip, then 'unknown'", () => {
    expect(clientIp(headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientIp(headers({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientIp(headers({ "x-forwarded-for": "not-an-ip", "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIp(headers({ "x-forwarded-for": "evil; drop table" }))).toBe("unknown");
    expect(clientIp(headers({}))).toBe("unknown");
  });
});

describe("subjectKey", () => {
  it("is stable, case-insensitive, keyed, and does not contain the input", () => {
    const a = subjectKey("secret-one", "Guest@Example.com");
    expect(a).toBe(subjectKey("secret-one", " guest@example.com "));
    expect(a).not.toBe(subjectKey("secret-two", "guest@example.com"));
    expect(a).toHaveLength(32);
    expect(a).not.toContain("guest");
  });
});

describe("enforceRateLimits", () => {
  it("allows when every rule allows and spends one hit on each rule", async () => {
    const consume = vi.fn(async () => ({ allowed: true, retry_after_seconds: 1 }));
    const out = await enforceRateLimits(consume, [{ rule: "hold", subject: "ip1" }, { rule: "holdEmail", subject: "em1" }]);
    expect(out).toEqual({ allowed: true });
    expect(consume).toHaveBeenCalledWith("hold:ip1", RATE_RULES.hold.limit, RATE_RULES.hold.windowSeconds);
    expect(consume).toHaveBeenCalledWith("holdEmail:em1", RATE_RULES.holdEmail.limit, RATE_RULES.holdEmail.windowSeconds);
  });
  it("refuses if any rule refuses, reporting the longest wait, and still counts the others", async () => {
    const consume = vi.fn(async (key: string) => (key.startsWith("hold:") ? { allowed: false, retry_after_seconds: 90 } : { allowed: false, retry_after_seconds: 300 }));
    const out = await enforceRateLimits(consume, [{ rule: "hold", subject: "a" }, { rule: "holdEmail", subject: "b" }]);
    expect(out).toEqual({ allowed: false, retryAfterSeconds: 300 });
    expect(consume).toHaveBeenCalledTimes(2);
  });
  it("lets a database failure propagate (fail closed)", async () => {
    await expect(enforceRateLimits(async () => { throw new Error("db down"); }, [{ rule: "pay", subject: "x" }])).rejects.toThrow("db down");
  });
});

describe("maintenance", () => {
  it("runs every step and isolates failures", async () => {
    const out = await runMaintenance({
      expireLapsedHolds: async () => 3,
      drainEmails: async () => { throw new Error("mailer exploded"); },
      purgeOldData: async () => ({ rate_limit_rows: 1 }),
    });
    expect(out.expiredHolds).toEqual({ ok: true, result: 3 });
    expect(out.emails).toEqual({ ok: false, error: "mailer exploded" });
    expect(out.purge).toEqual({ ok: true, result: { rate_limit_rows: 1 } });
  });
  it("authorises only the exact bearer secret, and only when the secret is long enough", () => {
    const secret = "c".repeat(40);
    expect(isAuthorizedCron(`Bearer ${secret}`, secret)).toBe(true);
    expect(isAuthorizedCron(`Bearer ${secret}x`, secret)).toBe(false);
    expect(isAuthorizedCron(secret, secret)).toBe(false);
    expect(isAuthorizedCron(null, secret)).toBe(false);
    expect(isAuthorizedCron("Bearer short", "short")).toBe(false);
    expect(isAuthorizedCron(`Bearer ${secret}`, undefined)).toBe(false);
  });
});
