import { describe, expect, it } from "vitest";
import { errorMessage, OK_MESSAGES } from "./refunds";
import {
  loyaltyError,
  parseAdjustForm,
  parseBookingLoyalty,
  parseLedger,
  parseRedeemForm,
  parseSettingsForm,
  parseSettingsRow,
  pointsText,
  pointsValueMinor,
} from "./loyalty";

const P = "11111111-1111-4111-8111-111111111111";
const R = "22222222-2222-4222-8222-222222222222";
const settings = { propertyId: P, enabled: "on", earnPer100: "2", pointValue: "1", minRedeem: "100" };

describe("parseSettingsForm", () => {
  it("reads the checkbox, the earn rate, a point's value in naira and the minimum", () => {
    expect(parseSettingsForm(settings)).toEqual({
      ok: true,
      value: { propertyId: P, enabled: true, earnPer100: 2, pointValueMinor: 100, minRedeem: 100 },
    });
    const r = parseSettingsForm({ ...settings, enabled: undefined, pointValue: "0.50" });
    expect(r).toEqual({ ok: true, value: { propertyId: P, enabled: false, earnPer100: 2, pointValueMinor: 50, minRedeem: 100 } });
  });

  it("refuses figures outside what the database accepts, so a typo is not guessed at", () => {
    for (const bad of [
      { earnPer100: "0" },
      { earnPer100: "51" },
      { earnPer100: "1.5" },
      { pointValue: "0.09" },
      { pointValue: "100.01" },
      { pointValue: "abc" },
      { minRedeem: "0" },
      { minRedeem: "10001" },
      { propertyId: "nope" },
    ]) {
      expect(parseSettingsForm({ ...settings, ...bad })).toEqual({ ok: false, code: "loyalty_invalid" });
    }
  });

  it("accepts the edges", () => {
    expect(parseSettingsForm({ ...settings, earnPer100: "1", pointValue: "0.10", minRedeem: "1" }).ok).toBe(true);
    expect(parseSettingsForm({ ...settings, earnPer100: "50", pointValue: "100", minRedeem: "10000" }).ok).toBe(true);
  });
});

describe("parseRedeemForm", () => {
  it("wants a booking id and a whole number of points from 1", () => {
    expect(parseRedeemForm({ reservationId: R, points: "250" })).toEqual({ ok: true, value: { reservationId: R, points: 250 } });
    for (const bad of [
      { points: "0" },
      { points: "-5" },
      { points: "2.5" },
      { points: "" },
      { points: "1000001" },
      { reservationId: "x" },
    ]) {
      expect(parseRedeemForm({ reservationId: R, points: "10", ...bad })).toEqual({ ok: false, code: "loyalty_invalid" });
    }
  });
});

describe("parseAdjustForm", () => {
  const base = { propertyId: P, email: "  ada@example.test ", points: "50", reason: " welcome gift ", direction: "add" };
  it("signs the points by direction and trims the e-mail and reason", () => {
    expect(parseAdjustForm(base)).toEqual({
      ok: true,
      value: { propertyId: P, email: "ada@example.test", points: 50, reason: "welcome gift" },
    });
    expect(parseAdjustForm({ ...base, direction: "remove" })).toEqual({
      ok: true,
      value: { propertyId: P, email: "ada@example.test", points: -50, reason: "welcome gift" },
    });
  });

  it("refuses zero, too many, a bad e-mail, and a missing or long reason", () => {
    for (const bad of [
      { points: "0" },
      { points: "100001" },
      { points: "-3" },
      { email: "nope" },
      { email: "" },
      { reason: "  " },
      { reason: "x".repeat(201) },
    ]) {
      expect(parseAdjustForm({ ...base, ...bad })).toEqual({ ok: false, code: "loyalty_invalid" });
    }
    expect(parseAdjustForm({ ...base, points: "100000" }).ok).toBe(true);
    expect(parseAdjustForm({ ...base, reason: "x".repeat(200) }).ok).toBe(true);
  });
});

describe("points text and value", () => {
  it("counts points with the right word and value in kobo", () => {
    expect(pointsText(1)).toBe("1 point");
    expect(pointsText(0)).toBe("0 points");
    expect(pointsText(1250)).toBe("1,250 points");
    expect(pointsValueMinor(200, 100)).toBe(20000);
    expect(pointsValueMinor(-5, 100)).toBe(0);
    expect(pointsValueMinor(2.9, 100)).toBe(200);
  });
});

