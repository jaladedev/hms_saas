import { describe, expect, it } from "vitest";
import { parseReminderForm, reminderSummary } from "./arrival-reminders";

const ID = "00000000-0000-4000-8000-0000000000a2";

describe("parseReminderForm", () => {
  it("reads off, blank and 1 to 7 days", () => {
    expect(parseReminderForm({ propertyId: ID, days: "" })).toEqual({ ok: true, value: { propertyId: ID, days: null } });
    expect(parseReminderForm({ propertyId: ID, days: "off" })).toEqual({ ok: true, value: { propertyId: ID, days: null } });
    expect(parseReminderForm({ propertyId: ID, days: " 3 " })).toEqual({ ok: true, value: { propertyId: ID, days: 3 } });
    expect(parseReminderForm({ propertyId: ID, days: "7" }).ok).toBe(true);
  });
  it("refuses 0, 8, decimals, words and a bad hotel id", () => {
    for (const days of ["0", "8", "2.5", "-1", "two", "10"])
      expect(parseReminderForm({ propertyId: ID, days })).toEqual({ ok: false, code: "setup_invalid" });
    expect(parseReminderForm({ propertyId: "nope", days: "2" })).toEqual({ ok: false, code: "setup_invalid" });
    expect(parseReminderForm({ days: "2" }).ok).toBe(false);
    expect(parseReminderForm({ propertyId: ID }).ok).toBe(false);
    expect(parseReminderForm({ propertyId: ID, days: 2 }).ok).toBe(false);
  });
});

describe("reminderSummary", () => {
  it("says what the setting does", () => {
    expect(reminderSummary(null)).toContain("not sent");
    expect(reminderSummary(1)).toContain("the day before");
    expect(reminderSummary(3)).toContain("3 days or fewer");
  });
});
