import { describe, expect, it } from "vitest";
import { buildCaps, capResultCode, capSummary, classifyCapError, parseCapForm, percentInput, percentText } from "./discount-caps";
import { errorMessage, OK_MESSAGES } from "./refunds";

const P = "6f1c1c1e-2b7a-4a55-9a43-1d2a8d9a1f10";
const Q = "7f1c1c1e-2b7a-4a55-9a43-1d2a8d9a1f11";
const defaults = [
  { role_key: "front_desk", max_percent: "10.00" },
  { role_key: "owner", max_percent: 100 },
  { role_key: "general_manager", max_percent: "100.00" },
];
const roles = [
  { key: "owner", name: "Hotel owner" },
  { key: "general_manager", name: "General manager" },
  { key: "front_desk", name: "Front desk" },
];

describe("buildCaps", () => {
  it("lists the roles with a default, owner first, and uses the default when the hotel has no setting", () => {
    const caps = buildCaps(P, defaults, [], roles);
    expect(caps.map((c) => c.roleKey)).toEqual(["owner", "general_manager", "front_desk"]);
    expect(caps.map((c) => c.percent)).toEqual([100, 100, 10]);
    expect(caps.every((c) => c.source === "default")).toBe(true);
    expect(caps[2]!.name).toBe("Front desk");
  });
  it("uses this hotel's own setting, even a lower one, and ignores another hotel's", () => {
    const caps = buildCaps(
      P,
      defaults,
      [
        { property_id: P, role_key: "front_desk", max_percent: "0.00" },
        { property_id: Q, role_key: "general_manager", max_percent: 5 },
      ],
      roles,
    );
    const fd = caps.find((c) => c.roleKey === "front_desk")!;
    expect(fd).toMatchObject({ percent: 0, defaultPercent: 10, source: "override" });
    expect(caps.find((c) => c.roleKey === "general_manager")).toMatchObject({ percent: 100, source: "default" });
  });
  it("puts a role it does not know after the usual ones, by name, and falls back to the key for a name", () => {
    const caps = buildCaps(P, [...defaults, { role_key: "sales", max_percent: 3 }, { role_key: "audit", max_percent: 1 }], [], roles);
    expect(caps.map((c) => c.roleKey)).toEqual(["owner", "general_manager", "front_desk", "audit", "sales"]);
    expect(caps[3]!.name).toBe("audit");
  });
});

describe("wording", () => {
  it("shows percentages without trailing zeros", () => {
    expect(percentText(10)).toBe("10%");
    expect(percentText(7.5)).toBe("7.5%");
    expect(percentText(0)).toBe("0%");
    expect(percentInput(10)).toBe("10");
    expect(percentInput(7.5)).toBe("7.5");
  });
  it("sums up a limit in words", () => {
    const base = { roleKey: "x", name: "X", defaultPercent: 10, source: "default" as const };
    expect(capSummary({ ...base, percent: 0 })).toBe("cannot give discounts");
    expect(capSummary({ ...base, percent: 10 })).toBe("may discount up to 10%");
    expect(capSummary({ ...base, percent: 100 })).toBe("may discount up to a free stay");
  });
});

describe("parseCapForm", () => {
  it("accepts a percent from 0 to 100 with at most two decimals", () => {
    expect(parseCapForm({ property: P, role: "front_desk", percent: "15" })).toEqual({
      ok: true,
      value: { property: P, role: "front_desk", percent: 15 },
    });
    expect(parseCapForm({ property: P, role: "front_desk", percent: "7.5%" })).toEqual({
      ok: true,
      value: { property: P, role: "front_desk", percent: 7.5 },
    });
    expect(parseCapForm({ property: P, role: "front_desk", percent: "0" })).toMatchObject({ ok: true, value: { percent: 0 } });
    expect(parseCapForm({ property: P, role: "front_desk", percent: "100" })).toMatchObject({ ok: true, value: { percent: 100 } });
  });
  it("refuses anything else before the database is asked", () => {
    for (const percent of ["", "abc", "-1", "100.01", "101", "7.555", "1e1", undefined]) {
      expect(parseCapForm({ property: P, role: "front_desk", percent })).toEqual({ ok: false, code: "dc_cap_percent" });
    }
  });
  it("treats Use the default as a reset, whatever the field holds", () => {
    expect(parseCapForm({ property: P, role: "front_desk", percent: "garbage", reset: "1" })).toEqual({
      ok: true,
      value: { property: P, role: "front_desk", percent: null },
    });
  });
  it("refuses a missing or malformed hotel or role", () => {
    expect(parseCapForm({ role: "front_desk", percent: "5" })).toEqual({ ok: false, code: "bad_request" });
    expect(parseCapForm({ property: "nope", role: "front_desk", percent: "5" })).toEqual({ ok: false, code: "bad_request" });
    expect(parseCapForm({ property: P, role: "Front Desk!", percent: "5" })).toEqual({ ok: false, code: "bad_request" });
    expect(parseCapForm({ property: P, percent: "5" })).toEqual({ ok: false, code: "bad_request" });
  });
});

describe("refusals and messages", () => {
  it("classifies the database's refusals", () => {
    expect(classifyCapError("POLICY_VIOLATION: percent")).toBe("dc_cap_percent");
    expect(classifyCapError("POLICY_VIOLATION: role")).toBe("dc_cap_role");
    expect(classifyCapError("NOT_FOUND")).toBe("not_found");
    expect(classifyCapError("boom")).toBe("unknown");
  });
  it("tells a reset from a set", () => {
    expect(capResultCode({ source: "default" })).toBe("discount_cap_reset");
    expect(capResultCode({ source: "override" })).toBe("discount_cap_set");
    expect(capResultCode(null)).toBe("discount_cap_set");
  });
  it("has a plain sentence for each code", () => {
    expect(errorMessage("dc_cap_percent", null, String)).toMatch(/0 to 100/);
    expect(errorMessage("dc_cap_role", null, String)).toMatch(/cannot give discounts/);
    expect(OK_MESSAGES.discount_cap_set).toBeTruthy();
    expect(OK_MESSAGES.discount_cap_reset).toBeTruthy();
  });
});
