import { describe, expect, it } from "vitest";
import { formatDate, formatMoney, formatTime } from "@/lib/guest-site/format";
import { guestSchema, parseStayParams, stayQuery } from "@/lib/guest-site/params";
import { friendlyError, messageForCode } from "@/lib/guest-site/errors";

describe("format", () => {
  it("formats kobo as naira and dates without timezone drift", () => {
    expect(formatMoney(250000, "NGN")).toContain("2,500.00");
    expect(formatDate("2026-11-03")).toBe("Tue, 3 Nov 2026");
    expect(formatDate("2026-12-31")).toContain("31 Dec 2026");
    expect(formatTime("14:00:00")).toBe("14:00");
  });
});

describe("stay params", () => {
  it("parses valid params with defaults", () => {
    expect(parseStayParams({ arrival: "2026-11-03", departure: "2026-11-05" })).toEqual({ arrival: "2026-11-03", departure: "2026-11-05", adults: 2, children: 0 });
    expect(parseStayParams({ arrival: ["2026-11-03"], departure: "2026-11-05", adults: "1", children: "2" })).toMatchObject({ adults: 1, children: 2 });
  });
  it("rejects missing, reversed, malformed or out-of-range values", () => {
    expect(parseStayParams({})).toBeNull();
    expect(parseStayParams({ arrival: "2026-11-05", departure: "2026-11-03" })).toBeNull();
    expect(parseStayParams({ arrival: "2026-11-05", departure: "2026-11-05" })).toBeNull();
    expect(parseStayParams({ arrival: "11/03/2026", departure: "2026-11-05" })).toBeNull();
    expect(parseStayParams({ arrival: "2026-13-40", departure: "2026-14-01" })).toBeNull();
    expect(parseStayParams({ arrival: "2026-11-03", departure: "2026-11-05", adults: "0" })).toBeNull();
    expect(parseStayParams({ arrival: "2026-11-03", departure: "2026-11-05", adults: "99" })).toBeNull();
  });
  it("round-trips through a query string", () => {
    const p = { arrival: "2026-11-03", departure: "2026-11-05", adults: 2, children: 1 };
    expect(parseStayParams(Object.fromEntries(new URLSearchParams(stayQuery(p))))).toEqual(p);
  });
});

describe("guest details", () => {
  it("normalises email and rejects bad input", () => {
    expect(guestSchema.parse({ full_name: " Ada Obi ", email: " ADA@Example.com ", phone: "" })).toEqual({ full_name: "Ada Obi", email: "ada@example.com", phone: "" });
    expect(guestSchema.safeParse({ full_name: "A", email: "ada@example.com" }).success).toBe(false);
    expect(guestSchema.safeParse({ full_name: "Ada Obi", email: "nope" }).success).toBe(false);
  });
});

describe("friendly errors", () => {
  it("maps known database errors", () => {
    expect(friendlyError("ROOM_UNAVAILABLE").code).toBe("unavailable");
    expect(friendlyError("POLICY_VIOLATION: too many active holds").code).toBe("too_many_holds");
    expect(friendlyError("INVALID_STATE: hold lapsed").code).toBe("hold_lapsed");
    expect(friendlyError("NOT_FOUND: host").code).toBe("not_configured");
    expect(friendlyError("CAPACITY_EXCEEDED").code).toBe("capacity");
  });
  it("never leaks unknown messages", () => {
    const e = friendlyError("duplicate key value violates unique constraint payments_pkey");
    expect(e.code).toBe("unknown");
    expect(e.message).not.toContain("payments_pkey");
    expect(friendlyError(undefined).code).toBe("unknown");
  });
  it("only echoes messages for known codes", () => {
    expect(messageForCode("unavailable")).toContain("taken");
    expect(messageForCode("<script>alert(1)</script>")).toBeNull();
    expect(messageForCode(undefined)).toBeNull();
  });
});
