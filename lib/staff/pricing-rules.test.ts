import { describe, expect, it } from "vitest";
import {
  parseLimitsForm,
  parseLimitsList,
  parseRuleForm,
  parseRuleList,
  parseSignedPercent,
  parseSuggestions,
  percentText,
  ruleWhenText,
  suggestionSummary,
  weekdaysText,
} from "./pricing-rules";

const P = "00000000-0000-0000-0000-0000000000a2";
const T = "00000000-0000-0000-0000-0000000000a3";
const base = { propertyId: P, ruleId: "", roomTypeId: "", name: "  Weekend  ", percent: "10", active: "on" };

describe("parseSignedPercent", () => {
  it("reads signed percents with up to two decimals", () => {
    expect(parseSignedPercent("10")).toBe(10);
    expect(parseSignedPercent("-7.5")).toBe(-7.5);
    expect(parseSignedPercent("+5%")).toBe(5);
    expect(parseSignedPercent("5.555")).toBeNull();
    expect(parseSignedPercent("abc")).toBeNull();
    expect(parseSignedPercent("")).toBeNull();
  });
});

describe("parseRuleForm", () => {
  it("reads a weekday rule from the checkboxes and trims the name", () => {
    const r = parseRuleForm({ ...base, kind: "weekday", day5: "on", day6: "on" });
    expect(r).toEqual({
      ok: true,
      value: {
        propertyId: P,
        ruleId: null,
        roomTypeId: null,
        name: "Weekend",
        kind: "weekday",
        from: null,
        to: null,
        weekdays: [5, 6],
        dateFrom: null,
        dateTo: null,
        percent: 10,
        active: true,
      },
    });
  });
  it("reads occupancy and lead time bands and refuses reversed or out of range bands", () => {
    expect(parseRuleForm({ ...base, kind: "occupancy", from: "70", to: "100" }).ok).toBe(true);
    expect(parseRuleForm({ ...base, kind: "occupancy", from: "70", to: "101" }).ok).toBe(false);
    expect(parseRuleForm({ ...base, kind: "occupancy", from: "80", to: "70" }).ok).toBe(false);
    expect(parseRuleForm({ ...base, kind: "lead_time", from: "0", to: "365" }).ok).toBe(true);
    expect(parseRuleForm({ ...base, kind: "lead_time", from: "0", to: "366" }).ok).toBe(false);
    expect(parseRuleForm({ ...base, kind: "lead_time", from: "", to: "5" }).ok).toBe(false);
  });
  it("reads an event rule and refuses bad dates", () => {
    expect(parseRuleForm({ ...base, kind: "event", dateFrom: "2026-12-12", dateTo: "2027-01-04" }).ok).toBe(true);
    expect(parseRuleForm({ ...base, kind: "event", dateFrom: "2026-12-12", dateTo: "2026-12-11" }).ok).toBe(false);
    expect(parseRuleForm({ ...base, kind: "event", dateFrom: "2026-02-30", dateTo: "2026-03-01" }).ok).toBe(false);
    expect(parseRuleForm({ ...base, kind: "event" }).ok).toBe(false);
  });
  it("refuses a missing name, kind, weekday, zero or out of range percent and bad ids", () => {
    expect(parseRuleForm({ ...base, name: " ", kind: "weekday", day1: "on" }).ok).toBe(false);
    expect(parseRuleForm({ ...base, kind: "magic" }).ok).toBe(false);
    expect(parseRuleForm({ ...base, kind: "weekday" }).ok).toBe(false);
    expect(parseRuleForm({ ...base, kind: "weekday", day1: "on", percent: "0" }).ok).toBe(false);
    expect(parseRuleForm({ ...base, kind: "weekday", day1: "on", percent: "101" }).ok).toBe(false);
    expect(parseRuleForm({ ...base, kind: "weekday", day1: "on", percent: "-51" }).ok).toBe(false);
    expect(parseRuleForm({ ...base, kind: "weekday", day1: "on", propertyId: "nope" }).ok).toBe(false);
    expect(parseRuleForm({ ...base, kind: "weekday", day1: "on", roomTypeId: "nope" }).ok).toBe(false);
  });
  it("keeps a room type and an inactive switch", () => {
    const r = parseRuleForm({ ...base, kind: "weekday", day1: "on", roomTypeId: T, active: undefined });
    expect(r.ok && r.value.roomTypeId).toBe(T);
    expect(r.ok && r.value.active).toBe(false);
  });
});

