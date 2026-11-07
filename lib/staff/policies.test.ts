import { describe, expect, it } from "vitest";
import {
  checkEffectiveDate, classifyPolicyError, describeCharge, describeWindow, guestSummary, mergeConfig, readConfig, validatePolicy, versionsOn,
} from "./policies";

const P = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const naira = (minor: number) => `₦${(minor / 100).toFixed(2)}`;
const base = { propertyId: P, effectiveFrom: "2026-11-09", onlineMode: "deposit_percent", depositPercent: "30", checkinPayment: "none" };

describe("readConfig", () => {
  it("reads the shape cancel_reservation and create_payment_attempt use, widest window first", () => {
    const cfg = readConfig({
      cancellation_rules: [{ within_hours: 0, charge: { type: "percent", value: 100 } }, { within_hours: 48, charge: { type: "nights", value: 1 } }],
      online_payment: { mode: "deposit_percent", value: 30 }, checkin_payment: "full",
    });
    expect(cfg.cancellation_rules.map((r) => r.within_hours)).toEqual([48, 0]);
    expect(cfg.online_payment).toEqual({ mode: "deposit_percent", value: 30 });
    expect(cfg.checkin_payment).toBe("full");
  });
  it("falls back to what the database falls back to: full payment, no check-in requirement, no rules", () => {
    expect(readConfig({})).toEqual({ cancellation_rules: [], online_payment: { mode: "full" }, checkin_payment: "none", guest_cancellation: "on", early_checkout: "none" });
    expect(readConfig(null).online_payment).toEqual({ mode: "full" });
    expect(readConfig({ online_payment: { mode: "deposit_percent", value: 0 } }).online_payment).toEqual({ mode: "full" });
  });
  it("drops rules it cannot use instead of guessing", () => {
    const cfg = readConfig({ cancellation_rules: [{ within_hours: -1, charge: { type: "percent", value: 10 } }, { within_hours: 5, charge: { type: "weird", value: 1 } }, "x", { within_hours: 5 }] });
    expect(cfg.cancellation_rules).toEqual([]);
  });
});

describe("guest cancellation setting", () => {
  const form = { propertyId: "6f1c1c1e-2b7a-4a55-9a43-1d2a8d9a1f10", effectiveFrom: "2026-12-01", onlineMode: "full", depositPercent: "30", checkinPayment: "none" };
  it("reads on unless the policy says off", () => {
    expect(readConfig({}).guest_cancellation).toBe("on");
    expect(readConfig({ guest_cancellation: "off" }).guest_cancellation).toBe("off");
    for (const v of ["OFF", "no", false, 0, null]) expect(readConfig({ guest_cancellation: v }).guest_cancellation, String(v)).toBe("on");
  });
  it("takes on or off from the form, treats a missing field as on and refuses anything else", () => {
    expect(validatePolicy({ ...form, guestCancellation: "off" })).toMatchObject({ ok: true, value: { config: { guest_cancellation: "off" } } });
    expect(validatePolicy({ ...form, guestCancellation: "on" })).toMatchObject({ ok: true, value: { config: { guest_cancellation: "on" } } });
    expect(validatePolicy(form)).toMatchObject({ ok: true, value: { config: { guest_cancellation: "on" } } });
    expect(validatePolicy({ ...form, guestCancellation: "maybe" })).toEqual({ ok: false, code: "policy_invalid", field: "rules" });
  });
  it("replaces the old value when a new version is saved, and tells guests to contact the hotel when it is off", () => {
    expect(mergeConfig({ guest_cancellation: "off", check_in_time: "14:00" }, readConfig({}))).toMatchObject({ guest_cancellation: "on", check_in_time: "14:00" });
    const lines = guestSummary(readConfig({ guest_cancellation: "off" }), (m) => String(m));
    expect(lines.at(-1)).toMatch(/contact the hotel/);
    expect(guestSummary(readConfig({}), (m) => String(m)).join(" ")).not.toMatch(/contact the hotel/);
  });
});

