import { describe, expect, it } from "vitest";
import {
  classifyPlatformError,
  filterHotels,
  flagCell,
  gridKeys,
  readOverview,
  ERROR_MESSAGES,
  FIELD_MESSAGES,
  normalizeHost,
  normalizeSecretReference,
  OK_MESSAGES,
  parseNairaToKobo,
  planPriceLabel,
  shortDate,
  slugFromName,
  validateNewHotel,
} from "./hotel";

const good = {
  name: "  Grand   Hotels ",
  propertyName: "Grand Ibadan",
  propertyCode: "gib",
  host: "https://Book.Grand-Hotels.com:443/rooms?x=1",
  ownerEmail: " Owner@Grand-Hotels.com ",
};

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
      name: "Grand Hotels",
      slug: "grand-hotels",
      propertyName: "Grand Ibadan",
      propertyCode: "GIB",
      host: "book.grand-hotels.com",
      ownerEmail: "owner@grand-hotels.com",
      timezone: "Africa/Lagos",
      currency: "NGN",
      secretReference: "",
      paymentMode: "test",
    });
  });
  it("takes an explicit slug, secret and live mode", () => {
    const r = validateNewHotel({ ...good, slug: "Grand-1", secretReference: "PAYSTACK_SECRET_GRAND", paymentMode: "live" });
    expect(r.ok && r.value).toMatchObject({ slug: "grand-1", secretReference: "env:PAYSTACK_SECRET_GRAND", paymentMode: "live" });
  });
  const field = (over: Record<string, unknown>) => {
    const r = validateNewHotel({ ...good, ...over });
    return r.ok ? "ok" : r.field;
  };
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
    for (const f of [
      "name",
      "slug",
      "property_name",
      "code",
      "timezone",
      "currency",
      "host",
      "owner_email",
      "secret_reference",
      "payment_mode",
    ] as const) {
      expect(FIELD_MESSAGES[f].length).toBeGreaterThan(10);
    }
  });
});