describe("reading what the database returns", () => {
  it("reads settings and refuses anything incomplete", () => {
    expect(parseSettingsRow({ enabled: true, earn_per_100: 1, point_value_minor: 100, min_redeem: 100, flag_on: true })).toEqual({
      enabled: true,
      earn_per_100: 1,
      point_value_minor: 100,
      min_redeem: 100,
      flag_on: true,
    });
    expect(parseSettingsRow({ enabled: true })).toBeNull();
    expect(parseSettingsRow(null)).toBeNull();
    expect(parseSettingsRow("x")).toBeNull();
  });

  it("reads a booking's loyalty state, with 'off' for anything that is not clearly on", () => {
    expect(parseBookingLoyalty({ enabled: false })).toEqual({ enabled: false });
    expect(parseBookingLoyalty(null)).toEqual({ enabled: false });
    expect(parseBookingLoyalty({ enabled: "true" })).toEqual({ enabled: false });
    expect(
      parseBookingLoyalty({
        enabled: true,
        has_email: true,
        balance: 900,
        point_value_minor: 100,
        min_redeem: 100,
        redeemed_points: 200,
        redeemed_minor: 20000,
        earn_per_100: 1,
      }),
    ).toEqual({
      enabled: true,
      hasEmail: true,
      balance: 900,
      pointValueMinor: 100,
      minRedeem: 100,
      redeemedPoints: 200,
      redeemedMinor: 20000,
      earnPer100: 1,
    });
  });

  it("keeps only well-formed ledger rows", () => {
    const row = {
      id: "a",
      email: "a@b.c",
      kind: "earn",
      points: 10,
      reason: "Stay BK-1",
      created_at: "2026-11-20T10:00:00Z",
      booking_reference: "BK-1",
      balance: 10,
    };
    const rows = parseLedger([
      row,
      { ...row, id: "b", kind: "weird" },
      { ...row, id: "c", points: "10" },
      null,
      3,
      { ...row, id: "d", reason: null, booking_reference: null },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["a", "d"]);
    expect(rows[1]).toMatchObject({ reason: null, booking_reference: null });
    expect(parseLedger("nope")).toEqual([]);
  });
});

describe("loyaltyError", () => {
  it("turns each database refusal into its own code", () => {
    expect(loyaltyError("NOT_FOUND")).toBe("setup_forbidden");
    expect(loyaltyError("POLICY_VIOLATION: balance")).toBe("loyalty_balance");
    expect(loyaltyError("POLICY_VIOLATION: no email")).toBe("loyalty_no_email");
    expect(loyaltyError("INVALID_STATE: discount")).toBe("loyalty_discount");
    expect(loyaltyError("INVALID_STATE: money held")).toBe("loyalty_state");
    expect(loyaltyError("INVALID_STATE: cancelled")).toBe("loyalty_state");
    expect(loyaltyError("POLICY_VIOLATION: points")).toBe("loyalty_invalid");
    expect(loyaltyError("POLICY_VIOLATION: amount")).toBe("loyalty_invalid");
    expect(loyaltyError("something else")).toBeNull();
  });

  it("reads 'loyalty off' as the plan flag for settings and adjustments, and as this hotel's own switch for spending", () => {
    expect(loyaltyError("POLICY_VIOLATION: loyalty off", true)).toBe("loyalty_flag");
    expect(loyaltyError("POLICY_VIOLATION: loyalty off")).toBe("loyalty_off");
  });

  it("has a sentence for every code and every success", () => {
    const money = (m: number) => `₦${m}`;
    for (const c of [
      "loyalty_invalid",
      "loyalty_flag",
      "loyalty_off",
      "loyalty_balance",
      "loyalty_no_email",
      "loyalty_discount",
      "loyalty_state",
    ]) {
      const text = errorMessage(c, null, money);
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toBe(errorMessage("not_a_code", null, money));
    }
    for (const c of ["loyalty_saved", "loyalty_redeemed", "loyalty_released", "loyalty_adjusted"] as const) {
      expect(OK_MESSAGES[c].length).toBeGreaterThan(10);
    }
  });
});
