import { describe, expect, it } from "vitest";
import { checkProfileForm, describeRoles, groupPermissions, parseDensity, profileErrorCode } from "./profile";

describe("profile form", () => {
  const ok = { full_name: "Ada Okafor", phone: "+2348000000001", density: "comfortable" };
  it("accepts a good form and a blank phone", () => {
    expect(checkProfileForm(ok)).toBeNull();
    expect(checkProfileForm({ ...ok, phone: "" })).toBeNull();
    expect(checkProfileForm({ ...ok, density: "compact" })).toBeNull();
  });
  it("refuses a missing or oversized name, a long phone and an unknown density", () => {
    expect(checkProfileForm({ ...ok, full_name: "   " })).toBe("profile_name");
    expect(checkProfileForm({ ...ok, full_name: "n".repeat(201) })).toBe("profile_name");
    expect(checkProfileForm({ ...ok, full_name: "n".repeat(200) })).toBeNull();
    expect(checkProfileForm({ ...ok, phone: "1".repeat(41) })).toBe("profile_phone");
    expect(checkProfileForm({ ...ok, phone: "1".repeat(40) })).toBeNull();
    expect(checkProfileForm({ ...ok, density: "cosy" })).toBe("profile_density");
  });
  it("counts a name by what is left after whitespace is collapsed", () => {
    expect(checkProfileForm({ ...ok, full_name: `${"a ".repeat(100)}` })).toBeNull();
  });
  it("turns database refusals into the same codes", () => {
    expect(profileErrorCode("POLICY_VIOLATION: name")).toBe("profile_name");
    expect(profileErrorCode("POLICY_VIOLATION: too long")).toBe("profile_phone");
    expect(profileErrorCode("POLICY_VIOLATION: density")).toBe("profile_density");
    expect(profileErrorCode("NOT_FOUND")).toBeNull();
  });
  it("falls back to comfortable for anything unknown", () => {
    expect(parseDensity("compact")).toBe("compact");
    expect(parseDensity("comfortable")).toBe("comfortable");
    expect(parseDensity("tiny")).toBe("comfortable");
    expect(parseDensity(null)).toBe("comfortable");
    expect(parseDensity(undefined)).toBe("comfortable");
  });
});

describe("permission summary", () => {
  it("groups keys by area with friendly names, sorted", () => {
    expect(groupPermissions(["guest.view", "guest.manage", "payment.record", "payment.verify", "report.view"])).toEqual([
      { area: "Guests", actions: ["manage", "view"] },
      { area: "Payments", actions: ["record", "verify"] },
      { area: "Reports", actions: ["view"] },
    ]);
  });
  it("shows an unknown area as its key and never drops a permission", () => {
    expect(groupPermissions(["spa.book", "spa.cancel_late", "lonely"])).toEqual([
      { area: "Lonely", actions: [] },
      { area: "Spa", actions: ["book", "cancel late"] },
    ]);
    expect(groupPermissions([])).toEqual([]);
  });
  it("lists a repeated key once", () => {
    expect(groupPermissions(["guest.view", "guest.view"])).toEqual([{ area: "Guests", actions: ["view"] }]);
  });
});

describe("role lines", () => {
  const names = new Map([
    ["p1", "Hotel A"],
    ["p2", "Hotel B"],
  ]);
  const name = (id: string) => names.get(id);
  it("says all hotels for a group-wide role and names the hotels otherwise", () => {
    expect(
      describeRoles(
        [
          { role_name: "Owner", property_id: null },
          { role_name: "Front Desk", property_id: "p1" },
        ],
        name,
      ),
    ).toEqual(["Front Desk, Hotel A", "Owner, all hotels"]);
  });
  it("lists a role held at several hotels once", () => {
    expect(
      describeRoles(
        [
          { role_name: "Front Desk", property_id: "p2" },
          { role_name: "Front Desk", property_id: "p1" },
        ],
        name,
      ),
    ).toEqual(["Front Desk, Hotel A and Hotel B"]);
  });
  it("lets all hotels win when a role is held both ways, and copes with a hotel that is not visible", () => {
    expect(
      describeRoles(
        [
          { role_name: "Manager", property_id: "p1" },
          { role_name: "Manager", property_id: null },
        ],
        name,
      ),
    ).toEqual(["Manager, all hotels"]);
    expect(describeRoles([{ role_name: "Manager", property_id: "gone" }], name)).toEqual(["Manager, a hotel you can no longer see"]);
    expect(describeRoles([], name)).toEqual([]);
  });
});
