import { describe, expect, it } from "vitest";
import { availableDocs, chooseDoc, documentsPath, pickInvoice, receiptTotals } from "./documents";

describe("availableDocs", () => {
  it("gives a confirmed, unpaid, uninvoiced booking only its confirmation", () => {
    expect(availableDocs({ status: "confirmed", invoices: 0, succeededPayments: 0 })).toEqual(["confirmation"]);
  });
  it("adds the invoice and the receipt when they exist, in a fixed order", () => {
    expect(availableDocs({ status: "checked_out", invoices: 2, succeededPayments: 1 })).toEqual(["confirmation", "invoice", "receipt"]);
  });
  it("gives a cancelled booking a cancellation notice, and no confirmation", () => {
    expect(availableDocs({ status: "cancelled", invoices: 0, succeededPayments: 1 })).toEqual(["receipt", "cancellation"]);
  });
  it("gives a held or expired booking nothing", () => {
    expect(availableDocs({ status: "pending", invoices: 0, succeededPayments: 0 })).toEqual([]);
    expect(availableDocs({ status: "expired", invoices: 0, succeededPayments: 0 })).toEqual([]);
  });
});

describe("chooseDoc", () => {
  it("takes the one asked for if it exists, otherwise the first, otherwise null", () => {
    expect(chooseDoc("receipt", ["confirmation", "receipt"])).toBe("receipt");
    expect(chooseDoc("invoice", ["confirmation", "receipt"])).toBe("confirmation");
    expect(chooseDoc(["receipt", "x"], ["confirmation", "receipt"])).toBe("receipt");
    expect(chooseDoc(undefined, [])).toBeNull();
  });
});

describe("pickInvoice", () => {
  it("prefers the live invoice, else the latest void one", () => {
    expect(
      pickInvoice([
        { invoice_status: "void", n: 1 },
        { invoice_status: "issued", n: 2 },
        { invoice_status: "void", n: 3 },
      ])?.n,
    ).toBe(2);
    expect(
      pickInvoice([
        { invoice_status: "void", n: 1 },
        { invoice_status: "void", n: 3 },
      ])?.n,
    ).toBe(3);
    expect(pickInvoice([])).toBeNull();
  });
});

describe("receiptTotals", () => {
  it("counts only succeeded payments, and separates paid-back from pending refunds", () => {
    const t = receiptTotals(
      [
        { amount_minor: 10000, payment_status: "succeeded" },
        { amount_minor: 5000, payment_status: "reversed" },
        { amount_minor: 2500, payment_status: "succeeded" },
      ],
      [
        { amount_minor: 3000, refund_status: "succeeded" },
        { amount_minor: 1000, refund_status: "requested" },
        { amount_minor: 900, refund_status: "rejected" },
      ],
    );
    expect(t).toEqual({ received: 12500, refunded: 3000, pending: 1000, kept: 9500 });
  });
});

describe("documentsPath", () => {
  it("builds the address", () => {
    expect(documentsPath("abc")).toBe("/app/reservations/abc/documents");
    expect(documentsPath("abc", "receipt")).toBe("/app/reservations/abc/documents?doc=receipt");
  });
});
