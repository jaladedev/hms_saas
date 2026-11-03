import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addDays, CHANNELS, defaultRange, earnedMinor, isQuiet, MAX_REPORT_DAYS, parseRange, presets, taxMinor, type ReportDay } from "./reports";

const TODAY = "2026-11-03";
const day = (over: Partial<ReportDay> = {}): ReportDay => ({
  date: TODAY, online_minor: 0, cash_minor: 0, bank_transfer_minor: 0, pos_minor: 0, other_minor: 0, received_minor: 0, refunded_minor: 0, net_minor: 0,
  room_revenue_minor: 0, room_tax_minor: 0, extras_minor: 0, extras_tax_minor: 0, cancellation_charges_minor: 0, ...over,
});

describe("addDays", () => {
  it("moves across months, years and leap days", () => {
    expect(addDays("2026-11-03", -6)).toBe("2026-10-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-11-03", 0)).toBe("2026-11-03");
  });
});

describe("parseRange", () => {
  it("opens on the last 7 days when nothing is asked", () => {
    expect(parseRange({}, TODAY)).toEqual({ from: "2026-10-28", to: TODAY, fixed: false });
    expect(defaultRange(TODAY)).toEqual({ from: "2026-10-28", to: TODAY });
  });
  it("takes a good range as it is, one day included", () => {
    expect(parseRange({ from: "2026-10-01", to: "2026-10-31" }, TODAY)).toEqual({ from: "2026-10-01", to: "2026-10-31", fixed: false });
    expect(parseRange({ from: TODAY, to: TODAY }, TODAY)).toEqual({ from: TODAY, to: TODAY, fixed: false });
  });
  it("allows exactly 92 days and no more, as the database does", () => {
    expect(parseRange({ from: "2026-08-01", to: addDays("2026-08-01", MAX_REPORT_DAYS - 1) }, TODAY).fixed).toBe(false);
    expect(parseRange({ from: "2026-08-01", to: addDays("2026-08-01", MAX_REPORT_DAYS) }, TODAY).fixed).toBe(true);
  });
  it("falls back to the default, and says so, for anything unusable", () => {
    for (const s of [{ from: "2026-10-31", to: "2026-10-01" }, { from: "2026-02-30", to: TODAY }, { from: "x", to: "y" }, { from: TODAY }, { to: TODAY }, { from: ["a", "b"], to: TODAY }]) {
      expect(parseRange(s as never, TODAY), JSON.stringify(s)).toEqual({ from: "2026-10-28", to: TODAY, fixed: true });
    }
  });
  it("uses the same 92-day limit as migration 036", () => {
    const sql = readFileSync(new URL("../../supabase/migrations/20261026000036_daily_report.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/p_to - p_from > 91/);
    expect(MAX_REPORT_DAYS).toBe(92);
  });
});

describe("presets", () => {
  it("are all valid ranges ending today or yesterday", () => {
    for (const p of presets(TODAY)) expect(parseRange({ from: p.from, to: p.to }, TODAY).fixed, p.label).toBe(false);
    expect(presets(TODAY).find((p) => p.label === "This month")).toMatchObject({ from: "2026-11-01", to: TODAY });
    expect(presets(TODAY).find((p) => p.label === "Yesterday")).toMatchObject({ from: "2026-11-02", to: "2026-11-02" });
  });
});

describe("totals", () => {
  it("earned is before tax and includes extras and cancellation charges; tax is shown apart", () => {
    const d = day({ room_revenue_minor: 100, room_tax_minor: 7, extras_minor: 20, extras_tax_minor: 2, cancellation_charges_minor: 30 });
    expect(earnedMinor(d)).toBe(150);
    expect(taxMinor(d)).toBe(9);
  });
  it("calls a day quiet only when nothing at all happened", () => {
    expect(isQuiet(day())).toBe(true);
    for (const o of [{ received_minor: 1 }, { refunded_minor: 1 }, { room_revenue_minor: 1 }, { extras_tax_minor: 1 }, { cancellation_charges_minor: 1 }]) expect(isQuiet(day(o)), JSON.stringify(o)).toBe(false);
  });
  it("lists every way money arrives", () => {
    expect(CHANNELS.map((c) => c.key)).toEqual(["online_minor", "cash_minor", "bank_transfer_minor", "pos_minor", "other_minor"]);
  });
});
