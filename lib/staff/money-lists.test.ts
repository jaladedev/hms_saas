import { describe, expect, it } from "vitest";
import {
  filterZone,
  invoiceFiltersActive,
  invoiceQuery,
  invoiceStatusLabel,
  isOverdue,
  parseInvoiceFilters,
  parsePaymentFilters,
  paymentFiltersActive,
  paymentMethodLabel,
  paymentQuery,
  paymentStatusColumns,
  receivedTotals,
  startOfDayIso,
  startOfNextDayIso,
} from "./money-lists";

describe("payments list filters", () => {
  it("defaults everything and ignores unknown values", () => {
    expect(parsePaymentFilters({})).toEqual({ q: "", source: "all", status: "all", from: null, to: null, page: 1 });
    expect(parsePaymentFilters({ source: "bitcoin", status: "x", from: "2026-02-30", page: "-4" })).toEqual({
      q: "",
      source: "all",
      status: "all",
      from: null,
      to: null,
      page: 1,
    });
  });
  it("reads good values and cleans the search text", () => {
    const f = parsePaymentFilters({
      q: "  HMS-8K2Q,(x) ",
      source: "paystack",
      status: "unverified",
      from: "2026-11-01",
      to: "2026-11-10",
      page: "3",
    });
    expect(f).toEqual({ q: "HMS-8K2Q x", source: "paystack", status: "unverified", from: "2026-11-01", to: "2026-11-10", page: 3 });
  });
  it("builds short links that leave out defaults and round-trip", () => {
    const f = parsePaymentFilters({});
    expect(paymentQuery(f)).toBe("");
    expect(paymentQuery(f, { source: "manual", page: 2 })).toBe("?source=manual&page=2");
    const again = parsePaymentFilters(Object.fromEntries(new URLSearchParams(paymentQuery(f, { q: "abc", status: "reversed" }))));
    expect(again.q).toBe("abc");
    expect(again.status).toBe("reversed");
  });
  it("knows when a filter is set", () => {
    expect(paymentFiltersActive(parsePaymentFilters({}))).toBe(false);
    expect(paymentFiltersActive(parsePaymentFilters({ page: "2" }))).toBe(false);
    expect(paymentFiltersActive(parsePaymentFilters({ source: "manual" }))).toBe(true);
  });
  it("maps the waiting-to-verify choice to a verification state, not a payment status", () => {
    expect(paymentStatusColumns("all")).toEqual({});
    expect(paymentStatusColumns("reversed")).toEqual({ payment_status: "reversed" });
    expect(paymentStatusColumns("unverified")).toEqual({ payment_status: "succeeded", verification_status: "unverified" });
  });
  it("words methods, including the ones Paystack reports, and shows an unknown one as given", () => {
    expect(paymentMethodLabel("bank_transfer")).toBe("Bank transfer");
    expect(paymentMethodLabel("mobile_money")).toBe("Mobile money");
    expect(paymentMethodLabel("something_new")).toBe("something_new");
  });
  it("totals only received money, one currency at a time", () => {
    const totals = receivedTotals([
      { amount_minor: 1000, currency: "NGN", payment_status: "succeeded" },
      { amount_minor: 500, currency: "NGN", payment_status: "succeeded" },
      { amount_minor: 9999, currency: "NGN", payment_status: "reversed" },
      { amount_minor: 200, currency: "USD", payment_status: "succeeded" },
    ]);
    expect(totals.get("NGN")).toBe(1500);
    expect(totals.get("USD")).toBe(200);
    expect(totals.size).toBe(2);
    expect(receivedTotals([]).size).toBe(0);
  });
});

