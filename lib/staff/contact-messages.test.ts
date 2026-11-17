import { describe, expect, it } from "vitest";
import { newCount, parseContactMessages, sortMessages } from "./contact-messages";

const row = (o: Record<string, unknown>) => ({
  id: "i",
  guest_name: "Ada",
  email: "a@b.co",
  message: "Hi there",
  status: "new",
  created_at: "2026-11-01T10:00:00Z",
  ...o,
});

describe("parseContactMessages", () => {
  it("keeps good rows and drops malformed ones", () => {
    const rows = parseContactMessages([
      row({ id: "1" }),
      { id: "2" },
      null,
      row({ id: "3", status: "handled", handled_at: "2026-11-02T10:00:00Z" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["1", "3"]);
    expect(rows[1]?.status).toBe("handled");
  });
  it("returns nothing for non-arrays", () => {
    expect(parseContactMessages(null)).toEqual([]);
    expect(parseContactMessages({})).toEqual([]);
  });
});

describe("sortMessages", () => {
  it("puts new first, oldest first, then handled newest first", () => {
    const rows = parseContactMessages([
      row({ id: "h-old", status: "handled", handled_at: "2026-11-02T00:00:00Z" }),
      row({ id: "n-new", created_at: "2026-11-05T00:00:00Z" }),
      row({ id: "h-new", status: "handled", handled_at: "2026-11-04T00:00:00Z" }),
      row({ id: "n-old", created_at: "2026-11-03T00:00:00Z" }),
    ]);
    expect(sortMessages(rows).map((r) => r.id)).toEqual(["n-old", "n-new", "h-new", "h-old"]);
    expect(newCount(rows)).toBe(2);
  });
});
