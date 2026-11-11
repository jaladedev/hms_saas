import { describe, expect, it } from "vitest";
import { amountOwing, dueLabel, invoiceOverdue } from "./hotel-billing";

describe("hotel billing", () => {
  it("overdue only for an open invoice past its due date", () => {
    expect(invoiceOverdue({ status: "open", due_date: "2026-11-01" }, "2026-11-11")).toBe(true);
    expect(invoiceOverdue({ status: "open", due_date: "2026-11-11" }, "2026-11-11")).toBe(false);
    expect(invoiceOverdue({ status: "paid", due_date: "2026-11-01" }, "2026-11-11")).toBe(false);
    expect(invoiceOverdue({ status: "open", due_date: null }, "2026-11-11")).toBe(false);
  });
  it("sums only open invoices, per currency", () => {
    const m = amountOwing([
      { status: "open", amount_minor: 100, currency: "NGN" },
      { status: "open", amount_minor: 50, currency: "NGN" },
      { status: "open", amount_minor: 7, currency: "USD" },
      { status: "paid", amount_minor: 999, currency: "NGN" },
      { status: "open", amount_minor: -5, currency: "NGN" },
      { status: "open", amount_minor: 1.5, currency: "NGN" },
    ]);
    expect(m.get("NGN")).toBe(150);
    expect(m.get("USD")).toBe(7);
    expect(amountOwing([]).size).toBe(0);
  });
  it("words the due date", () => {
    const t = "2026-11-11";
    expect(dueLabel({ status: "open", due_date: "2026-11-11" }, t)).toBe("Due today");
    expect(dueLabel({ status: "open", due_date: "2026-11-12" }, t)).toBe("Due in 1 day");
    expect(dueLabel({ status: "open", due_date: "2026-11-16" }, t)).toBe("Due in 5 days");
    expect(dueLabel({ status: "open", due_date: "2026-11-10" }, t)).toBe("1 day overdue");
    expect(dueLabel({ status: "open", due_date: "2026-11-01" }, t)).toBe("10 days overdue");
    expect(dueLabel({ status: "paid", due_date: "2026-11-01" }, t)).toBeNull();
    expect(dueLabel({ status: "open", due_date: null }, t)).toBeNull();
    expect(dueLabel({ status: "open", due_date: "junk" }, t)).toBeNull();
  });
});
