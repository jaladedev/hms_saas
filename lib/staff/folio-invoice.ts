/**
 * The numbered invoice for extras (migration 048). Pure functions, so they can be tested. The database decides who may issue
 * or void one and what goes on it; these helpers decide what to show and which buttons are worth offering.
 *
 * An invoice for extras is a frozen, numbered copy of the posted extras it covers. It lives in its own table and does not
 * touch the booking's own invoice, payments or refunds. Money for extras stays on the folio and is not tied to one invoice,
 * so an invoice is only issued or void.
 */
import type { ChargeRow } from "./folio";

export type FolioInvoiceRow = {
  id: string;
  invoice_number: string;
  invoice_status: string;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  issued_at: string;
  voided_at: string | null;
  void_reason: string | null;
};
export const FOLIO_INVOICE_COLUMNS =
  "id, invoice_number, invoice_status, subtotal_minor, tax_minor, total_minor, issued_at, voided_at, void_reason";

export type FolioInvoiceLine = {
  id: string;
  category: string;
  description: string;
  quantity: number;
  unit_amount_minor: number;
  tax_minor: number;
  line_total_minor: number;
  service_date: string;
};
export const FOLIO_LINE_COLUMNS = "id, category, description, quantity, unit_amount_minor, tax_minor, line_total_minor, service_date";

export type InvoiceViewer = {
  /** invoice.issue: number the extras not yet on an invoice. */
  issue: boolean;
  /** invoice.void: withdraw an invoice. */
  void: boolean;
};

/** Posted extras that are on no live invoice: what the next invoice would cover. */
export const uninvoiced = <T extends Pick<ChargeRow, "status" | "folio_invoice_id">>(charges: T[]): T[] =>
  charges.filter((c) => c.status === "posted" && !c.folio_invoice_id);

export const uninvoicedTotalMinor = (charges: Pick<ChargeRow, "status" | "folio_invoice_id" | "total_minor">[]) =>
  uninvoiced(charges).reduce((n, c) => n + c.total_minor, 0);

export type InvoiceActions = {
  /** Offered while the folio is open, the viewer may issue, and something is left to invoice. */
  issue: boolean;
  uninvoicedCount: number;
  uninvoicedTotalMinor: number;
  /** An issued invoice, for a viewer who may void. */
  void: (i: Pick<FolioInvoiceRow, "invoice_status">) => boolean;
};

export function invoiceActions(
  folioOpen: boolean,
  charges: Pick<ChargeRow, "status" | "folio_invoice_id" | "total_minor">[],
  viewer: InvoiceViewer,
): InvoiceActions {
  const left = uninvoiced(charges);
  return {
    issue: viewer.issue && folioOpen && left.length > 0,
    uninvoicedCount: left.length,
    uninvoicedTotalMinor: left.reduce((n, c) => n + c.total_minor, 0),
    void: (i) => viewer.void && i.invoice_status === "issued",
  };
}

/** Live invoices in the order they were issued, then voided ones, most recently voided first. */
export function splitInvoices(rows: FolioInvoiceRow[]): { live: FolioInvoiceRow[]; voided: FolioInvoiceRow[] } {
  const live = rows
    .filter((i) => i.invoice_status === "issued")
    .sort((a, b) => a.issued_at.localeCompare(b.issued_at) || a.invoice_number.localeCompare(b.invoice_number));
  const voided = rows.filter((i) => i.invoice_status === "void").sort((a, b) => (b.voided_at ?? "").localeCompare(a.voided_at ?? ""));
  return { live, voided };
}

/** Which invoice number a charge is on, for the tag beside it; undefined when it is on none (or the invoice is not known). */
export function invoiceNumberOf(
  chargeInvoiceId: string | null,
  invoices: Pick<FolioInvoiceRow, "id" | "invoice_number">[],
): string | undefined {
  return chargeInvoiceId ? invoices.find((i) => i.id === chargeInvoiceId)?.invoice_number : undefined;
}

/** Where the printable invoice lives. */
export const folioInvoicePath = (reservationId: string, invoiceId: string) =>
  `/app/reservations/${reservationId}/folio-invoice/${invoiceId}`;

/** Adds up lines the way the invoice does, to show that the page agrees with the stored totals. */
export function lineTotals(lines: Pick<FolioInvoiceLine, "quantity" | "unit_amount_minor" | "tax_minor">[]): {
  subtotal: number;
  tax: number;
  total: number;
} {
  const subtotal = lines.reduce((n, l) => n + l.quantity * l.unit_amount_minor, 0);
  const tax = lines.reduce((n, l) => n + l.tax_minor, 0);
  return { subtotal, tax, total: subtotal + tax };
}
