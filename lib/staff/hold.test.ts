import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { holdView, requiredToConfirm } from "./hold";

describe("requiredToConfirm", () => {
  it("is the whole total unless the policy asks for a deposit", () => {
    expect(requiredToConfirm(1000000, null)).toBe(1000000);
    expect(requiredToConfirm(1000000, {})).toBe(1000000);
    expect(requiredToConfirm(1000000, { online_payment: { mode: "full" } })).toBe(1000000);
  });
  it("rounds a deposit up to the kobo and never passes the total", () => {
    expect(requiredToConfirm(1000000, { online_payment: { mode: "deposit_percent", value: 30 } })).toBe(300000);
    expect(requiredToConfirm(1001, { online_payment: { mode: "deposit_percent", value: 30 } })).toBe(301); // 300.3 -> 301
    expect(requiredToConfirm(1000, { online_payment: { mode: "deposit_percent", value: 150 } })).toBe(1000);
    expect(requiredToConfirm(1000, { online_payment: { mode: "deposit_percent", value: "25" } })).toBe(250);
  });
  it("falls back to the total for a nonsense percentage", () => {
    for (const value of [0, -5, "abc"])
      expect(requiredToConfirm(5000, { online_payment: { mode: "deposit_percent", value } }), String(value)).toBe(5000);
  });
  it("does the same arithmetic as migration 034", () => {
    const sql = readFileSync(new URL("../../supabase/migrations/20261026000034_staff_holds.sql", import.meta.url), "utf8");
    expect(sql).toMatch(
      /ceil\(r\.total_minor \* coalesce\(\(r\.policy_snapshot -> 'online_payment' ->> 'value'\)::numeric, 100\) \/ 100\)/,
    );
  });
});

describe("holdView", () => {
  const now = new Date("2026-11-03T10:00:00Z");
  it("shows nothing for a booking that is not pending", () => {
    for (const s of ["confirmed", "cancelled", "expired", "checked_in"])
      expect(holdView(s, "2026-11-03T10:20:00Z", now, 1000, null, 0), s).toEqual({ kind: "none" });
  });
  it("shows the time left and what is still needed while the hold lasts", () => {
    expect(holdView("pending", "2026-11-03T10:20:00Z", now, 1000, null, 0)).toEqual({
      kind: "live",
      until: "2026-11-03T10:20:00Z",
      stillNeededMinor: 1000,
    });
    expect(
      holdView("pending", "2026-11-03T10:20:00Z", now, 1000, { online_payment: { mode: "deposit_percent", value: 30 } }, 100),
    ).toMatchObject({ stillNeededMinor: 200 });
    expect(holdView("pending", "2026-11-03T10:20:00Z", now, 1000, null, null)).toMatchObject({ stillNeededMinor: 1000 });
  });
  it("calls a hold lapsed when it has run out or has no hold left", () => {
    expect(holdView("pending", "2026-11-03T10:00:00Z", now, 1000, null, 0)).toEqual({ kind: "lapsed", stillNeededMinor: 1000 });
    expect(holdView("pending", null, now, 1000, null, 0).kind).toBe("lapsed");
    expect(holdView("pending", "garbage", now, 1000, null, 0).kind).toBe("lapsed");
  });
});
