import { describe, expect, it } from "vitest";
import { badgeText, groupByDay, parseCategory, parseInbox, safeLink, type NotificationItem } from "./notifications";

const item = (over: Partial<NotificationItem> = {}): NotificationItem => ({
  id: "n1",
  property_id: "p1",
  property_name: "Hotel",
  kind: "email_failed",
  category: "booking",
  severity: "attention",
  title: "t",
  body: null,
  link: "/app/emails",
  created_at: "2026-11-01T10:00:00Z",
  read: false,
  ...over,
});

describe("parseCategory", () => {
  it("accepts only the four categories", () => {
    expect(parseCategory("money")).toBe("money");
    expect(parseCategory(["booking", "money"])).toBe("booking");
    expect(parseCategory("everything")).toBeNull();
    expect(parseCategory(undefined)).toBeNull();
  });
});

describe("parseInbox", () => {
  it("drops malformed rows and clamps counts", () => {
    const r = parseInbox({
      items: [item(), { id: 5 }, null, item({ category: "x" as never })],
      unread: { total: 3, money: -1, booking: "2" },
    });
    expect(r.items).toHaveLength(1);
    expect(r.unread).toEqual({ total: 3, money: 0, maintenance: 0, booking: 0, housekeeping: 0 });
  });
  it("survives nothing at all", () => {
    expect(parseInbox(null)).toEqual({ items: [], unread: { total: 0, money: 0, maintenance: 0, booking: 0, housekeeping: 0 } });
  });
});

describe("safeLink and badgeText", () => {
  it("follows only in-app paths", () => {
    expect(safeLink("/app/refunds")).toBe("/app/refunds");
    expect(safeLink("https://evil.example")).toBeNull();
    expect(safeLink("//evil.example")).toBeNull();
    expect(safeLink("/app/../x")).toBeNull();
    expect(safeLink(null)).toBeNull();
  });
  it("caps the badge", () => {
    expect(badgeText(7)).toBe("7");
    expect(badgeText(100)).toBe("99+");
  });
});

describe("groupByDay", () => {
  it("groups by the hotel's local day in order", () => {
    const g = groupByDay(
      [
        item({ id: "a", created_at: "2026-11-01T23:30:00Z" }),
        item({ id: "b", created_at: "2026-11-01T23:10:00Z" }),
        item({ id: "c", created_at: "2026-11-01T10:00:00Z" }),
      ],
      "Africa/Lagos",
    );
    expect(g.map((x) => x.items.map((i) => i.id))).toEqual([["a", "b"], ["c"]]);
    expect(g[0]?.day).toMatch(/Monday 2 November/);
  });
  it("falls back to UTC for a bad zone", () => {
    expect(groupByDay([item()], "Nope/Zone")[0]?.day).toMatch(/Sunday 1 November/);
  });
});
