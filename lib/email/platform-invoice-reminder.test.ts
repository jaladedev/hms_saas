import { describe, expect, it } from "vitest";
import { drainReminders } from "./group-invoice-reminder";
import { platformReminderPayload, renderPlatformInvoiceReminder } from "./platform-invoice-reminder";

const payload = {
  tenant_name: "Palm Hotels Ltd",
  invoice_number: "PI-2026-000042",
  amount_minor: 5_000_000,
  currency: "NGN",
  due_date: "2026-11-10",
  period_start: "2026-10-01",
  period_end: "2026-11-01",
  days_overdue: 3,
  reminder_no: 1,
};

describe("renderPlatformInvoiceReminder", () => {
  it("states the invoice, amount, due date and days overdue, and links nowhere", () => {
    const e = renderPlatformInvoiceReminder(payload);
    expect(e.subject).toBe("Invoice PI-2026-000042 is overdue");
    expect(e.text).toContain("Dear Palm Hotels Ltd,");
    expect(e.text).toContain("PI-2026-000042");
    expect(e.text).toContain("3 days overdue");
    expect(e.text).not.toMatch(/https?:\/\//);
    expect(e.html).not.toMatch(/href=/);
  });
  it("marks later reminders and says '1 day' in the singular", () => {
    const e = renderPlatformInvoiceReminder({ ...payload, reminder_no: 2, days_overdue: 1 });
    expect(e.subject).toBe("Reminder: Invoice PI-2026-000042 is overdue");
    expect(e.text).toContain("(1 day overdue)");
  });
  it("adds the support address and the online payment line only when they are set", () => {
    const plain = renderPlatformInvoiceReminder(payload);
    expect(plain.text).not.toContain("To reach us");
    expect(plain.text).not.toContain("by card");
    const full = renderPlatformInvoiceReminder(payload, { supportEmail: "billing@platform.example", canPayOnline: true });
    expect(full.text).toContain("write to billing@platform.example");
    expect(full.text).toContain("by card under Settings, then Billing");
  });
  it("escapes the group name in the HTML", () => {
    const e = renderPlatformInvoiceReminder({ ...payload, tenant_name: "<b>Evil</b> & Co" });
    expect(e.html).toContain("&lt;b&gt;Evil&lt;/b&gt; &amp; Co");
    expect(e.html).not.toContain("<b>Evil");
  });
  it("refuses a payload with no invoice number or no amount, and reads missing fields safely", () => {
    expect(() => renderPlatformInvoiceReminder({ ...payload, invoice_number: "" })).toThrow();
    expect(() => renderPlatformInvoiceReminder({ ...payload, amount_minor: 0 })).toThrow();
    expect(platformReminderPayload({})).toMatchObject({ hotelGroup: "", currency: "NGN", daysOverdue: 0, reminderNo: 1 });
  });
});

describe("drainReminders with the platform template", () => {
  it("sends each claimed reminder with the supplied renderer and records the result", async () => {
    const sent: { to: string; subject: string }[] = [];
    const marks: [string, boolean][] = [];
    const out = await drainReminders(
      {
        async claim() {
          return [
            { id: "a", to_email: "one@hotel.example", payload, attempt: 1 },
            { id: "b", to_email: "two@hotel.example", payload: { ...payload, invoice_number: "" }, attempt: 1 },
          ];
        },
        async mark(id, ok) {
          marks.push([id, ok]);
        },
        mailer: {
          async send(m) {
            sent.push({ to: m.to, subject: m.subject });
          },
        },
        render: (p) => renderPlatformInvoiceReminder(p),
      },
      10,
    );
    expect(out).toEqual({ claimed: 2, sent: 1, failed: 1 });
    expect(sent).toEqual([{ to: "one@hotel.example", subject: "Invoice PI-2026-000042 is overdue" }]);
    expect(marks).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });
});
