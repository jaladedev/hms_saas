import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cancelSummary, notAllowedText, parseExpectedCharge } from "./cancel";
import { friendlyError, messageForCode } from "./errors";
import type { CancelPreview } from "./server";

const fmt = (m: number, c: string) => `${c} ${m / 100}`;
const base: CancelPreview = {
  allowed: true,
  why_not: null,
  currency: "NGN",
  charge_minor: 0,
  held_minor: 0,
  refund_minor: 0,
  still_owed_minor: 0,
  hours_before_arrival: 100,
};

describe("cancelSummary", () => {
  it("says a cancel is free and, when paid, that everything comes back", () => {
    const s = cancelSummary({ ...base, held_minor: 500000, refund_minor: 500000 }, fmt);
    expect(s.headline).toBe("You can cancel for free.");
    expect(s.lines.join(" ")).toMatch(/NGN 5000 will be refunded/);
    expect(s.lines.at(-1)).toMatch(/cannot be undone/);
  });
  it("states the charge and the refund of what is left", () => {
    const s = cancelSummary({ ...base, charge_minor: 150000, held_minor: 500000, refund_minor: 350000 }, fmt);
    expect(s.headline).toBe("Cancelling now costs NGN 1500.");
    expect(s.lines.join(" ")).toMatch(/NGN 3500 will be refunded/);
  });
  it("says what is still owed when the charge is more than was paid", () => {
    const s = cancelSummary({ ...base, charge_minor: 250000, held_minor: 100000, still_owed_minor: 150000 }, fmt);
    expect(s.lines.join(" ")).toMatch(/NGN 1500 would still be owed/);
  });
  it("says nothing is refunded when the payment only covers the charge, and says nothing about money when none moves", () => {
    expect(cancelSummary({ ...base, charge_minor: 100000, held_minor: 100000 }, fmt).lines.join(" ")).toMatch(/nothing is refunded/);
    expect(cancelSummary(base, fmt).lines.join(" ")).not.toMatch(/refund|owed/);
  });
});

describe("notAllowedText", () => {
  it("has a sentence for each reason and a safe default", () => {
    for (const w of ["status", "started", "too_late", "disabled", null] as const) expect(notAllowedText(w)).toMatch(/hotel|release/);
    expect(notAllowedText("too_late")).toMatch(/check-in time/);
  });
});

describe("parseExpectedCharge", () => {
  it("accepts whole kobo and nothing else", () => {
    expect(parseExpectedCharge("0")).toBe(0);
    expect(parseExpectedCharge("150000")).toBe(150000);
    for (const v of ["", "-1", "1.5", "1e3", " 5", "abc", undefined, 5, "9999999999999"])
      expect(parseExpectedCharge(v), String(v)).toBeNull();
  });
});

describe("guest error wording", () => {
  it("maps what migration 035 can raise to a sentence the guest can act on", () => {
    expect(friendlyError("POLICY_VIOLATION: charge changed").code).toBe("charge_changed");
    expect(friendlyError("INVALID_STATE: too late").code).toBe("cancel_too_late");
    for (const s of ["cancelled", "checked_in", "checked_out", "no_show"])
      expect(friendlyError(`INVALID_STATE: ${s}`).code, s).toBe("cancel_not_allowed");
    expect(friendlyError("INVALID_STATE: disabled").code).toBe("cancel_disabled");
    for (const c of ["charge_changed", "cancel_too_late", "cancel_not_allowed", "cancel_disabled"])
      expect(messageForCode(c), c).toBeTruthy();
  });
  it("only uses texts the migration really raises", () => {
    const sql = readFileSync(new URL("../../supabase/migrations/20261026000035_guest_cancel.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/POLICY_VIOLATION: charge changed/);
    expect(sql).toMatch(/INVALID_STATE: too late/);
  });
});

describe("notAllowedText says what is true about the booking's state", () => {
  it("a cancelled booking is already cancelled, not a hold that will release itself", () => {
    expect(notAllowedText("status", "cancelled")).toBe("This booking is already cancelled.");
  });
  it("an expired hold has nothing to cancel", () => {
    expect(notAllowedText("status", "expired")).toContain("nothing to cancel");
  });
  it("an unpaid hold, or a caller that does not know the status, keeps the hold wording", () => {
    for (const status of ["pending", undefined]) expect(notAllowedText("status", status)).toContain("release itself");
  });
  it("the status changes only the status reason", () => {
    expect(notAllowedText("too_late", "cancelled")).toBe(notAllowedText("too_late"));
    expect(notAllowedText("disabled", "cancelled")).toBe(notAllowedText("disabled"));
  });
});
