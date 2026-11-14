import { describe, expect, it } from "vitest";
import { freeCount, freeLabel, parseWaitlist, sortWaitlist } from "./waitlist";

const row = (o: Record<string, unknown> = {}) => ({
  id: "1",
  room_type: "Solo Suite",
  arrival_date: "2027-03-01",
  departure_date: "2027-03-03",
  adults: 2,
  children: 0,
  guest_name: "Ada",
  email: "a@b.co",
  phone: null,
  status: "waiting",
  created_at: "2026-11-01T10:00:00Z",
  rooms_free_now: 0,
  ...o,
});

describe("parseWaitlist", () => {
  it("reads rows and drops malformed ones", () => {
    const rows = parseWaitlist([row(), { id: "x" }, null, row({ id: "2", status: "contacted", phone: "0800", rooms_free_now: 2 })]);
    expect(rows.map((r) => r.id)).toEqual(["1", "2"]);
    expect(rows[1]).toMatchObject({ status: "contacted", phone: "0800", rooms_free_now: 2, notified_at: null });
    expect(parseWaitlist([row({ notified_at: "2026-11-14T08:00:00Z" })])[0]?.notified_at).toBe("2026-11-14T08:00:00Z");
  });
  it("returns nothing for non-lists", () => {
    expect(parseWaitlist(null)).toEqual([]);
    expect(parseWaitlist({})).toEqual([]);
  });
});

describe("ordering and labels", () => {
  it("puts freed rooms first, then soonest arrival", () => {
    const rows = parseWaitlist([
      row({ id: "a", arrival_date: "2027-01-01" }),
      row({ id: "b", arrival_date: "2027-05-01", rooms_free_now: 1 }),
      row({ id: "c", arrival_date: "2027-02-01" }),
    ]);
    expect(sortWaitlist(rows).map((r) => r.id)).toEqual(["b", "a", "c"]);
  });
  it("labels and counts", () => {
    expect(freeLabel({ rooms_free_now: 0 })).toBe("Still sold out");
    expect(freeLabel({ rooms_free_now: 2 })).toBe("2 free now");
    const rows = parseWaitlist([row({ rooms_free_now: 1 }), row({ id: "2", rooms_free_now: 1, status: "contacted" })]);
    expect(freeCount(rows)).toBe(1);
  });
});
