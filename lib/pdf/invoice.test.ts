import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildInvoicePdf, invoiceFilename, type InvoiceDoc } from "./invoice";

const line = (i: number) => ({
  date: "Tue 3 Nov 2026",
  description: `Deluxe room night ${i} with a rather long description that has to wrap onto a second line in the table`,
  quantity: 1,
  unitMinor: 5000000,
  taxMinor: 375000,
  totalMinor: 5375000,
});
const doc: InvoiceDoc = {
  hotelName: "Grand Ibadan Hotel ₦",
  hotelAddress: "12 Ring Road, Ibadan, Oyo",
  hotelPhone: "+234 800 000 0000",
  hotelEmail: "hello@example.com",
  invoiceNumber: "INV-GIH-2026-000001",
  issuedOn: "Tue 3 Nov 2026",
  reference: "BK-2026-0001",
  guestName: "Ada Obi",
  currency: "NGN",
  lines: [line(1), { ...line(2), quantity: 2, taxMinor: 0 }],
  subtotalMinor: 10000000,
  discountMinor: 500000,
  serviceMinor: 300000,
  taxMinor: 700000,
  totalMinor: 10500000,
  voided: null,
};

describe("buildInvoicePdf", () => {
  it("makes a readable one-page PDF with the title set", async () => {
    const bytes = await buildInvoicePdf(doc);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPageCount()).toBe(1);
    expect(parsed.getTitle()).toBe("Invoice INV-GIH-2026-000001");
  });
  it("adds pages when there are many lines", async () => {
    const many = { ...doc, lines: Array.from({ length: 60 }, (_, i) => line(i)) };
    const parsed = await PDFDocument.load(await buildInvoicePdf(many));
    expect(parsed.getPageCount()).toBeGreaterThan(1);
  });
  it("handles a void invoice, no guest, no lines and characters the font cannot write", async () => {
    const bytes = await buildInvoicePdf({
      ...doc,
      guestName: null,
      lines: [],
      voided: { reason: "Issued twice ₦ 日本" },
      discountMinor: 0,
      serviceMinor: 0,
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});

describe("invoiceFilename", () => {
  it("keeps letters, digits and dashes", () => {
    expect(invoiceFilename("INV-GIH-2026-000001")).toBe("invoice-INV-GIH-2026-000001.pdf");
    expect(invoiceFilename('../a"b c')).toBe("invoice-ab c".replace(" ", "") + ".pdf");
    expect(invoiceFilename("")).toBe("invoice-invoice.pdf");
  });
});
