import { describe, expect, it } from "vitest";
import {
  daysLate,
  overdueInvoices,
  readOpenInvoices,
  totalsByCurrency,
  platformReminderSummary,
  readBillingReminders,
  readReminderInfo,
} from "./invoices";

const row = {
  id: "i1",
  number: "PI-2026-000001",
  tenant_id: "t1",
  tenant_name: "Hotel",
  period_start: "2026-10-01",
  period_end: "2026-11-01",
  amount_minor: 1500000,
  currency: "NGN",
  due_date: "2026-11-05",
  note: null,
};

describe("platform open invoices", () => {
  it("reads good rows and drops malformed ones", () => {
    expect(
      readOpenInvoices([
        row,
        null,
        { ...row, id: 4 },
        { ...row, amount_minor: 0 },
        { ...row, amount_minor: 1.5 },
        { ...row, id: "i2", due_date: 5 },
      ]),
    ).toEqual([
      { ...row, reminder: null },
      { ...row, id: "i2", due_date: null, reminder: null },
    ]);
    expect(readOpenInvoices(null)).toEqual([]);
  });
  it("finds the late ones", () => {
    const list = [{ due_date: "2026-11-05" }, { due_date: "2026-11-12" }, { due_date: null }, { due_date: "2026-12-01" }];
    expect(overdueInvoices(list, "2026-11-12")).toEqual([{ due_date: "2026-11-05" }]);
  });
  it("counts days late", () => {
    expect(daysLate("2026-11-05", "2026-11-12")).toBe(7);
    expect(daysLate("2026-11-12", "2026-11-12")).toBe(0);
    expect(daysLate(null, "2026-11-12")).toBe(0);
  });
  it("totals per currency", () => {
    expect(
      totalsByCurrency([
        { amount_minor: 100, currency: "NGN" },
        { amount_minor: 50, currency: "USD" },
        { amount_minor: 25, currency: "NGN" },
      ]),
    ).toEqual([
      ["NGN", 125],
      ["USD", 50],
    ]);
  });
});

describe("platform invoice reminder status (migration 186)", () => {
  const date = (iso: string) => `D(${iso})`;
  const info = (over: Record<string, unknown>) =>
    readReminderInfo({ reminders_on: true, next_reminder_date: null, reminders: [], ...over });

  it("reads the status and drops reminders with an unknown outcome", () => {
    const i = info({
      next_reminder_date: "2026-12-01",
      reminders: [
        { no: 1, outcome: "sent", sent_at: "2026-11-20T08:01:00Z" },
        { no: 2, outcome: "queued", sent_at: null },
        { no: 3, outcome: "weird" },
        { outcome: "sent" },
      ],
    });
    expect(i?.reminders).toHaveLength(2);
    expect(i?.reminders[0]).toMatchObject({ no: 1, outcome: "sent", sentAt: "2026-11-20T08:01:00Z" });
    expect(readReminderInfo(null)).toBeNull();
    expect(readReminderInfo([])).toBeNull();
  });

  it("words the summary for each state", () => {
    expect(platformReminderSummary(null, date)).toBe("");
    expect(platformReminderSummary(info({ reminders_on: false }), date)).toBe("Off for this group");
    expect(platformReminderSummary(info({ next_reminder_date: "2026-11-21" }), date)).toBe("none yet, next D(2026-11-21)");
    expect(
      platformReminderSummary(
        info({
          next_reminder_date: "2026-12-01",
          reminders: [
            { no: 1, outcome: "sent", sent_at: "b" },
            { no: 2, outcome: "queued", sent_at: null },
            { no: 3, outcome: "failed", sent_at: null },
          ],
        }),
        date,
      ),
    ).toBe("1 sent, 1 on the way, 1 not delivered, next D(2026-12-01)");
    expect(platformReminderSummary(info({ reminders: [{ no: 1, outcome: "closed", sent_at: null }] }), date)).toBe("1 closed out");
  });

  it("carries the reminder info on an open invoice row and on the group page data", () => {
    const [o] = readOpenInvoices([
      {
        id: "i1",
        number: "PI-1",
        tenant_id: "t1",
        tenant_name: "G",
        amount_minor: 100,
        currency: "NGN",
        reminder_info: { reminders_on: true, reminders: [] },
      },
    ]);
    expect(o?.reminder).toMatchObject({ remindersOn: true });
    expect(
      readOpenInvoices([{ id: "i2", number: "PI-2", tenant_id: "t1", tenant_name: "G", amount_minor: 100, currency: "NGN" }])[0]?.reminder,
    ).toBeNull();
    const b = readBillingReminders({
      billing_email: "a@b.test",
      remind_overdue_invoices: true,
      invoices: [
        { invoice_id: "i1", number: "PI-1", due_date: "2026-11-01", info: { reminders_on: true, reminders: [] } },
        { number: "bad" },
      ],
    });
    expect(b?.billingEmail).toBe("a@b.test");
    expect(b?.remind).toBe(true);
    expect(b?.invoices).toHaveLength(1);
    expect(readBillingReminders("x")).toBeNull();
  });
});
