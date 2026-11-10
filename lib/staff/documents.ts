/** Which printable documents a booking has (UI spec page 14), and the small rules behind them. Pure, so it can be tested. */

export type DocKind = "confirmation" | "invoice" | "receipt" | "cancellation";

export const DOC_LABEL: Record<DocKind, string> = {
  confirmation: "Booking confirmation",
  invoice: "Invoice",
  receipt: "Receipt",
  cancellation: "Cancellation confirmation",
};
const ORDER: DocKind[] = ["confirmation", "invoice", "receipt", "cancellation"];

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  bank_transfer: "Bank transfer",
  pos: "Card machine",
  other: "Other",
};

export type DocInput = { status: string; invoices: number; succeededPayments: number };

/** Documents that exist for this booking, in a fixed order. A held (unpaid, unconfirmed) or expired booking has none to give. */
export function availableDocs(i: DocInput): DocKind[] {
  const out = new Set<DocKind>();
  if (["confirmed", "checked_in", "checked_out"].includes(i.status)) out.add("confirmation");
  if (i.invoices > 0) out.add("invoice");
  if (i.succeededPayments > 0) out.add("receipt");
  if (i.status === "cancelled") out.add("cancellation");
  return ORDER.filter((k) => out.has(k));
}

/** The document asked for in the address, or the first one there is. Null when the booking has none. */
export function chooseDoc(raw: unknown, available: DocKind[]): DocKind | null {
  const asked = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
  return available.find((k) => k === asked) ?? available[0] ?? null;
}

/** The invoice to print: the live one if there is one, otherwise the most recent (it prints as void). `invoices` oldest first. */
export function pickInvoice<T extends { invoice_status: string }>(invoices: T[]): T | null {
  const live = invoices.filter((i) => i.invoice_status !== "void");
  return live.at(-1) ?? invoices.at(-1) ?? null;
}

export type ReceiptPayment = { amount_minor: number; payment_status: string };

/** Money received (reversed payments leave it) and money the guest has since been refunded or is being refunded. */
export function receiptTotals(payments: ReceiptPayment[], refunds: Array<{ amount_minor: number; refund_status: string }>) {
  const received = payments.filter((p) => p.payment_status === "succeeded").reduce((s, p) => s + p.amount_minor, 0);
  const refunded = refunds.filter((r) => r.refund_status === "succeeded").reduce((s, r) => s + r.amount_minor, 0);
  const pending = refunds
    .filter((r) => ["requested", "approved", "processing"].includes(r.refund_status))
    .reduce((s, r) => s + r.amount_minor, 0);
  return { received, refunded, pending, kept: received - refunded };
}

export const REFUND_STATUS_LABEL: Record<string, string> = {
  requested: "Asked for",
  approved: "Approved",
  processing: "On its way",
  succeeded: "Paid back",
  rejected: "Declined",
  failed: "Failed",
};

export const documentsPath = (reservationId: string, kind?: DocKind) =>
  `/app/reservations/${reservationId}/documents${kind ? `?doc=${kind}` : ""}`;
