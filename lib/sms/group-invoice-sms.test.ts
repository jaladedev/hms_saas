import { describe, expect, it } from "vitest";
import { drainInvoiceSms, renderInvoiceReminderSms, type ClaimedInvoiceSms } from "@/lib/sms/group-invoice-sms";
import { SmsSendError } from "@/lib/sms/provider";
import { smsParts } from "@/lib/sms/templates";

const payload = {
  hotel: "Hôtel A",
  hotel_phone: "+234 800 000",
  invoice_number: "INV-A-2026-000012",
  total_minor: 5000000,
  currency: "NGN",
  due_date: "2026-11-01",
  reminder_no: 1,
};
const row = (id: string, p: Record<string, unknown> = payload): ClaimedInvoiceSms => ({
  id,
  to_phone: "+2348031234567",
  channel: "sms",
  payload: p,
  attempt: 1,
});

describe("invoice reminder text", () => {
  it("states the invoice, amount and due date, and stays one part", () => {
    const t = renderInvoiceReminderSms(payload);
    expect(t).toContain("INV-A-2026-000012");
    expect(t).toContain("NGN 50,000.00");
    expect(t).toContain("due 1 Nov");
    expect(t).toContain("call +234 800 000");
    expect(t).not.toMatch(/https?:/);
    expect(smsParts(t)).toBeLessThanOrEqual(2);
  });
  it("marks later reminders and tolerates a missing hotel phone", () => {
    const t = renderInvoiceReminderSms({ ...payload, reminder_no: 2, hotel_phone: "" });
    expect(t).toContain("reminder,");
    expect(t).toContain("contact us");
  });
  it("refuses a payload with no amount", () => {
    expect(() => renderInvoiceReminderSms({ ...payload, total_minor: 0 })).toThrow(SmsSendError);
  });
});

describe("drainInvoiceSms", () => {
  it("sends each text and marks failures without stopping", async () => {
    const marks: Record<string, unknown>[] = [];
    const sent: string[] = [];
    const res = await drainInvoiceSms(
      {
        claim: async () => [row("a"), row("b"), row("c", { ...payload, total_minor: 0 })],
        mark: async (id, r) => void marks.push({ id, ...r }),
        provider: {
          send: async (m) => {
            if (m.idempotencyKey === "b") throw new SmsSendError("invalid number", true);
            sent.push(m.idempotencyKey);
            return { providerMessageId: null };
          },
        },
      },
      10,
    );
    expect(res).toEqual({ claimed: 3, sent: 1, failed: 2 });
    expect(sent).toEqual(["a"]);
    expect(marks.map((m) => [m.id, m.ok, m.permanent])).toEqual([
      ["a", true, false],
      ["b", false, true],
      ["c", false, true],
    ]);
  });
});
