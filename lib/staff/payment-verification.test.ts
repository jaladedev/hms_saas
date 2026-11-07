import { describe, expect, it } from "vitest";
import { daysWaiting, methodLabel, parseQueue, parseVerificationView, waitingText } from "./payment-verification";

describe("payment verification helpers", () => {
  it("picks the view, defaulting to the queue", () => {
    expect(parseVerificationView("verified")).toBe("verified");
    expect(parseVerificationView(["verified", "x"])).toBe("verified");
    expect(parseVerificationView("anything")).toBe("unverified");
    expect(parseVerificationView(undefined)).toBe("unverified");
  });
  it("drops malformed rows and clamps the count", () => {
    const row = { id: "p1", reservation_id: "r1", amount_minor: 100 };
    expect(parseQueue({ items: [row, { id: 1 }, null, { ...row, amount_minor: "5" }], unverified: 3 })).toEqual({ items: [row], unverified: 3 });
    expect(parseQueue({ items: "no", unverified: -2 })).toEqual({ items: [], unverified: 0 });
    expect(parseQueue(null)).toEqual({ items: [], unverified: 0 });
  });
  it("counts whole days waiting and words them", () => {
    const now = new Date("2026-11-10T12:00:00Z");
    expect(daysWaiting("2026-11-10T08:00:00Z", now)).toBe(0);
    expect(daysWaiting("2026-11-08T11:00:00Z", now)).toBe(2);
    expect(daysWaiting("2026-11-12T00:00:00Z", now)).toBe(0);
    expect(daysWaiting("garbage", now)).toBe(0);
    expect([0, 1, 4].map(waitingText)).toEqual(["recorded today", "waiting 1 day", "waiting 4 days"]);
  });
  it("labels methods and passes unknown ones through", () => {
    expect(methodLabel("bank_transfer")).toBe("Bank transfer");
    expect(methodLabel("crypto")).toBe("crypto");
  });
});