describe("validatePolicy", () => {
  it("builds the config from the form and stores a fixed amount in kobo", () => {
    const v = validatePolicy({ ...base, rule_hours_0: "0", rule_type_0: "percent", rule_value_0: "100", rule_hours_1: "168", rule_type_1: "fixed", rule_value_1: "₦5,000" });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.config.cancellation_rules).toEqual([
      { within_hours: 168, charge: { type: "fixed", value: 500000 } },
      { within_hours: 0, charge: { type: "percent", value: 100 } },
    ]);
    expect(v.value.config.online_payment).toEqual({ mode: "deposit_percent", value: 30 });
  });
  it("skips empty rows and allows no rules at all (free cancellation)", () => {
    const v = validatePolicy({ ...base, onlineMode: "full", rule_hours_0: "", rule_value_0: "", rule_type_0: "percent" });
    expect(v.ok && v.value.config.cancellation_rules).toEqual([]);
  });
  it("refuses a repeated window, because the database would take whichever it met first", () => {
    const v = validatePolicy({ ...base, rule_hours_0: "48", rule_type_0: "percent", rule_value_0: "50", rule_hours_1: "48", rule_type_1: "nights", rule_value_1: "1" });
    expect(v).toEqual({ ok: false, code: "policy_invalid", field: "rules" });
  });
  it.each([
    ["half a rule", { rule_hours_0: "48" }],
    ["negative hours", { rule_hours_0: "-1", rule_type_0: "percent", rule_value_0: "10" }],
    ["too many hours", { rule_hours_0: "9000", rule_type_0: "percent", rule_value_0: "10" }],
    ["over 100 percent", { rule_hours_0: "48", rule_type_0: "percent", rule_value_0: "101" }],
    ["zero percent", { rule_hours_0: "48", rule_type_0: "percent", rule_value_0: "0" }],
    ["zero nights", { rule_hours_0: "48", rule_type_0: "nights", rule_value_0: "0" }],
    ["31 nights", { rule_hours_0: "48", rule_type_0: "nights", rule_value_0: "31" }],
    ["a fractional night", { rule_hours_0: "48", rule_type_0: "nights", rule_value_0: "1.5" }],
    ["a fixed amount of zero", { rule_hours_0: "48", rule_type_0: "fixed", rule_value_0: "0" }],
    ["an unknown charge", { rule_hours_0: "48", rule_type_0: "free", rule_value_0: "1" }],
  ])("refuses %s", (_name, rule) => {
    expect(validatePolicy({ ...base, ...rule })).toEqual({ ok: false, code: "policy_invalid", field: "rules" });
  });
  it("checks the deposit, the date and the property", () => {
    expect(validatePolicy({ ...base, depositPercent: "0" })).toMatchObject({ ok: false, field: "deposit" });
    expect(validatePolicy({ ...base, depositPercent: "101" })).toMatchObject({ ok: false, field: "deposit" });
    expect(validatePolicy({ ...base, onlineMode: "other" })).toMatchObject({ ok: false, field: "deposit" });
    expect(validatePolicy({ ...base, effectiveFrom: "2026-02-30" })).toMatchObject({ ok: false, field: "date" });
    expect(validatePolicy({ ...base, effectiveFrom: "0026-01-01" })).toMatchObject({ ok: false, field: "date" });
    expect(validatePolicy({ ...base, propertyId: "nope" })).toMatchObject({ ok: false, field: "rules" });
    expect(validatePolicy({ ...base, checkinPayment: "maybe" })).toMatchObject({ ok: false });
  });
  it("ignores a tenant or any other field a form might add", () => {
    const v = validatePolicy({ ...base, tenantId: "x", rule_hours_9: "5", rule_type_9: "percent", rule_value_9: "5" });
    expect(v.ok && v.value.config.cancellation_rules).toEqual([]);
  });
});

describe("mergeConfig", () => {
  it("keeps keys the screen does not manage and replaces the ones it does", () => {
    const next = readConfig({ online_payment: { mode: "deposit_percent", value: 20 } });
    const merged = mergeConfig({ check_in_time: "15:00", checkin_payment: "full", cancellation_rules: [1] }, next);
    expect(merged.check_in_time).toBe("15:00");
    // The old version asked for payment before check-in; the new one does not, so the key is gone, not "none".
    expect(merged).not.toHaveProperty("checkin_payment");
    expect(merged.cancellation_rules).toEqual([]);
  });
  it("reads and stores the early check-out policy, storing it only when it is not 'none'", () => {
    expect(readConfig({ early_checkout: "credit" }).early_checkout).toBe("credit");
    expect(readConfig({ early_checkout: "one_night" }).early_checkout).toBe("one_night");
    for (const v of ["CREDIT", "all", false, 0, null]) expect(readConfig({ early_checkout: v }).early_checkout, String(v)).toBe("none");
    expect(mergeConfig(null, readConfig({ early_checkout: "credit" })).early_checkout).toBe("credit");
    expect(mergeConfig({ early_checkout: "credit" }, readConfig({})).early_checkout).toBeUndefined();
  });
  it("copes with no previous version", () => {
    expect(mergeConfig(null, readConfig({}))).toEqual({ cancellation_rules: [], online_payment: { mode: "full" }, guest_cancellation: "on" });
  });
  it("stores checkin_payment only as \"full\", the one value the database accepts (migration 035)", () => {
    expect(mergeConfig(null, readConfig({ checkin_payment: "full" })).checkin_payment).toBe("full");
    for (const none of [readConfig({}), readConfig({ checkin_payment: "none" })]) {
      expect(Object.values(mergeConfig({ checkin_payment: "full" }, none))).not.toContain("none");
    }
    // What the screen validates from the form with "no payment" chosen must also store without the key.
    const v = validatePolicy({ ...base, checkinPayment: "none" });
    expect(v.ok).toBe(true);
    if (v.ok) expect(mergeConfig(null, v.value.config)).not.toHaveProperty("checkin_payment");
  });
});