describe("classifyPlatformError", () => {
  const c = (message: string, code?: string) => classifyPlatformError({ message, ...(code ? { code } : {}) });
  it("maps every refusal the functions in migrations 050, 051 and 054 raise", () => {
    expect(c("NOT_FOUND")).toBe("not_found");
    expect(c("NOT_FOUND: owner")).toBe("owner_missing");
    expect(c("NOT_FOUND: property")).toBe("property");
    expect(c("CONFLICT: slug")).toBe("slug_taken");
    expect(c("CONFLICT: host")).toBe("host_taken");
    expect(c("CONFLICT: invoice period")).toBe("invoice_exists");
    expect(c("CONFLICT: invoice state")).toBe("invoice_state");
    for (const [m, k] of [
      ["name", "name"],
      ["slug", "slug"],
      ["code", "code"],
      ["currency", "currency"],
      ["host", "host"],
      ["timezone", "timezone"],
      ["reason", "reason"],
      ["status", "status"],
      ["secret reference", "secret_reference"],
      ["payment mode", "payment_mode"],
      ["verified", "bad_request"],
      ["plan", "plan"],
      ["plan code", "plan"],
      ["invoice period", "invoice_details"],
      ["invoice due", "invoice_details"],
      ["invoice note", "invoice_details"],
      ["invoice amount", "invoice_details"],
      ["invoice reference", "invoice_details"],
      ["invoice reason", "invoice_details"],
      ["plan name", "plan_details"],
      ["plan description", "plan_details"],
      ["plan price", "plan_details"],
      ["plan active", "plan_details"],
      ["plan features", "plan_details"],
      ["subscription status", "subscription_status"],
      ["feature key", "feature_key"],
      ["enabled", "bad_request"],
    ] as const) {
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

describe("migrations 050, 051 and 054 and the wording agree", () => {
  it("every refusal the migration raises is one the classifier understands", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = "supabase/migrations";
    const sql = ["_platform_admin.sql", "_platform_plans.sql", "_owner_invite.sql"]
      .map((end) => readFileSync(`${dir}/${readdirSync(dir).find((f) => f.endsWith(end))!}`, "utf8"))
      .join("\n");
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

describe("plan prices", () => {
  it("turns an amount typed in naira into whole kobo, and refuses anything else", () => {
    expect(parseNairaToKobo("35,000")).toBe(3500000);
    expect(parseNairaToKobo(" ₦15000.50 ")).toBe(1500050);
    expect(parseNairaToKobo("0")).toBe(0);
    for (const bad of ["", "-1", "1.234", "abc", "1e5", "1,000,000,000,000"]) expect(parseNairaToKobo(bad)).toBeNull();
  });
  it("marks a placeholder price so nobody reads it as decided", () => {
    expect(planPriceLabel(3500000, "NGN", false)).toMatch(/35,000\.00 a month$/);
    expect(planPriceLabel(3500000, "NGN", true)).toMatch(/a month \(placeholder\)$/);
  });
});

const hotels = [
  { id: "1", name: "Bodija Boutique", slug: "bodija", status: "active", plan_code: "pro", subscription_status: "active" },
  { id: "2", name: "Lagos Retreat", slug: "lagos-retreat", status: "suspended", plan_code: null, subscription_status: null },
  { id: "3", name: "Ibadan Grand", slug: "ibadan-grand", status: "active", plan_code: "standard", subscription_status: "trial" },
];

describe("filterHotels", () => {
  it("returns everything for a blank search", () => {
    expect(filterHotels(hotels, undefined)).toHaveLength(3);
    expect(filterHotels(hotels, "   ")).toHaveLength(3);
  });
  it("matches name, slug, plan and subscription status in any case, all words together", () => {
    expect(filterHotels(hotels, "BODIJA").map((h) => h.id)).toEqual(["1"]);
    expect(filterHotels(hotels, "retreat").map((h) => h.id)).toEqual(["2"]);
    expect(filterHotels(hotels, "standard trial").map((h) => h.id)).toEqual(["3"]);
    expect(filterHotels(hotels, "grand pro")).toEqual([]);
    expect(filterHotels(hotels, "nothing here")).toEqual([]);
  });
  it("narrows by status, with or without words", () => {
    expect(filterHotels(hotels, "", "suspended").map((h) => h.id)).toEqual(["2"]);
    expect(filterHotels(hotels, "grand", "active").map((h) => h.id)).toEqual(["3"]);
    expect(filterHotels(hotels, "lagos", "active")).toEqual([]);
  });
});

describe("entitlement grid", () => {
  const enforced = ["reports.export", "discounts"];
  it("shows a set row as on or off, an enforced flag without a row as default on, any other key as not set", () => {
    const e = [
      { feature_key: "discounts", enabled: false },
      { feature_key: "api.access", enabled: true },
    ];
    expect(flagCell(e, "discounts", enforced)).toBe("off");
    expect(flagCell(e, "api.access", enforced)).toBe("on");
    expect(flagCell(e, "reports.export", enforced)).toBe("default-on");
    expect(flagCell(e, "branding", enforced)).toBe("unset");
  });
  it("lists the enforced flags first, then every other key any hotel has, sorted and once", () => {
    const o = readOverview({
      enforced,
      hotels: [
        {
          ...hotels[0],
          entitlements: [
            { feature_key: "zeta", enabled: true },
            { feature_key: "api.access", enabled: true },
          ],
        },
        {
          ...hotels[1],
          entitlements: [
            { feature_key: "api.access", enabled: false },
            { feature_key: "discounts", enabled: false },
          ],
        },
      ],
    });
    expect(gridKeys(o)).toEqual(["reports.export", "discounts", "api.access", "zeta"]);
  });
  it("reads a malformed overview as an empty one", () => {
    for (const bad of [null, undefined, 5, "x", [], { hotels: "x", enforced: 3 }])
      expect(readOverview(bad)).toEqual({ enforced: [], hotels: [] });
    expect(readOverview({ enforced: ["a", 2], hotels: [{ id: "1", entitlements: null }] }).hotels[0]?.entitlements).toEqual([]);
  });
});
