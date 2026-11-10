import { describe, expect, it } from "vitest";
import { classifyRpcError, errorMessage, OK_MESSAGES } from "./refunds";
import { memberActions, memberLabel, ROLE_HELP, scopeLabel } from "./staff-rules";

describe("memberActions", () => {
  it("offers everything for another active person", () => {
    expect(memberActions({ status: "active", is_self: false })).toEqual({
      suspend: true,
      reinstate: false,
      revoke: true,
      addRole: true,
      removeRole: true,
    });
  });
  it("offers nothing on yourself, and nothing on someone already removed", () => {
    const none = { suspend: false, reinstate: false, revoke: false, addRole: false, removeRole: false };
    expect(memberActions({ status: "active", is_self: true })).toEqual(none);
    expect(memberActions({ status: "revoked", is_self: false })).toEqual(none);
  });
  it("lets a suspended person be restored or removed but not given new roles", () => {
    expect(memberActions({ status: "suspended", is_self: false })).toEqual({
      suspend: false,
      reinstate: true,
      revoke: true,
      addRole: false,
      removeRole: false,
    });
  });
});

describe("labels", () => {
  it("names where a role applies and who a person is", () => {
    const names = new Map([["p1", "Hotel A Ibadan"]]);
    expect(scopeLabel(null, names)).toBe("all properties");
    expect(scopeLabel("p1", names)).toBe("Hotel A Ibadan");
    expect(scopeLabel("gone", names)).toBe("one property");
    expect(memberLabel({ full_name: " Ada ", email: "a@x.com" })).toBe("Ada");
    expect(memberLabel({ full_name: null, email: "a@x.com" })).toBe("a@x.com");
    expect(memberLabel({ full_name: null, email: null })).toBe("Unknown person");
  });
  it("describes every system role", () => {
    for (const k of ["owner", "general_manager", "front_desk", "reservations_officer", "accountant", "housekeeping", "maintenance"])
      expect(ROLE_HELP[k]).toBeTruthy();
  });
});

describe("staff errors", () => {
  it("maps the database's refusals to codes and plain sentences", () => {
    const cases: [string, string][] = [
      ["POLICY_VIOLATION: ROLE_ESCALATION", "role_escalation"],
      ["POLICY_VIOLATION: SELF_CHANGE", "self_change"],
      ["POLICY_VIOLATION: LAST_OWNER", "last_owner"],
      ["INVALID_STATE: suspended", "staff_suspended"],
      ["INVALID_STATE: revoked", "staff_revoked"],
      ["POLICY_VIOLATION: property", "staff_property"],
      ["POLICY_VIOLATION: status", "bad_request"],
      ["NOT_FOUND", "not_found"],
    ];
    for (const [msg, code] of cases) {
      expect(classifyRpcError(msg).code, msg).toBe(code);
      expect(errorMessage(code, null, String)).not.toMatch(/Something went wrong/);
    }
    expect(errorMessage("invite_failed", null, String)).toMatch(/nobody was added/);
    expect(OK_MESSAGES.staff_added).toMatch(/Access granted/);
  });
});
