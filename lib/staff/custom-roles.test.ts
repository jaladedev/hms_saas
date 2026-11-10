import { describe, expect, it } from "vitest";
import { ALL_PERMISSION_KEYS, isRoleKey, parseCustomRoles, roleSummary, validateRole } from "./custom-roles";

describe("validateRole", () => {
  it("accepts a name and permissions, trimming and de-duplicating", () => {
    const r = validateRole("  Night auditor ", ["report.view", "report.view", "payment.verify"]);
    expect(r).toEqual({ ok: true, value: { name: "Night auditor", permissions: ["report.view", "payment.verify"] } });
  });
  it("rejects bad names", () => {
    for (const n of ["", "A", "x".repeat(61), "<b>", null, 4]) expect(validateRole(n, ["report.view"])).toEqual({ ok: false, code: "role_name" });
  });
  it("rejects empty, unknown, staff.manage and request-plus-approve", () => {
    for (const p of [[], ["nope"], ["staff.manage"], ["refund.request", "refund.approve"], "report.view", null]) {
      expect(validateRole("Okay", p)).toEqual({ ok: false, code: "role_permissions" });
    }
  });
  it("allows either refund permission alone", () => {
    expect(validateRole("Okay", ["refund.request"]).ok).toBe(true);
    expect(validateRole("Okay", ["refund.approve"]).ok).toBe(true);
  });
  it("never offers staff.manage", () => expect(ALL_PERMISSION_KEYS).not.toContain("staff.manage"));
});

describe("role keys and lists", () => {
  it("accepts system and custom keys only", () => {
    expect(isRoleKey("front_desk")).toBe(true);
    expect(isRoleKey("custom.night-auditor.0a1b2c3d")).toBe(true);
    expect(isRoleKey("custom.x")).toBe(false);
    expect(isRoleKey("Bad Key")).toBe(false);
  });
  it("parses lists defensively and summarises", () => {
    expect(parseCustomRoles(null)).toEqual([]);
    expect(parseCustomRoles([{ id: "1", key: "k", name: "n", permissions: ["a"], holders: 0 }, { nope: 1 }])).toHaveLength(1);
    expect(roleSummary({ permissions: ["a"], holders: 0 })).toBe("1 permission, nobody holds it yet");
    expect(roleSummary({ permissions: ["a", "b"], holders: 2 })).toBe("2 permissions, held by 2 people");
  });
});
