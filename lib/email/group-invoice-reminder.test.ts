import { describe, expect, it } from "vitest";
import { drainReminders, renderGroupInvoiceReminder, reminderPayload } from "@/lib/email/group-invoice-reminder";

const payload = {
  hotel: "Hotel A",
  hotel_phone: "+234 800 000",
  hotel_email: "front@a.example",
  bill_to: "Acme Ltd",
  invoice_number: "INV-A-2026-000012",
  total_minor: 5000000,
  currency: "NGN",
  due_date: "2026-11-01",
  days_overdue: 3,
  reminder_no: 1,
};

describe("group invoice reminder", () => {
  it("states the invoice, amount, due date and how to reach the hotel", () => {
    const m = renderGroupInvoiceReminder(payload);
    expect(m.subject).toBe("Invoice INV-A-2026-000012 from Hotel A is overdue");
    expect(m.text).toContain("INV-A-2026-000012");
    expect(m.text).toContain("3 days overdue");
    expect(m.text).toContain("+234 800 000");
    expect(m.html).toContain("Acme Ltd");
  });
  it("marks later reminders and escapes markup", () => {
    const m = renderGroupInvoiceReminder({ ...payload, reminder_no: 2, bill_to: "<b>X</b>", days_overdue: 1 });
    expect(m.subject.startsWith("Reminder: ")).toBe(true);
    expect(m.html).not.toContain("<b>X</b>");
    expect(m.text).toContain("1 day overdue");
  });
  it("refuses a payload with no invoice number or amount, and defaults the rest", () => {
    expect(() => renderGroupInvoiceReminder({})).toThrow();
    expect(reminderPayload({}).hotel).toBe("the hotel");
  });
  it("sends each claimed reminder and records failures without stopping", async () => {
    const marks: [string, boolean][] = [];
    const sentTo: string[] = [];
    const result = await drainReminders(
      {
        claim: async () => [
          { id: "1", to_email: "a@x.example", payload, attempt: 1 },
          { id: "2", to_email: "b@x.example", payload, attempt: 1 },
          { id: "3", to_email: "c@x.example", payload: {}, attempt: 1 },
        ],
        mark: async (id, ok) => void marks.push([id, ok]),
        mailer: {
          send: async (m) => {
            if (m.to === "a@x.example") throw new Error("boom");
            sentTo.push(m.to);
          },
        },
      },
      10,
    );
    expect(result).toEqual({ claimed: 3, sent: 1, failed: 2 });
    expect(sentTo).toEqual(["b@x.example"]);
    expect(marks).toEqual([
      ["1", false],
      ["2", true],
      ["3", false],
    ]);
  });
});
