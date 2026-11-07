import { describe, expect, it } from "vitest";
import { classifyPlatformError, ERROR_MESSAGES, FIELD_MESSAGES, normalizeHost, normalizeSecretReference, OK_MESSAGES, shortDate, slugFromName, validateNewHotel } from "./hotel";

const good = { name: "  Grand   Hotels ", propertyName: "Grand Ibadan", propertyCode: "gib", host: "https://Book.Grand-Hotels.com:443/rooms?x=1", ownerEmail: " Owner@Grand-Hotels.com " };

describe("slugFromName", () => {
  it("makes a short name from a hotel name", () => {
    expect(slugFromName("Hotel Ibadan & Suites")).toBe("hotel-ibadan-suites");
    expect(slugFromName("  Ọlá's  Lodge ")).toBe("ola-s-lodge");
    expect(slugFromName("***")).toBe("");
  });
  it("is never longer than the database allows and never ends in a hyphen", () => {
    const s = slugFromName("a".repeat(40) + " " + "b".repeat(40));
    expect(s.length).toBeLessThanOrEqual(63);
    expect(s.endsWith("-")).toBe(false);
  });
});

describe("normalizeHost", () => {
  it("reduces what is pasted to the host", () => {
    expect(normalizeHost("https://Book.Hotel.com:443/path?q#h")).toBe("book.hotel.com");
    expect(normalizeHost("book.hotel.com.")).toBe("book.hotel.com");
    expect(normalizeHost("  HTTP://a.b.co  ")).toBe("a.b.co");
  });
});

describe("normalizeSecretReference", () => {
  it("adds env: to a bare name and keeps a full one", () => {
    expect(normalizeSecretReference("PAYSTACK_SECRET_X")).toBe("env:PAYSTACK_SECRET_X");
    expect(normalizeSecretReference("env:PAYSTACK_SECRET_X")).toBe("env:PAYSTACK_SECRET_X");
    expect(normalizeSecretReference("   ")).toBe("");
  });
});

describe("validateNewHotel", () => {
  it("cleans a good form and fills the defaults", () => {
    const r = validateNewHotel(good);
    expect(r.ok && r.value).toMatchObject({
      name: "Grand Hotels", slug: "grand-hotels", propertyName: "Grand Ibadan", propertyCode: "GIB", host: "book.grand-hotels.com",
      ownerEmail: "owner@grand-hotels.com", timezone: "Africa/Lagos", currency: "NGN", secretReference: "", paymentMode: "test",
    });
  });
  it("takes an explicit slug, secret and live mode", () => {
    const r = validateNewHotel({ ...good, slug: "Grand-1", secretReference: "PAYSTACK_SECRET_GRAND", paymentMode: "live" });
    expect(r.ok && r.value).toMatchObject({ slug: "grand-1", secretReference: "env:PAYSTACK_SECRET_GRAND", paymentMode: "live" });
  });
  const field = (over: Record<string, unknown>) => { const r = validateNewHotel({ ...good, ...over }); return r.ok ? "ok" : r.field; };
  it("names the first field that is wrong", () => {
    expect(field({ name: "   " })).toBe("name");
    expect(field({ name: "x".repeat(121) })).toBe("name");
    expect(field({ propertyName: "" })).toBe("property_name");
    expect(field({ slug: "-bad-" })).toBe("slug");
    expect(field({ name: "***" })).toBe("slug");
    expect(field({ propertyCode: "A" })).toBe("code");
    expect(field({ propertyCode: "has space" })).toBe("code");
    expect(field({ timezone: "Mars Base" })).toBe("timezone");
    expect(field({ currency: "naira" })).toBe("currency");
    expect(field({ host: "localhost" })).toBe("host");
    expect(field({ host: "" })).toBe("host");
    expect(field({ ownerEmail: "not-an-email" })).toBe("owner_email");
    expect(field({ secretReference: "lower_case" })).toBe("secret_reference");
    expect(field({ paymentMode: "sandbox" })).toBe("payment_mode");
  });
  it("has a message for every field it can name", () => {
    for (const f of ["name", "slug", "property_name", "code", "timezone", "currency", "host", "owner_email", "secret_reference", "payment_mode"] as const) {
      expect(FIELD_MESSAGES[f].length).toBeGreaterThan(10);
    }
  });
});

describe("classifyPlatformError", () => {
  const c = (message: string, code?: string) => classifyPlatformError({ message, ...(code ? { code } : {}) });
  it("maps every refusal the functions in migrations 050 and 051 raise", () => {
    expect(c("NOT_FOUND")).toBe("not_found");
    expect(c("NOT_FOUND: owner")).toBe("owner_missing");
    expect(c("NOT_FOUND: property")).toBe("property");
    expect(c("CONFLICT: slug")).toBe("slug_taken");
    expect(c("CONFLICT: host")).toBe("host_taken");
    for (const [m, k] of [["name", "name"], ["slug", "slug"], ["code", "code"], ["currency", "currency"], ["host", "host"], ["timezone", "timezone"], ["reason", "reason"], ["status", "status"],
                          ["secret reference", "secret_reference"], ["payment mode", "payment_mode"], ["verified", "bad_request"],
                          ["plan", "plan"], ["subscription status", "subscription_status"], ["feature key", "feature_key"], ["enabled", "bad_request"]] as const) {
      expect(c(`POLICY_VIOLATION: ${m}`)).toBe(k);
    }
  });
  it("treats anything else as unavailable, never echoing the database's words", () => {
    expect(c("connection reset")).toBe("unavailable");
    expect(c("permission denied for function", "42501")).toBe("forbidden");
    expect(classifyPlatformError(null)).toBe("unavailable");
  });
  it("has wording for every code and every success", () => {
    for (const m of Object.values(ERROR_MESSAGES)) expect(m.length).toBeGreaterThan(10);
    for (const m of Object.values(OK_MESSAGES)) expect(m.length).toBeGreaterThan(10);
  });
});

describe("migrations 050 and 051 and the wording agree", () => {
  it("every refusal the migration raises is one the classifier understands", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = "supabase/migrations";
    const sql = ["_platform_admin.sql", "_platform_plans.sql"].map((end) => readFileSync(`${dir}/${readdirSync(dir).find((f) => f.endsWith(end))!}`, "utf8")).join("\n");
    const raised = [...sql.matchAll(/raise exception '((?:POLICY_VIOLATION|NOT_FOUND|CONFLICT)[^']*)'/g)].map((m) => m[1]!);
    expect(raised.length).toBeGreaterThan(10);
    for (const msg of new Set(raised)) expect(classifyPlatformError({ message: msg }), msg).not.toBe("unavailable");
  });
});

describe("shortDate", () => {
  it("shows the day, or says never or unknown", () => {
    expect(shortDate("2026-11-05T12:43:11.568988+01:00")).toBe("2026-11-05");
    expect(shortDate(null)).toBe("never");
    expect(shortDate("garbage")).toBe("unknown");
  });
});