describe("checkEffectiveDate", () => {
  it("refuses the past and any date not after the newest version", () => {
    expect(checkEffectiveDate("2026-11-01", "2026-11-02", null)).toBe("past");
    expect(checkEffectiveDate("2026-11-02", "2026-11-02", null)).toBe("ok");
    expect(checkEffectiveDate("2026-11-10", "2026-11-02", "2026-11-10")).toBe("not_after_latest");
    expect(checkEffectiveDate("2026-11-09", "2026-11-02", "2026-11-10")).toBe("not_after_latest");
    expect(checkEffectiveDate("2026-11-11", "2026-11-02", "2026-11-10")).toBe("ok");
  });
});

describe("versionsOn", () => {
  it("finds what is in force, what is scheduled and the next number", () => {
    const rows = [{ version: 1, effective_from: "2026-01-01" }, { version: 3, effective_from: "2026-12-01" }, { version: 2, effective_from: "2026-09-12" }];
    expect(versionsOn(rows, "2026-11-02")).toEqual({ current: 2, upcoming: 3, nextVersion: 4 });
    expect(versionsOn([], "2026-11-02")).toEqual({ current: null, upcoming: null, nextVersion: 1 });
    expect(versionsOn([{ version: 1, effective_from: "2027-01-01" }], "2026-11-02")).toEqual({ current: null, upcoming: 1, nextVersion: 2 });
  });
});

describe("wording", () => {
  it("words windows and charges", () => {
    expect(describeWindow(0)).toBe("after check-in time");
    expect(describeWindow(168)).toBe("7 days or less before check-in");
    expect(describeWindow(24)).toBe("1 day or less before check-in");
    expect(describeWindow(36)).toBe("36 hours or less before check-in");
    expect(describeCharge({ type: "percent", value: 100 }, naira)).toBe("the full stay");
    expect(describeCharge({ type: "percent", value: 50 }, naira)).toBe("50% of the total");
    expect(describeCharge({ type: "nights", value: 1 }, naira)).toBe("the first night of each room");
    expect(describeCharge({ type: "nights", value: 2 }, naira)).toBe("the first 2 nights of each room");
    expect(describeCharge({ type: "fixed", value: 500000 }, naira)).toBe("₦5000.00");
  });
  it("tells a guest the deposit, the check-in rule and every cancellation step", () => {
    const lines = guestSummary(readConfig({
      cancellation_rules: [{ within_hours: 168, charge: { type: "nights", value: 1 } }, { within_hours: 48, charge: { type: "percent", value: 50 } }, { within_hours: 0, charge: { type: "percent", value: 100 } }],
      online_payment: { mode: "deposit_percent", value: 30 }, checkin_payment: "full",
    }), naira);
    expect(lines).toEqual([
      "Pay a 30% deposit online to confirm your booking. The balance is due at the hotel.",
      "The booking must be fully paid before check-in.",
      "Cancel free of charge until 7 days before check-in.",
      "Within 7 days of check-in, you pay the first night of each room.",
      "Within 2 days of check-in, you pay 50% of the total.",
      "After check-in time, you pay the full stay.",
    ]);
  });
  it("says cancelling is free when there are no rules, and full payment when no deposit is set", () => {
    expect(guestSummary(readConfig({}), naira)).toEqual(["Pay the full amount online to confirm your booking.", "You can cancel free of charge at any time before check-in."]);
  });
});

describe("classifyPolicyError", () => {
  it("never shows the database's words", () => {
    expect(classifyPolicyError({ code: "42501" })).toBe("policy_forbidden");
    expect(classifyPolicyError({ code: "P0001", message: "POLICY_VIOLATION: policy date not after the latest version" })).toBe("policy_conflict");
    expect(classifyPolicyError({ code: "P0001", message: "POLICY_VIOLATION: policy date in the past" })).toBe("policy_invalid");
    expect(classifyPolicyError({ message: "new row violates row-level security policy" })).toBe("policy_forbidden");
    expect(classifyPolicyError({ code: "23505" })).toBe("policy_conflict");
    expect(classifyPolicyError({ code: "23514" })).toBe("policy_invalid");
    expect(classifyPolicyError({ code: "XX000" })).toBe("unknown");
  });
});
