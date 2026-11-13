import { describe, expect, it } from "vitest";
import { errorMessage } from "./refunds";
import { expandDates, groupRanges, MAX_RANGE_NIGHTS, parseWeekdays, validateRateRange } from "./rates";

const P = "11111111-1111-4111-8111-111111111111";
const T = "22222222-2222-4222-8222-222222222222";
const base = { propertyId: P, roomTypeId: T, from: "2026-12-20", to: "2026-12-31", amount: "60,000" };
const code = (over: Record<string, unknown>, need = true) => {
  const r = validateRateRange({ ...base, ...over }, need);
  return r.ok ? "ok" : r.code;
};

describe("expandDates", () => {
  it("includes both ends and crosses month and year boundaries", () => {
    expect(expandDates("2026-12-30", "2027-01-02")).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
    expect(expandDates("2028-02-28", "2028-03-01")).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
    expect(expandDates("2026-12-20", "2026-12-20")).toEqual(["2026-12-20"]);
  });
  it("is empty for backwards or invalid ranges", () => {
    expect(expandDates("2026-12-21", "2026-12-20")).toEqual([]);
    expect(expandDates("2026-02-30", "2026-03-02")).toEqual([]);
  });
});

describe("validateRateRange", () => {
  it("accepts a range and prices it in kobo", () => {
    expect(validateRateRange(base, true)).toEqual({
      ok: true,
      value: { propertyId: P, roomTypeId: T, from: "2026-12-20", to: "2026-12-31", amountMinor: 6000000 },
    });
  });
  it("needs no price when clearing", () => {
    expect(validateRateRange({ ...base, amount: "" }, false)).toMatchObject({ ok: true, value: { amountMinor: null } });
  });
  it("refuses bad ids, dates, prices and over-long ranges", () => {
    expect(code({ propertyId: "x" })).toBe("bad_request");
    expect(code({ from: "nope" })).toBe("rate_range_invalid");
    expect(code({ to: "2026-12-19" })).toBe("rate_range_invalid");
    expect(code({ amount: "0" })).toBe("rate_range_invalid");
    expect(code({ amount: "" })).toBe("rate_range_invalid");
    expect(code({ from: "2026-01-01", to: "2027-01-01" })).toBe("ok"); // 366 nights, both ends counted: the limit
    expect(code({ from: "2026-01-01", to: "2027-01-02" })).toBe("rate_range_long"); // 367
    expect(code({ from: "2026-01-01", to: "2027-01-02" }, false)).toBe("rate_range_long");
    expect(MAX_RANGE_NIGHTS).toBe(366);
  });
});

describe("groupRanges", () => {
  const r = (d: string, a: number) => ({ business_date: d, amount_minor: a });
  it("merges consecutive nights at one price", () => {
    expect(groupRanges([r("2026-12-02", 100), r("2026-12-01", 100), r("2026-12-03", 100)])).toEqual([
      { from: "2026-12-01", to: "2026-12-03", amountMinor: 100, nights: 3 },
    ]);
  });
  it("splits on a price change or a gap, and handles month ends", () => {
    expect(groupRanges([r("2026-12-31", 100), r("2027-01-01", 100), r("2027-01-02", 120), r("2027-01-04", 120)])).toEqual([
      { from: "2026-12-31", to: "2027-01-01", amountMinor: 100, nights: 2 },
      { from: "2027-01-02", to: "2027-01-02", amountMinor: 120, nights: 1 },
      { from: "2027-01-04", to: "2027-01-04", amountMinor: 120, nights: 1 },
    ]);
    expect(groupRanges([])).toEqual([]);
  });
});

describe("wording", () => {
  it("has a sentence for every rate code", () => {
    for (const c of ["rate_range_invalid", "rate_range_long", "rate_days_none", "rate_forbidden", "rate_no_plan"])
      expect(errorMessage(c, null, String), c).not.toMatch(/Nothing was changed/);
  });
});

describe("weekday filter", () => {
  it("reads ticked days, treating none or all seven as every night", () => {
    expect(parseWeekdays([])).toBeNull();
    expect(parseWeekdays(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).toBeNull();
    expect((parseWeekdays(["fri", "sat"]) as number[]).slice().sort()).toEqual([5, 6]);
    expect(parseWeekdays(["sun", "sun"])).toEqual([0]);
  });

  it("refuses anything that is not a day key, instead of pricing more nights than meant", () => {
    expect(parseWeekdays(["fri", "friday"])).toBe("invalid");
    expect(parseWeekdays([5])).toBe("invalid");
    expect(parseWeekdays([null])).toBe("invalid");
  });

  it("keeps only the ticked days in a range, including across a month end", () => {
    // 2026-11-13 is a Friday
    expect(expandDates("2026-11-13", "2026-11-22", [5, 6])).toEqual(["2026-11-13", "2026-11-14", "2026-11-20", "2026-11-21"]);
    expect(expandDates("2026-11-27", "2026-12-06", [0])).toEqual(["2026-11-29", "2026-12-06"]);
  });

  it("gives every night with no filter, and nothing when no night matches", () => {
    expect(expandDates("2026-11-13", "2026-11-15", null)).toHaveLength(3);
    expect(expandDates("2026-11-13", "2026-11-15")).toHaveLength(3);
    expect(expandDates("2026-11-16", "2026-11-17", [5, 6])).toEqual([]);
  });

  it("stays bounded on a very long range", () => {
    expect(expandDates("2026-01-01", "2030-01-01", [5]).length).toBeLessThanOrEqual(MAX_RANGE_NIGHTS);
  });
});
