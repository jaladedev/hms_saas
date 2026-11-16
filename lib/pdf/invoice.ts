import { PDFDocument, StandardFonts, rgb, type PDFPage } from "pdf-lib";
import { pdfMoney, pdfSafe, wrapText } from "./confirmation";

const A4: [number, number] = [595.28, 841.89];
const M = 56;

/** Everything an invoice shows, as plain values saved on the invoice. Money is in minor units (kobo); nothing is looked up or recalculated. */
export type InvoiceDoc = {
  hotelName: string;
  hotelAddress: string | null;
  hotelPhone: string | null;
  hotelEmail: string | null;
  invoiceNumber: string;
  issuedOn: string; // already formatted, such as "Tue 3 Nov 2026"
  reference: string; // booking reference
  guestName: string | null;
  currency: string;
  lines: { date: string | null; description: string; quantity: number; unitMinor: number; taxMinor: number; totalMinor: number }[];
  subtotalMinor: number;
  discountMinor: number;
  serviceMinor: number;
  /** Tax without the service charge, which has its own line. */
  taxMinor: number;
  totalMinor: number;
  /** Set for a withdrawn invoice: the page is marked VOID and the reason, if any, is printed. */
  voided: { reason: string | null } | null;
};

/** Builds an A4 invoice, adding pages when there are many lines. Throws only if the PDF library itself fails. */
export async function buildInvoicePdf(doc: InvoiceDoc): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  pdf.setTitle(pdfSafe(`Invoice ${doc.invoiceNumber}`, font));
  pdf.setCreator("HMS");
  pdf.setProducer("HMS");

  let page: PDFPage = pdf.addPage(A4);
  let y = A4[1] - M;
  const right = A4[0] - M;
  const width = right - M;
  const ink = rgb(0.1, 0.1, 0.1);
  const muted = rgb(0.4, 0.4, 0.4);
  const red = rgb(0.7, 0.1, 0.1);

  type Opts = { size?: number; bold?: boolean; color?: ReturnType<typeof rgb> };
  const need = (h: number) => {
    if (y - h < M) {
      page = pdf.addPage(A4);
      y = A4[1] - M;
    }
  };
  const put = (t: string, x: number, o: Opts = {}) => {
    const f = o.bold ? bold : font;
    page.drawText(pdfSafe(t, f), { x, y, size: o.size ?? 10, font: f, color: o.color ?? ink });
  };
  const putRight = (t: string, edge: number, o: Opts = {}) => {
    const f = o.bold ? bold : font;
    const s = pdfSafe(t, f);
    page.drawText(s, { x: edge - f.widthOfTextAtSize(s, o.size ?? 10), y, size: o.size ?? 10, font: f, color: o.color ?? ink });
  };
  const paragraph = (t: string, o: Opts = {}) => {
    const size = o.size ?? 10;
    for (const l of wrapText(pdfSafe(t, o.bold ? bold : font), o.bold ? bold : font, size, width)) {
      need(size + 4);
      put(l, M, o);
      y -= size + 4;
    }
  };
  const rule = () => {
    need(10);
    page.drawLine({ start: { x: M, y }, end: { x: right, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
    y -= 12;
  };
  const row = (label: string, value: string, strong = false) => {
    need(16);
    put(label, M, { color: strong ? ink : muted, bold: strong });
    putRight(value, right, { bold: strong });
    y -= 16;
  };

  paragraph(doc.hotelName, { size: 18, bold: true });
  if (doc.hotelAddress) paragraph(doc.hotelAddress, { color: muted });
  const contact = [doc.hotelPhone, doc.hotelEmail].filter(Boolean).join("  |  ");
  if (contact) paragraph(contact, { color: muted });
  y -= 10;
  paragraph(doc.voided ? `Invoice ${doc.invoiceNumber} (VOID)` : `Invoice ${doc.invoiceNumber}`, {
    size: 14,
    bold: true,
    color: doc.voided ? red : ink,
  });
  if (doc.voided) {
    paragraph(
      `This invoice was withdrawn${doc.voided.reason ? `: ${doc.voided.reason.replace(/[.\s]+$/, "")}.` : "."} It is kept for the record and is not valid.`,
      {
        color: red,
      },
    );
  }
  y -= 4;
  rule();
  row("Invoice date", doc.issuedOn);
  row("Booking reference", doc.reference);
  if (doc.guestName) row("Billed to", doc.guestName);
  y -= 4;
  rule();

  // lines table: date | description | tax | amount
  const colDesc = M + 78;
  const colTaxRight = right - 78;
  const descWidth = colTaxRight - 70 - colDesc;
  const header = () => {
    need(20);
    put("Date", M, { bold: true, color: muted });
    put("Description", colDesc, { bold: true, color: muted });
    putRight("Tax", colTaxRight, { bold: true, color: muted });
    putRight("Amount", right, { bold: true, color: muted });
    y -= 14;
  };
  header();
  for (const l of doc.lines) {
    const text = l.quantity > 1 ? `${l.description} x ${l.quantity}` : l.description;
    const parts = wrapText(pdfSafe(text, font), font, 10, descWidth);
    if (y - 14 * Math.max(parts.length, 1) < M) {
      need(1e9);
      header();
    }
    if (l.date) put(l.date, M, { size: 9, color: muted });
    parts.forEach((p, i) => {
      put(p, colDesc);
      if (i === 0) {
        putRight(l.taxMinor > 0 ? pdfMoney(l.taxMinor, doc.currency) : "-", colTaxRight);
        putRight(pdfMoney(l.totalMinor, doc.currency), right);
      }
      y -= 14;
    });
    if (parts.length === 0) y -= 14;
  }
  y -= 2;
  rule();
  row("Before tax", pdfMoney(doc.subtotalMinor, doc.currency));
  if (doc.discountMinor > 0) row("Discount", `-${pdfMoney(doc.discountMinor, doc.currency)}`);
  if (doc.serviceMinor > 0) row("Service charge", pdfMoney(doc.serviceMinor, doc.currency));
  row("Tax", pdfMoney(doc.taxMinor, doc.currency));
  row("Total", pdfMoney(doc.totalMinor, doc.currency), true);
  y -= 10;
  rule();
  paragraph(`Payments are shown on the receipt. Prices are in ${doc.currency}.`, { size: 9, color: muted });
  return pdf.save();
}

/** A safe download name: letters, digits and dashes only. */
export function invoiceFilename(invoiceNumber: string): string {
  const clean = invoiceNumber.replace(/[^A-Za-z0-9-]/g, "").slice(0, 40);
  return `invoice-${clean || "invoice"}.pdf`;
}