describe("invoice list filters", () => {
  it("defaults to booking invoices, any status", () => {
    expect(parseInvoiceFilters({})).toEqual({ q: "", kind: "stay", status: "all", from: null, to: null, page: 1 });
  });
  it("ignores a status the chosen kind does not have", () => {
    expect(parseInvoiceFilters({ status: "paid" }).status).toBe("paid");
    expect(parseInvoiceFilters({ kind: "extras", status: "paid" }).status).toBe("all");
    expect(parseInvoiceFilters({ kind: "extras", status: "void" }).status).toBe("void");
    expect(parseInvoiceFilters({ kind: "nonsense" }).kind).toBe("stay");
  });
  it("builds short links", () => {
    const f = parseInvoiceFilters({});
    expect(invoiceQuery(f)).toBe("");
    expect(invoiceQuery(f, { kind: "extras", page: 3 })).toBe("?kind=extras&page=3");
    expect(invoiceFiltersActive(f)).toBe(false);
    expect(invoiceFiltersActive(parseInvoiceFilters({ kind: "extras" }))).toBe(true);
  });
  it("words statuses and shows an unknown one as given", () => {
    expect(invoiceStatusLabel("partially_paid")).toBe("Part paid");
    expect(invoiceStatusLabel("weird")).toBe("weird");
  });
  it("calls an invoice overdue only when it is live, has a due date, and the date has passed", () => {
    const now = new Date("2026-11-10T12:00:00Z");
    expect(isOverdue({ invoice_status: "issued", due_at: "2026-11-09T00:00:00Z" }, now)).toBe(true);
    expect(isOverdue({ invoice_status: "partially_paid", due_at: "2026-11-01T00:00:00Z" }, now)).toBe(true);
    expect(isOverdue({ invoice_status: "issued", due_at: "2026-11-11T00:00:00Z" }, now)).toBe(false);
    expect(isOverdue({ invoice_status: "paid", due_at: "2026-11-01T00:00:00Z" }, now)).toBe(false);
    expect(isOverdue({ invoice_status: "void", due_at: "2026-11-01T00:00:00Z" }, now)).toBe(false);
    expect(isOverdue({ invoice_status: "issued", due_at: null }, now)).toBe(false);
    expect(isOverdue({ invoice_status: "issued", due_at: "garbage" }, now)).toBe(false);
  });
});

describe("hotel-day bounds", () => {
  it("starts a Lagos day an hour before UTC midnight", () => {
    expect(startOfDayIso("2026-11-01", "Africa/Lagos")).toBe("2026-10-31T23:00:00.000Z");
    expect(startOfNextDayIso("2026-11-01", "Africa/Lagos")).toBe("2026-11-01T23:00:00.000Z");
  });
  it("uses UTC for UTC and for an unknown zone", () => {
    expect(startOfDayIso("2026-11-01", "UTC")).toBe("2026-11-01T00:00:00.000Z");
    expect(startOfDayIso("2026-11-01", "Not/AZone")).toBe("2026-11-01T00:00:00.000Z");
  });
  it("follows daylight saving: New York is UTC-5 in winter and UTC-4 in summer", () => {
    expect(startOfDayIso("2026-01-15", "America/New_York")).toBe("2026-01-15T05:00:00.000Z");
    expect(startOfDayIso("2026-07-15", "America/New_York")).toBe("2026-07-15T04:00:00.000Z");
  });
  it("handles the day the clocks change: the day is 23 hours long in New York on 8 Mar 2026", () => {
    const start = Date.parse(startOfDayIso("2026-03-08", "America/New_York"));
    const end = Date.parse(startOfNextDayIso("2026-03-08", "America/New_York"));
    expect(start).toBe(Date.parse("2026-03-08T05:00:00.000Z"));
    expect((end - start) / 3600000).toBe(23);
  });
  it("rolls the next day over a month end", () => {
    expect(startOfNextDayIso("2026-12-31", "UTC")).toBe("2027-01-01T00:00:00.000Z");
  });
  it("picks one zone when the hotels agree, UTC and a warning when they do not", () => {
    expect(filterZone(["Africa/Lagos", "Africa/Lagos"])).toEqual({ zone: "Africa/Lagos", mixed: false });
    expect(filterZone(["Africa/Lagos", "Europe/London"])).toEqual({ zone: "UTC", mixed: true });
    expect(filterZone([])).toEqual({ zone: "UTC", mixed: false });
  });
});
