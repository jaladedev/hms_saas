import { describe, expect, it } from "vitest";
import { activeNavItem, groupBadgeTotal, groupIdForPath, matchNav, NAV_GROUPS, NAV_HOME, navMatches } from "./nav";

describe("nav data", () => {
  it("lists every link once, with no clash of label or address", () => {
    const all = [NAV_HOME, ...NAV_GROUPS.flatMap((g) => g.items)];
    expect(new Set(all.map((i) => i.href)).size).toBe(all.length);
    expect(new Set(all.map((i) => i.label)).size).toBe(all.length);
    expect(all.length).toBe(29); // the old flat list had 29 links and one heading
    expect(NAV_GROUPS.every((g) => g.items.length > 0 && g.id && g.label)).toBe(true);
  });
});

describe("navMatches and activeNavItem", () => {
  it("matches the page and what is beneath it, but Overview only itself", () => {
    expect(navMatches("/app/guests/abc", { label: "Guests", href: "/app/guests" })).toBe(true);
    expect(navMatches("/app/guestsx", { label: "Guests", href: "/app/guests" })).toBe(false);
    expect(navMatches("/app/guests", NAV_HOME)).toBe(false);
    expect(navMatches("/app", NAV_HOME)).toBe(true);
  });
  it("picks the most specific link", () => {
    expect(activeNavItem("/app/payments/all")?.label).toBe("All payments");
    expect(activeNavItem("/app/payments")?.label).toBe("Payments to verify");
    expect(activeNavItem("/app/payments/abc")?.label).toBeUndefined();
    expect(activeNavItem("/app/reservations/123/documents")?.label).toBe("Reservations");
    expect(activeNavItem("/app")?.label).toBe("Overview");
    expect(activeNavItem("/elsewhere")).toBeNull();
  });
});

describe("groupIdForPath", () => {
  it("names the group that holds the page", () => {
    expect(groupIdForPath("/app/invoices/1")).toBe("money");
    expect(groupIdForPath("/app/housekeeping")).toBe("rooms");
    expect(groupIdForPath("/app/settings/hotel")).toBe("team");
    expect(groupIdForPath("/app/messages")).toBe("front");
    expect(groupIdForPath("/app")).toBeNull();
  });
});

describe("matchNav", () => {
  it("finds links by any word in any order, ignoring case", () => {
    expect(matchNav("hOuse").map((h) => h.label)).toEqual(["Housekeeping"]);
    expect(matchNav("payments all").map((h) => h.label)).toEqual(["All payments"]);
    expect(matchNav("spa laundry").map((h) => h.label)).toEqual(["Spa, gym & laundry"]);
  });
  it("counts the group name, and returns nothing for a blank or unmatched query", () => {
    expect(matchNav("money").length).toBe(8);
    expect(matchNav("   ")).toEqual([]);
    expect(matchNav("zzz")).toEqual([]);
    expect(matchNav("overview")[0]?.group).toBeNull();
  });
});

describe("groupBadgeTotal", () => {
  it("sums the badges of a group's links", () => {
    const front = NAV_GROUPS.find((g) => g.id === "front")!;
    expect(groupBadgeTotal(front, { "/app/notifications": 3, "/app/messages": 2, "/app/maintenance": 9 })).toBe(5);
    expect(groupBadgeTotal(front, {})).toBe(0);
  });
});
