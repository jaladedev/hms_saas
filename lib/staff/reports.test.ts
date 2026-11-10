import { describe, expect, it } from "vitest";
import { dayOccupancy, parseRange, presets, toCsv, totals, type ReportDay } from "./reports";

const row = (o: Partial<ReportDay>): ReportDay => ({
  day: "2026-11-01",
  rooms_available: 10,
  rooms_sold: 5,
  room_revenue_minor: 5_000_000,
  room_tax_minor: 375_000,
  extras_minor: 200_000,
  extras_tax_minor: 15_000,
  cash_in_minor: 3_000_000,
  refunds_paid_minor: 500_000,
  ...o,
});

describe("parseRange", () => {
  it("defaults to the last 7 days ending today", () => {
    expect(parseRange(undefined, undefined, "2026-11-03")).toEqual({ from: "2026-10-28", to: "2026-11-03", trimmed: false });
    expect(parseRange("nope", "2026-11-03", "2026-11-03").from).toBe("2026-10-28");
    expect(parseRange("2026-02-30", "2026-03-01", "2026-11-03").to).toBe("2026-11-03");
  });
  it("keeps a good range and swaps a reversed one", () => {
    expect(parseRange("2026-11-01", "2026-11-03", "2026-11-03")).toEqual({ from: "2026-11-01", to: "2026-11-03", trimmed: false });
    expect(parseRange("2026-11-03", "2026-11-01", "2026-11-03")).toEqual({ from: "2026-11-01", to: "2026-11-03", trimmed: false });
  });
  it("cuts a long range to the most recent 92 days", () => {
    const r = parseRange("2026-01-01", "2026-11-03", "2026-11-03");
    expect(r.trimmed).toBe(true);
    expect(r.to).toBe("2026-11-03");
    expect((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 + 1).toBe(92);
  });
  it("ignores values that are not text, such as a repeated query parameter", () => {
    expect(parseRange(["2026-11-01", "2026-11-02"], "2026-11-03", "2026-11-03").from).toBe("2026-10-28");
  });
});

describe("totals", () => {
  it("adds earned and cash separately", () => {
    const t = totals([
      row({}),
      row({
        day: "2026-11-02",
        rooms_sold: 0,
        room_revenue_minor: 0,
        room_tax_minor: 0,
        extras_minor: 0,
        extras_tax_minor: 0,
        cash_in_minor: 0,
        refunds_paid_minor: 100_000,
      }),
    ]);
    expect(t.roomNights).toBe(5);
    expect(t.occupancyPercent).toBe(25);
    expect(t.earned).toBe(5_200_000);
    expect(t.cashNet).toBe(3_000_000 - 600_000);
    expect(t.averageRate).toBe(1_000_000);
  });
  it("has no occupancy or average rate when there is nothing to divide by", () => {
    expect(totals([])).toMatchObject({ days: 0, occupancyPercent: null, averageRate: null, earned: 0 });
    expect(totals([row({ rooms_available: 0, rooms_sold: 0, room_revenue_minor: 0 })]).occupancyPercent).toBeNull();
  });
  it("rounds occupancy to one decimal", () => {
    expect(dayOccupancy({ rooms_sold: 1, rooms_available: 3 })).toBe(33.3);
    expect(dayOccupancy({ rooms_sold: 0, rooms_available: 0 })).toBeNull();
  });
});

describe("toCsv", () => {
  it("writes a header, one line a day and naira with two decimals", () => {
    const csv = toCsv([row({})]);
    expect(csv.split("\n")[0]).toBe(
      "Date,Rooms available,Rooms sold,Occupancy %,Room revenue,Room tax,Extras,Extras tax,Cash received,Refunds paid",
    );
    expect(csv.split("\n")[1]).toBe("2026-11-01,10,5,50,50000.00,3750.00,2000.00,150.00,30000.00,5000.00");
    expect(csv.endsWith("\n")).toBe(true);
  });
});

describe("presets", () => {
  it("gives quick ranges that end today, across a month and year boundary", () => {
    const p = Object.fromEntries(presets("2027-01-03").map((x) => [x.label, x]));
    expect(p["Today"]).toMatchObject({ from: "2027-01-03", to: "2027-01-03" });
    expect(p["Yesterday"]).toMatchObject({ from: "2027-01-02", to: "2027-01-02" });
    expect(p["Last 7 days"]).toMatchObject({ from: "2026-12-28", to: "2027-01-03" });
    expect(p["Last 30 days"]).toMatchObject({ from: "2026-12-05", to: "2027-01-03" });
    expect(p["This month"]).toMatchObject({ from: "2027-01-01", to: "2027-01-03" });
  });
  it("never asks for more than the report allows", () => {
    for (const x of presets("2026-11-03"))
      expect(parseRange(x.from, x.to, "2026-11-03")).toMatchObject({ from: x.from, to: x.to, trimmed: false });
  });
});
