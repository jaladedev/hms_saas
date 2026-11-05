import { describe, expect, it } from "vitest";
import { classifyFolioError, folioActions, FOLIO_OK_CODES, type FolioBalance } from "./folio";
import {
  folioInvoicePath, invoiceActions, invoiceNumberOf, lineTotals, splitInvoices, uninvoiced, uninvoicedTotalMinor, type FolioInvoiceRow,
} from "./folio-invoice";
import { errorMessage, OK_MESSAGES } from "./refunds";

const charge = (id: string, over: Partial<{ status: string; folio_invoice_id: string | null; total_minor: number }> = {}) => ({
  id, status: "posted", folio_invoice_id: null as string | null, total_minor: 100000, ...over,
});
const invoice = (id: string, over: Partial<FolioInvoiceRow> = {}): FolioInvoiceRow => ({
  id, invoice_number: `INV-HTL-2026-00000${id}`, invoice_status: "issued", subtotal_minor: 100000, tax_minor: 0, total_minor: 100000,
  issued_at: `2026-11-0${id}T10:00:00Z`, voided_at: null, void_reason: null, ...over,
});
const ALL = { issue: true, void: true };
const bal = (over: Partial<FolioBalance> = {}): FolioBalance => ({ currency: "NGN", charge_count: 1, charges_minor: 100000, tax_minor: 0, paid_minor: 0, balance_minor: 100000, ...over });

describe("what is left to invoice", () => {
  it("is every posted extra that is on no live invoice", () => {
    const cs = [charge("a"), charge("b", { folio_invoice_id: "1" }), charge("c", { status: "voided" }), charge("d", { total_minor: 50000 })];
    expect(uninvoiced(cs).map((c) => c.id)).toEqual(["a", "d"]);
    expect(uninvoicedTotalMinor(cs)).toBe(150000);
    expect(uninvoiced([])).toEqual([]);
  });
});

describe("invoiceActions", () => {
  it("offers Issue while the folio is open, the viewer may issue and something is left", () => {
    const a = invoiceActions(true, [charge("a"), charge("b", { total_minor: 50000 })], ALL);
    expect(a.issue).toBe(true);
    expect(a.uninvoicedCount).toBe(2);
    expect(a.uninvoicedTotalMinor).toBe(150000);
  });
  it("does not offer Issue without the permission, without an open folio, or with nothing left", () => {
    expect(invoiceActions(true, [charge("a")], { issue: false, void: true }).issue).toBe(false);
    expect(invoiceActions(false, [charge("a")], ALL).issue).toBe(false);
    expect(invoiceActions(true, [charge("a", { folio_invoice_id: "1" })], ALL).issue).toBe(false);
    expect(invoiceActions(true, [], ALL).issue).toBe(false);
  });
  it("offers Void only on an issued invoice, to a viewer who may void", () => {
    expect(invoiceActions(true, [], ALL).void({ invoice_status: "issued" })).toBe(true);
    expect(invoiceActions(true, [], ALL).void({ invoice_status: "void" })).toBe(false);
    expect(invoiceActions(true, [], { issue: true, void: false }).void({ invoice_status: "issued" })).toBe(false);
  });
});

describe("a charge on an invoice is not offered for voiding", () => {
  const open = "checked_in";
  const viewer = { charge: true, record: true, reverse: true };
  it("hides Void charge and does not blame the payment", () => {
    const a = folioActions(open, bal(), viewer);
    expect(a.voidCharge(charge("a"))).toBe(true);
    expect(a.voidCharge(charge("a", { folio_invoice_id: "1" }))).toBe(false);
    expect(a.voidBlockedByPayment(charge("a", { folio_invoice_id: "1" }))).toBe(false);
  });
  it("still blames the payment for an uninvoiced charge it would overpay", () => {
    const a = folioActions(open, bal({ paid_minor: 100000, balance_minor: 0 }), viewer);
    expect(a.voidBlockedByPayment(charge("a"))).toBe(true);
  });
});

describe("splitInvoices and invoiceNumberOf", () => {
  const rows = [
    invoice("3", { invoice_status: "void", voided_at: "2026-11-04T09:00:00Z" }), invoice("2"), invoice("1"),
    invoice("4", { invoice_status: "void", voided_at: "2026-11-05T09:00:00Z" }),
  ];
  it("lists live invoices in the order issued and voided ones latest first", () => {
    const s = splitInvoices(rows);
    expect(s.live.map((i) => i.id)).toEqual(["1", "2"]);
    expect(s.voided.map((i) => i.id)).toEqual(["4", "3"]);
  });
  it("names the invoice a charge is on, or nothing", () => {
    expect(invoiceNumberOf("2", rows)).toBe("INV-HTL-2026-000002");
    expect(invoiceNumberOf(null, rows)).toBeUndefined();
    expect(invoiceNumberOf("zz", rows)).toBeUndefined();
  });
  it("builds the printable page's path", () => {
    expect(folioInvoicePath("r", "i")).toBe("/app/reservations/r/folio-invoice/i");
  });
});

describe("lineTotals", () => {
  it("adds quantity times price and the tax, as the invoice does", () => {
    expect(lineTotals([{ quantity: 2, unit_amount_minor: 150000, tax_minor: 22500 }, { quantity: 1, unit_amount_minor: 1000000, tax_minor: 0 }]))
      .toEqual({ subtotal: 1300000, tax: 22500, total: 1322500 });
    expect(lineTotals([])).toEqual({ subtotal: 0, tax: 0, total: 0 });
  });
});

describe("refusals and messages", () => {
  it("words the two new refusals before the general not-open one", () => {
    expect(classifyFolioError("INVALID_STATE: on an invoice")).toEqual({ code: "fo_on_invoice" });
    expect(classifyFolioError("INVALID_STATE: nothing to invoice")).toEqual({ code: "fo_nothing" });
    expect(classifyFolioError("INVALID_STATE: checked_in")).toEqual({ code: "fo_not_open" });
    expect(classifyFolioError("INVALID_STATE: folio paid")).toEqual({ code: "fo_paid" });
  });
  it("has a plain sentence for each new code", () => {
    expect(errorMessage("fo_on_invoice", null, String)).toMatch(/Void the invoice first/);
    expect(errorMessage("fo_nothing", null, String)).toMatch(/already on an invoice/);
    for (const code of ["fo_invoiced", "fo_invoice_voided"] as const) {
      expect(FOLIO_OK_CODES).toContain(code);
      expect(OK_MESSAGES[code]).toBeTruthy();
    }
  });
});
