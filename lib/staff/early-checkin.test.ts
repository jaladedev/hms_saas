import { describe, expect, it } from "vitest";
import { earlyCheckinNote, earlyCheckinWhyNot, parseEarlyCheckinQuote, type EarlyCheckinQuote } from "./early-checkin";

const money = (m: number) => `N${m / 100}`;
const q = (over: Partial<EarlyCheckinQuote> = {}): EarlyCheckinQuote => ({
  allowed: true,
  why_not: null,
  days_early: 2,
  max_days: 3,
  nights_added: 2,
  added_minor: 30000,
  new_total_minor: 90000,
  ...over,
});

describe("parseEarlyCheckinQuote", () => {
  it("reads a good answer", () => {
    expect(
      parseEarlyCheckinQuote({
        allowed: true,
        why_not: null,
        days_early: 2,
        max_days: 3,
        nights_added: 2,
        added_minor: 5,
        new_total_minor: 9,
      }),
    ).toEqual({ allowed: true, why_not: null, days_early: 2, max_days: 3, nights_added: 2, added_minor: 5, new_total_minor: 9 });
  });
  it("never allows without a clean yes, and treats an unknown reason as a status problem", () => {
    expect(parseEarlyCheckinQuote({ allowed: true, why_not: "off" })?.allowed).toBe(false);
    expect(parseEarlyCheckinQuote({ allowed: false, why_not: "weird" })?.why_not).toBe("status");
    expect(parseEarlyCheckinQuote({ allowed: "yes" })?.allowed).toBe(false);
    expect(parseEarlyCheckinQuote(null)).toBeNull();
  });
});

describe("notes", () => {
  it("states the extra nights and the new total", () => {
    expect(earlyCheckinNote(q(), money)).toBe(
      "The booking starts in 2 days. Checking in now adds 2 nights to it, N300 in all. The booking total becomes N900.",
    );
    expect(earlyCheckinNote(q({ days_early: 1, nights_added: 1 }), money)).toMatch(/starts tomorrow\. Checking in now adds 1 night to it/);
  });
  it("explains only the refusals worth explaining", () => {
    expect(earlyCheckinWhyNot(q({ allowed: false, why_not: "too_early", days_early: 5, max_days: 3 }))).toMatch(
      /up to 3 days before arrival.*5 days away/,
    );
    expect(earlyCheckinWhyNot(q({ allowed: false, why_not: "payment_started" }))).toMatch(/payment in progress/);
    expect(earlyCheckinWhyNot(q({ allowed: false, why_not: "no_rate" }))).toMatch(/no price/);
    expect(earlyCheckinWhyNot(q({ allowed: false, why_not: "off" }))).toBeNull();
    expect(earlyCheckinWhyNot(q({ allowed: false, why_not: "not_early" }))).toBeNull();
  });
});
