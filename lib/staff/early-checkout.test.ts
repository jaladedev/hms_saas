import { describe, expect, it } from "vitest";
import { earlyCheckoutNote, parseEarlyQuote, type EarlyQuote } from "./early-checkout";

const money = (m: number) => `N${m / 100}`;
const q = (over: Partial<EarlyQuote> = {}): EarlyQuote => ({ early: true, mode: "credit", nights_credited: 3, credit_minor: 30000, new_total_minor: 10000, surplus_minor: 0, ...over });

describe("parseEarlyQuote", () => {
  it("reads a good answer and defends against a bad one", () => {
    expect(parseEarlyQuote({ early: true, mode: "one_night", nights_credited: 2, credit_minor: 500, new_total_minor: 100, surplus_minor: 50 }))
      .toEqual({ early: true, mode: "one_night", nights_credited: 2, credit_minor: 500, new_total_minor: 100, surplus_minor: 50 });
    expect(parseEarlyQuote({ early: true, mode: "bogus", credit_minor: -5 })).toMatchObject({ mode: "none", credit_minor: 0, new_total_minor: null });
    expect(parseEarlyQuote(null)).toBeNull();
    expect(parseEarlyQuote("x")).toBeNull();
  });
});

describe("earlyCheckoutNote", () => {
  it("says nothing when the guest is not leaving early", () => {
    expect(earlyCheckoutNote(q({ early: false }), "5 Nov", money)).toBeNull();
  });
  it("says the price does not change when the policy keeps it", () => {
    expect(earlyCheckoutNote(q({ mode: "none", nights_credited: 0, credit_minor: 0 }), "5 Nov", money)).toMatch(/price does not change/);
  });
  it("states the credit and the new total", () => {
    expect(earlyCheckoutNote(q(), "5 Nov", money)).toBe("Leaving before 5 Nov: 3 nights not stayed will be taken off, N300 in all. The booking total becomes N100.");
    expect(earlyCheckoutNote(q({ nights_credited: 1 }), "5 Nov", money)).toMatch(/1 night not stayed/);
  });
  it("warns when a refund will be flagged", () => {
    expect(earlyCheckoutNote(q({ surplus_minor: 20000 }), "5 Nov", money)).toMatch(/paid N200 more than that, which will be flagged for a refund/);
  });
});
