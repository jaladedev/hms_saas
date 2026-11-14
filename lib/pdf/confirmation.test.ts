import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildConfirmationPdf, confirmationFilename, pdfMoney, pdfSafe, wrapText, type ConfirmationDoc } from "./confirmation";

const doc: ConfirmationDoc = {
  hotelName: "Grand Ibadan Hotel ₦",
  hotelAddress: "12 Ring Road, Ibadan, Oyo",
  hotelPhone: "+234 800 000 0000",
  hotelEmail: "hello@example.com",
  reference: "BK-2026-0001",
  statusLabel: "Confirmed",
  guestName: "Ada Obi",
  arrival: "Tue 3 Nov 2026",
  departure: "Thu 5 Nov 2026",
  nights: 2,
  checkIn: "14:00",
  checkOut: "12:00",
  rooms: [{ label: "Deluxe", adults: 2, children: 1 }],
  currency: "NGN",
  lines: [
    { label: "Rooms", minor: 5000000 },
    { label: "Tax", minor: 375000 },
  ],
  totalMinor: 5375000,
  paidMinor: 1000000,
  outstandingMinor: 4375000,
};

describe("pdfMoney", () => {
  it("writes the code, thousands and two decimals", () => {
    expect(pdfMoney(2500000, "NGN")).toBe("NGN 25,000.00");
    expect(pdfMoney(5, "NGN")).toBe("NGN 0.05");
    expect(pdfMoney(-150, "USD")).toBe("-USD 1.50");
  });
});

describe("pdfSafe", () => {
  it("replaces characters the standard font cannot write", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    expect(pdfSafe("Café ₦ 日本", font)).toBe("Café ? ??");
    expect(pdfSafe("a\nb\tc", font)).toBe("a b c");
  });
});

describe("wrapText", () => {
  const font = { widthOfTextAtSize: (t: string, s: number) => t.length * s * 0.5 };
  it("wraps at the width and splits a word that is too long", () => {
    expect(wrapText("aaa bbb ccc", font, 10, 20)).toEqual(["aaa", "bbb", "ccc"]);
    expect(wrapText("aaaaaaaaaa", font, 10, 20)).toEqual(["aaaa", "aaaa", "aa"]);
    expect(wrapText("", font, 10, 20)).toEqual([]);
  });
});

describe("buildConfirmationPdf", () => {
  it("makes a readable PDF even when the name has characters the font lacks", async () => {
    const bytes = await buildConfirmationPdf(doc);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
    expect(loaded.getTitle()).toBe("Booking confirmation BK-2026-0001");
  });
  it("runs onto a second page for a very long list of rooms", async () => {
    const many = { ...doc, rooms: Array.from({ length: 60 }, (_, i) => ({ label: `Room type ${i}`, adults: 2, children: 0 })) };
    const loaded = await PDFDocument.load(await buildConfirmationPdf(many));
    expect(loaded.getPageCount()).toBeGreaterThan(1);
  });
  it("handles a missing guest, no outstanding line and no contact details", async () => {
    const bare = {
      ...doc,
      guestName: null,
      outstandingMinor: null,
      hotelAddress: null,
      hotelPhone: null,
      hotelEmail: null,
      lines: [],
      rooms: [],
    };
    const loaded = await PDFDocument.load(await buildConfirmationPdf(bare));
    expect(loaded.getPageCount()).toBe(1);
  });
});

describe("confirmationFilename", () => {
  it("keeps only safe characters", () => {
    expect(confirmationFilename("BK-2026-0001")).toBe("booking-confirmation-BK-2026-0001.pdf");
    expect(confirmationFilename('../a b"c')).toBe("booking-confirmation-abc.pdf");
    expect(confirmationFilename("")).toBe("booking-confirmation-booking.pdf");
  });
});
