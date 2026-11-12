import { describe, expect, it } from "vitest";
import { bookingIcs, escapeIcsText, foldIcsLine, icsFileName } from "./calendar";

const stay = {
  reference: "IBG-2026-8472",
  hotelName: "Bodija Boutique, Hotel",
  place: "12 Oyo Road, Ibadan",
  arrivalDate: "2027-01-10",
  departureDate: "2027-01-12",
  checkInTime: "14:00:00",
  checkOutTime: "12:00:00",
  rooms: ["Standard Room: 2 adults"],
};

describe("bookingIcs", () => {
  const ics = bookingIcs(stay, new Date("2026-11-12T10:15:00.000Z"));
  it("is a calendar with one all-day event from arrival to departure", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("DTSTART;VALUE=DATE:20270110\r\n");
    expect(ics).toContain("DTEND;VALUE=DATE:20270112\r\n");
    expect(ics).toContain("DTSTAMP:20261112T101500Z\r\n");
    expect(ics).toContain("UID:IBG-2026-8472@booking\r\n");
  });
  it("escapes commas in the hotel name and the place, and puts the times in the description", () => {
    expect(ics).toContain("SUMMARY:Stay at Bodija Boutique\\, Hotel\r\n");
    expect(ics).toContain("LOCATION:12 Oyo Road\\, Ibadan\r\n");
    expect(ics.replace(/\r\n /g, "")).toContain("Check in from 14:00\\, check out by 12:00.");
  });
  it("leaves out the location when the hotel has no address", () => {
    expect(bookingIcs({ ...stay, place: null })).not.toContain("LOCATION");
  });
  it("uses CRLF line ends only", () => {
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });
});

describe("escapeIcsText and foldIcsLine", () => {
  it("escapes backslash, semicolon, comma and newline", () => {
    expect(escapeIcsText("a\\b;c,d\ne")).toBe("a\\\\b;c\\,d\\ne");
  });
  it("leaves a short line alone and folds a long one at 75 bytes without splitting a character", () => {
    expect(foldIcsLine("SHORT")).toBe("SHORT");
    const long = "X:" + "₦".repeat(60);
    const folded = foldIcsLine(long);
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    for (const [i, p] of parts.entries()) {
      expect(new TextEncoder().encode(i === 0 ? p : p).length).toBeLessThanOrEqual(75);
      if (i > 0) expect(p.startsWith(" ")).toBe(true);
    }
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join("")).toBe(long);
  });
});

describe("icsFileName", () => {
  it("keeps letters, digits and hyphens only", () => {
    expect(icsFileName("IBG-2026-8472")).toBe("booking-IBG-2026-8472.ics");
    expect(icsFileName("../../etc/passwd")).toBe("booking-etcpasswd.ics");
    expect(icsFileName("///")).toBe("booking-stay.ics");
  });
});