describe("parseLimitsForm", () => {
  it("reads naira into minor units, either side optional", () => {
    expect(parseLimitsForm({ propertyId: P, roomTypeId: T, floor: "30000", ceiling: "60000.50" })).toEqual({
      ok: true,
      value: { propertyId: P, roomTypeId: T, floor: 3000000, ceiling: 6000050 },
    });
    expect(parseLimitsForm({ propertyId: P, roomTypeId: T, floor: "", ceiling: "60000" })).toEqual({
      ok: true,
      value: { propertyId: P, roomTypeId: T, floor: null, ceiling: 6000000 },
    });
    expect(parseLimitsForm({ propertyId: P, roomTypeId: T, floor: "", ceiling: "" })).toEqual({
      ok: true,
      value: { propertyId: P, roomTypeId: T, floor: null, ceiling: null },
    });
  });
  it("refuses a floor above the ceiling, zero, junk and bad ids", () => {
    expect(parseLimitsForm({ propertyId: P, roomTypeId: T, floor: "70000", ceiling: "60000" }).ok).toBe(false);
    expect(parseLimitsForm({ propertyId: P, roomTypeId: T, floor: "0", ceiling: "" }).ok).toBe(false);
    expect(parseLimitsForm({ propertyId: P, roomTypeId: T, floor: "abc", ceiling: "" }).ok).toBe(false);
    expect(parseLimitsForm({ propertyId: "x", roomTypeId: T, floor: "", ceiling: "" }).ok).toBe(false);
  });
});

describe("text helpers", () => {
  const date = (iso: string) => iso.slice(5);
  it("writes percents with a sign", () => {
    expect(percentText(10)).toBe("+10%");
    expect(percentText(-12.5)).toBe("-12.5%");
  });
  it("writes weekdays as names, with a range for a run", () => {
    expect(weekdaysText([5, 6])).toBe("Fri, Sat");
    expect(weekdaysText([1, 2, 3, 4, 5])).toBe("Mon to Fri");
    expect(weekdaysText([1, 2, 3, 4, 5, 6, 7])).toBe("every day");
    expect(weekdaysText([6, 5, 5])).toBe("Fri, Sat");
    expect(weekdaysText([])).toBe("no days");
  });
  it("describes when a rule applies", () => {
    expect(ruleWhenText({ kind: "occupancy", band_from: 70, band_to: 100, weekdays: [], date_from: null, date_to: null }, date)).toBe(
      "Occupancy 70 to 100%",
    );
    expect(ruleWhenText({ kind: "lead_time", band_from: 0, band_to: 3, weekdays: [], date_from: null, date_to: null }, date)).toBe(
      "0 to 3 days before arrival",
    );
    expect(
      ruleWhenText({ kind: "event", band_from: null, band_to: null, weekdays: [], date_from: "2026-12-12", date_to: "2026-12-12" }, date),
    ).toBe("12-12");
    expect(
      ruleWhenText({ kind: "event", band_from: null, band_to: null, weekdays: [], date_from: "2026-12-12", date_to: "2027-01-04" }, date),
    ).toBe("12-12 to 01-04");
  });
});

describe("reading database answers", () => {
  it("reads rules (numeric percent may arrive as text) and drops broken rows", () => {
    const rows = parseRuleList([
      {
        id: "r1",
        name: "Weekend",
        kind: "weekday",
        weekdays: [5, 6],
        adjust_percent: "10.00",
        is_active: true,
        room_type_id: null,
        room_type_name: null,
      },
      { id: "r2", name: "Broken", kind: "nope", adjust_percent: 5 },
      null,
      { id: "r3", name: "NoPct", kind: "weekday" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "r1", adjust_percent: 10, weekdays: [5, 6], is_active: true });
    expect(parseRuleList(null)).toEqual([]);
  });
  it("reads limits", () => {
    expect(
      parseLimitsList([
        { room_type_id: "a", room_type_name: "Std", base_rate_minor: 100, floor_minor: 50, ceiling_minor: null },
        { nope: 1 },
      ]),
    ).toEqual([{ room_type_id: "a", room_type_name: "Std", base_rate_minor: 100, floor_minor: 50, ceiling_minor: null }]);
  });
  it("reads suggestions and drops broken nights", () => {
    const t = parseSuggestions([
      {
        room_type_id: "a",
        room_type_name: "Std",
        nights: [
          {
            night: "2026-12-01",
            current_minor: 4500000,
            suggested_minor: 5180000,
            change_percent: "15.00",
            occupancy_percent: 62.5,
            lead_days: 14,
            rules: ["A", "B"],
            limited: null,
          },
          { night: "2026-12-02", current_minor: "x", suggested_minor: 1 },
          {
            night: "2026-12-03",
            current_minor: 4500000,
            suggested_minor: 4500000,
            change_percent: 0,
            occupancy_percent: null,
            lead_days: 16,
            rules: [],
            limited: "ceiling",
          },
        ],
      },
      { nope: 1 },
    ]);
    expect(t).toHaveLength(1);
    expect(t[0]?.nights).toHaveLength(2);
    expect(t[0]?.nights[0]).toMatchObject({ change_percent: 15, occupancy_percent: 62.5, rules: ["A", "B"] });
    expect(t[0]?.nights[1]?.limited).toBe("ceiling");
  });
  it("summarises how many nights change and the biggest moves", () => {
    const n = (cur: number, sug: number) => ({
      night: "d",
      current_minor: cur,
      suggested_minor: sug,
      change_percent: 0,
      occupancy_percent: null,
      lead_days: 0,
      rules: [],
      limited: null,
    });
    expect(suggestionSummary([n(1000, 1000), n(1000, 1150), n(1000, 900), n(1000, 1100)])).toEqual({ changed: 3, up: 15, down: -10 });
    expect(suggestionSummary([])).toEqual({ changed: 0, up: 0, down: 0 });
  });
});
