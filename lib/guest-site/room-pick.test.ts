import { describe, expect, it } from "vitest";
import { addDaysIso, inStay, isClosed, pickNight, stayEstimate, stayHasFullNight, type Pick, type PriceNight } from "./room-pick";

const nights: PriceNight[] = [
  { date: "2026-11-12", rate_minor: 2500000 },
  { date: "2026-11-13", rate_minor: 2500000 },
  { date: "2026-11-14", rate_minor: null },
  { date: "2026-11-15", rate_minor: 3000000 },
  { date: "2026-11-16", rate_minor: 3000000 },
];
const none: Pick = { arrival: "", departure: "", awaitingEnd: false };

describe("addDaysIso / inStay", () => {
  it("adds days across a month and year end", () => {
    expect(addDaysIso("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("counts the arrival night and not the departure day", () => {
    expect(inStay("2026-11-12", "2026-11-12", "2026-11-14")).toBe(true);
    expect(inStay("2026-11-14", "2026-11-12", "2026-11-14")).toBe(false);
    expect(inStay("2026-11-12", "", "")).toBe(false);
  });
});

describe("pickNight", () => {
  it("first press picks one night; a later press sets the last night", () => {
    const one = pickNight(none, nights, "2026-11-12");
    expect(one).toEqual({ arrival: "2026-11-12", departure: "2026-11-13", awaitingEnd: true });
    expect(pickNight(one, nights, "2026-11-13")).toEqual({ arrival: "2026-11-12", departure: "2026-11-14", awaitingEnd: false });
  });
  it("an earlier night, or a range across a night with no rate, starts again", () => {
    const one = pickNight(none, nights, "2026-11-13");
    expect(pickNight(one, nights, "2026-11-12").arrival).toBe("2026-11-12");
    const start = pickNight(none, nights, "2026-11-13");
    expect(pickNight(start, nights, "2026-11-15")).toEqual({ arrival: "2026-11-15", departure: "2026-11-16", awaitingEnd: true });
  });
  it("ignores a night with no rate or off the calendar", () => {
    expect(pickNight(none, nights, "2026-11-14")).toBe(none);
    expect(pickNight(none, nights, "2027-01-01")).toBe(none);
  });
});

describe("stayEstimate", () => {
  it("adds the nights when the calendar covers them all", () => {
    expect(stayEstimate(nights, "2026-11-12", "2026-11-14")).toEqual({ nights: 2, totalMinor: 5000000 });
  });
  it("gives nothing for a night with no rate, a stay past the calendar, or backwards dates", () => {
    expect(stayEstimate(nights, "2026-11-13", "2026-11-15")).toBeNull();
    expect(stayEstimate(nights, "2026-11-16", "2026-11-18")).toBeNull();
    expect(stayEstimate(nights, "2026-11-14", "2026-11-12")).toBeNull();
    expect(stayEstimate(nights, "", "")).toBeNull();
  });
});

describe("full nights", () => {
  const withFull: PriceNight[] = [
    { date: "2026-11-12", rate_minor: 2500000, available: true },
    { date: "2026-11-13", rate_minor: 2500000, available: false },
    { date: "2026-11-14", rate_minor: 2500000, available: true },
    { date: "2026-11-15", rate_minor: 2500000 },
  ];
  it("a full night is closed; an unknown one is not", () => {
    expect(isClosed(withFull[1]!)).toBe(true);
    expect(isClosed(withFull[3]!)).toBe(false);
  });
  it("cannot be picked, and a range across one starts again", () => {
    expect(pickNight(none, withFull, "2026-11-13")).toBe(none);
    const start = pickNight(none, withFull, "2026-11-12");
    expect(pickNight(start, withFull, "2026-11-14")).toEqual({ arrival: "2026-11-14", departure: "2026-11-15", awaitingEnd: true });
  });
  it("is found in a typed stay, and then no estimate is given", () => {
    expect(stayHasFullNight(withFull, "2026-11-12", "2026-11-14")).toBe(true);
    expect(stayHasFullNight(withFull, "2026-11-14", "2026-11-16")).toBe(false);
    expect(stayEstimate(withFull, "2026-11-12", "2026-11-14")).toBeNull();
    expect(stayEstimate(withFull, "2026-11-14", "2026-11-16")).toEqual({ nights: 2, totalMinor: 5000000 });
  });
});
