import { describe, expect, it } from "vitest";
import { parseFailures, parseSmsForm, parseUsage, smsSummary } from "@/lib/staff/sms-settings";

const P = "00000000-0000-0000-0000-0000000000a2";
const good = {
  propertyId: P,
  enabled: "on",
  kinds: ["review_request", "booking_confirmed"],
  channel: "sms",
  monthlyCap: "300",
  reminderDays: "2",
};

describe("parseSmsForm", () => {
  it("reads a valid form, puts the kinds in the standard order and turns the checkbox into a boolean", () => {
    const r = parseSmsForm(good);
    expect(r).toEqual({
      ok: true,
      value: {
        propertyId: P,
        enabled: true,
        kinds: ["booking_confirmed", "review_request"],
        channel: "sms",
        monthlyCap: 300,
        reminderDays: 2,
      },
    });
    expect(parseSmsForm({ ...good, enabled: null })).toMatchObject({ ok: true, value: { enabled: false } });
    expect(parseSmsForm({ ...good, kinds: [], monthlyCap: "0" })).toMatchObject({ ok: true, value: { kinds: [], monthlyCap: 0 } });
  });
  it("refuses an unknown kind, channel, limit, reminder or hotel id", () => {
    for (const bad of [
      { kinds: ["spam"] },
      { kinds: ["booking_confirmed", 5] },
      { channel: "telegram" },
      { monthlyCap: "-1" },
      { monthlyCap: "100001" },
      { monthlyCap: "12.5" },
      { monthlyCap: "" },
      { monthlyCap: 300 },
      { reminderDays: "0" },
      { reminderDays: "8" },
      { reminderDays: "12" },
      { reminderDays: "" },
      { propertyId: "nope" },
    ]) {
      expect(parseSmsForm({ ...good, ...bad })).toEqual({ ok: false, code: "sms_invalid" });
    }
  });
  it("accepts WhatsApp and the largest limit", () => {
    expect(parseSmsForm({ ...good, channel: "whatsapp", monthlyCap: "100000" })).toMatchObject({
      ok: true,
      value: { channel: "whatsapp", monthlyCap: 100000 },
    });
  });
});

describe("smsSummary", () => {
  it("says what happens now", () => {
    expect(smsSummary(false, ["booking_confirmed"], 300)).toBe("Guests are not sent text messages.");
    expect(smsSummary(true, [], 300)).toContain("nothing is sent");
    expect(smsSummary(true, ["booking_confirmed"], 300)).toBe(
      "Guests with a mobile number on their booking are sent: booking confirmed. At most 300 a month.",
    );
    expect(smsSummary(true, ["booking_confirmed", "arrival_reminder", "review_request"], 1500)).toContain(
      "booking confirmed, arrival reminder and review request",
    );
  });
});

describe("reading what the database returns", () => {
  it("usage: anything unexpected reads as empty, and a missing plan flag reads as on", () => {
    expect(parseUsage(null)).toEqual({ plan_enabled: true, cap: 0, used_this_month: 0, months: [] });
    expect(
      parseUsage({
        plan_enabled: false,
        cap: 300,
        used_this_month: 12,
        months: [{ month: "2026-11", sent: 10, waiting: 1, failed: 1 }, "x", { sent: 1 }],
      }),
    ).toEqual({
      plan_enabled: false,
      cap: 300,
      used_this_month: 12,
      months: [{ month: "2026-11", sent: 10, waiting: 1, failed: 1 }],
    });
  });
  it("failures: keeps well-formed rows only", () => {
    const row = {
      id: "a",
      kind: "booking_confirmed",
      to: "+234•••••002",
      error: "Termii HTTP 400",
      attempts: 5,
      created_at: "2026-11-19T10:00:00Z",
    };
    expect(parseFailures([row, { id: 1 }, null])).toEqual([row]);
    expect(parseFailures("nope")).toEqual([]);
    expect(parseFailures([{ ...row, error: null }])[0]?.error).toBeNull();
  });
});
