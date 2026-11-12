import { describe, expect, it } from "vitest";
import { daysLate, overdueInvoices, readOpenInvoices, totalsByCurrency } from "./invoices";

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
    ).toEqual([row, { ...row, id: "i2", due_date: null }]);
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
