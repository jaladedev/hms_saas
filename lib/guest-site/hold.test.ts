import { describe, expect, it } from "vitest";
import { announcement, formatCountdown, isUrgent, remainingAfter, secondsRemaining, WARN_BELOW_SECONDS } from "./hold";

const NOW = Date.parse("2026-11-02T12:00:00Z");

describe("secondsRemaining", () => {
  it("rounds up to whole seconds, so a hold with a fraction left still counts", () => {
    expect(secondsRemaining("2026-11-02T12:20:00Z", NOW)).toBe(1200);
    expect(secondsRemaining("2026-11-02T12:00:00.100Z", NOW)).toBe(1);
  });
  it("is zero when the hold has ended, is missing or cannot be read", () => {
    expect(secondsRemaining("2026-11-02T12:00:00Z", NOW)).toBe(0);
    expect(secondsRemaining("2026-11-02T11:59:00Z", NOW)).toBe(0);
    expect(secondsRemaining(null, NOW)).toBe(0);
    expect(secondsRemaining("not a date", NOW)).toBe(0);
    expect(secondsRemaining("2026-11-02T12:20:00Z", Number.NaN)).toBe(0);
  });
});

describe("remainingAfter", () => {
  it("counts down from the number the server gave, using only the time elapsed since", () => {
    expect(remainingAfter(600, 0)).toBe(600);
    expect(remainingAfter(600, 1000)).toBe(599);
    expect(remainingAfter(600, 1500)).toBe(599);
    expect(remainingAfter(600, 599_001)).toBe(1);
    expect(remainingAfter(600, 600_000)).toBe(0);
  });
  it("never goes below zero and ignores a clock that moved backwards or a value that is not a number", () => {
    expect(remainingAfter(5, 60_000)).toBe(0);
    expect(remainingAfter(600, -5000)).toBe(600);
    expect(remainingAfter(Number.NaN, 1000)).toBe(0);
    expect(remainingAfter(600, Number.NaN)).toBe(600);
    expect(remainingAfter(-3, 0)).toBe(0);
  });
});

describe("formatCountdown", () => {
  it("shows minutes and two-digit seconds", () => {
    expect(formatCountdown(1200)).toBe("20:00");
    expect(formatCountdown(754)).toBe("12:34");
    expect(formatCountdown(61)).toBe("1:01");
    expect(formatCountdown(9)).toBe("0:09");
    expect(formatCountdown(0)).toBe("0:00");
  });
  it("copes with nonsense", () => {
    expect(formatCountdown(-4)).toBe("0:00");
    expect(formatCountdown(Number.NaN)).toBe("0:00");
    expect(formatCountdown(59.9)).toBe("0:59");
  });
});

describe("isUrgent and announcement", () => {
  it("warns in the last two minutes and not once it has ended", () => {
    expect(isUrgent(WARN_BELOW_SECONDS + 1)).toBe(false);
    expect(isUrgent(WARN_BELOW_SECONDS)).toBe(true);
    expect(isUrgent(1)).toBe(true);
    expect(isUrgent(0)).toBe(false);
  });
  it("speaks up once at two minutes and once at the end, and is quiet in between", () => {
    expect(announcement(WARN_BELOW_SECONDS)).toBe("Your room hold ends in 2 minutes.");
    expect(announcement(0)).toBe("Your room hold has ended.");
    for (const s of [600, 121, 119, 60, 1]) expect(announcement(s)).toBeNull();
  });
});
