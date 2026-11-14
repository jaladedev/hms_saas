import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/** Everything a confirmation shows, as plain values. Money is in minor units (kobo); nothing here is looked up or recalculated. */
export type ConfirmationDoc = {
  hotelName: string;
  hotelAddress: string | null; // one line, such as "12 Ring Rd, Ibadan, Oyo"
  hotelPhone: string | null;
  hotelEmail: string | null;
  reference: string;
  statusLabel: string; // "Confirmed", "Checked in", "Checked out"
  guestName: string | null;
  arrival: string; // already formatted, such as "Tue 3 Nov 2026"
  departure: string;
  nights: number;
  checkIn: string; // "14:00"
  checkOut: string;
  rooms: { label: string; adults: number; children: number }[];
  currency: string;
  /** Optional breakdown lines (room charges, tax, discount); the total is always shown. */
  lines: { label: string; minor: number }[];
  totalMinor: number;
  paidMinor: number;
  outstandingMinor: number | null; // null hides the line
};

/**
 * The standard PDF fonts can only write Latin-1 characters. Anything else (for example the naira sign, or a name in another script)
 * is replaced with "?" rather than failing the whole download.
 */
export function pdfSafe(text: string, font: Pick<PDFFont, "getCharacterSet">): string {
  const ok = new Set(font.getCharacterSet());
  let out = "";
  for (const ch of text.replace(/[\r\n\t]+/g, " ")) {
    const cp = ch.codePointAt(0) ?? 63;
    out += ok.has(cp) ? ch : "?";
  }
  return out;
}

/** "NGN 25,000.00": the currency code, because the naira sign is not in the standard fonts. */
export function pdfMoney(minor: number, currency: string): string {
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${minor < 0 ? "-" : ""}${currency} ${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** Breaks text into lines no wider than maxWidth, splitting very long words. */
export function wrapText(text: string, font: Pick<PDFFont, "widthOfTextAtSize">, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  const push = (word: string) => {
    const test = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) <= maxWidth) {
      line = test;
      return;
    }
    if (line) lines.push(line);
    line = "";
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > maxWidth && rest.length > 1) {
      let n = rest.length - 1;
      while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > maxWidth) n--;
      lines.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    line = rest;
  };
  for (const w of text.split(" ")) if (w) push(w);
  if (line) lines.push(line);
  return lines;
}

const A4: [number, number] = [595.28, 841.89];
const M = 56;

/** Builds a one-page (or more, when the rooms list is long) A4 confirmation. Throws only if the PDF library itself fails. */
export async function buildConfirmationPdf(doc: ConfirmationDoc): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const safe = (t: string) => pdfSafe(t, font);
  pdf.setTitle(safe(`Booking confirmation ${doc.reference}`));
  pdf.setCreator("HMS");
  pdf.setProducer("HMS");

  let page: PDFPage = pdf.addPage(A4);
  let y = A4[1] - M;
  const width = A4[0] - 2 * M;
  const ink = rgb(0.1, 0.1, 0.1);
  const muted = rgb(0.4, 0.4, 0.4);

  const need = (h: number) => {
    if (y - h < M) {
      page = pdf.addPage(A4);
      y = A4[1] - M;
    }
  };
  const text = (t: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; right?: boolean } = {}) => {
    const size = opts.size ?? 10;
    const f = opts.bold ? bold : font;
    const s = pdfSafe(t, f);
    const w = f.widthOfTextAtSize(s, size);
    const x = opts.right ? A4[0] - M - w : (opts.x ?? M);
    page.drawText(s, { x, y, size, font: f, color: opts.color ?? ink });
  };
  const paragraph = (t: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb> } = {}) => {
    const size = opts.size ?? 10;
    for (const l of wrapText(safe(t), opts.bold ? bold : font, size, width)) {
      need(size + 4);
      text(l, opts);
      y -= size + 4;
    }
  };
  const rule = () => {
    need(10);
    page.drawLine({ start: { x: M, y }, end: { x: A4[0] - M, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
    y -= 12;
  };
  const row = (label: string, value: string, strong = false) => {
    need(16);
    text(label, { color: strong ? ink : muted, bold: strong });
    text(value, { right: true, bold: strong });
    y -= 16;
  };

  // letterhead
  paragraph(doc.hotelName, { size: 18, bold: true });
  if (doc.hotelAddress) paragraph(doc.hotelAddress, { color: muted });
  const contact = [doc.hotelPhone, doc.hotelEmail].filter(Boolean).join("  |  ");
  if (contact) paragraph(contact, { color: muted });
  y -= 10;
  paragraph("Booking confirmation", { size: 14, bold: true });
  y -= 4;
  rule();

  row("Booking reference", doc.reference, true);
  row("Status", doc.statusLabel);
  if (doc.guestName) row("Guest", doc.guestName);
  row("Check-in", `${doc.arrival}, from ${doc.checkIn}`);
  row("Check-out", `${doc.departure}, by ${doc.checkOut}`);
  row("Length of stay", `${doc.nights} ${doc.nights === 1 ? "night" : "nights"}`);
  y -= 4;
  rule();

  if (doc.rooms.length > 0) {
    need(20);
    text("Rooms", { bold: true });
    y -= 16;
    for (const r of doc.rooms) {
      const guests = `${r.adults} ${r.adults === 1 ? "adult" : "adults"}${r.children ? `, ${r.children} ${r.children === 1 ? "child" : "children"}` : ""}`;
      row(r.label, guests);
    }
    y -= 4;
    rule();
  }

  for (const l of doc.lines) row(l.label, pdfMoney(l.minor, doc.currency));
  row("Total", pdfMoney(doc.totalMinor, doc.currency), true);
  row("Paid", pdfMoney(doc.paidMinor, doc.currency));
  if (doc.outstandingMinor !== null) row("Still to pay", pdfMoney(doc.outstandingMinor, doc.currency));
  y -= 10;
  rule();
  paragraph("Keep this confirmation and show your booking reference at check-in. Prices are shown in " + doc.currency + ".", {
    size: 9,
    color: muted,
  });

  return pdf.save();
}

/** A safe download name: letters, digits and dashes only. */
export function confirmationFilename(reference: string): string {
  const clean = reference.replace(/[^A-Za-z0-9-]/g, "").slice(0, 40);
  return `booking-confirmation-${clean || "booking"}.pdf`;
}
