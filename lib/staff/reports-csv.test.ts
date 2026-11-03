import { describe, expect, it } from "vitest";
import { csvField, csvFileName, major, reportCsv } from "./reports-csv";
import type { Report, ReportDay } from "./reports";

const day = (over: Partial<ReportDay> = {}): ReportDay => ({
  date: "2026-11-03", online_minor: 0, cash_minor: 0, bank_transfer_minor: 0, pos_minor: 0, other_minor: 0, received_minor: 0, refunded_minor: 0, net_minor: 0,
  room_revenue_minor: 0, room_tax_minor: 0, extras_minor: 0, extras_tax_minor: 0, cancellation_charges_minor: 0, ...over,
});

describe("major", () => {
  it("writes kobo as naira exactly", () => {
    expect(major(0)).toBe("0.00");
    expect(major(5)).toBe("0.05");
    expect(major(123450)).toBe("1234.50");
    expect(major(-250)).toBe("-2.50");
    expect(major(100000000000)).toBe("1000000000.00");
  });
});

describe("csvField", () => {
  it("quotes only what needs it and doubles quotes", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
  });
  it("neutralises text a spreadsheet would run as a formula, but leaves negative numbers alone", () => {
    for (const t of ["=1+1", "+1", "@SUM(A1)"]) expect(csvField(t), t).toBe(`'${t}`);
    expect(csvField(-5)).toBe("-5");
    expect(csvField("-2.50")).toBe("-2.50");
  });
});

describe("reportCsv", () => {
  const report: Report = {
    property_id: "p", currency: "NGN", timezone: "Africa/Lagos", from: "2026-11-02", to: "2026-11-03",
    days: [day({ date: "2026-11-02" }), day({ cash_minor: 150050, received_minor: 150050, net_minor: 150050, room_revenue_minor: 100000, room_tax_minor: 7500, extras_minor: 2000, cancellation_charges_minor: 500 })],
    totals: { ...day(), cash_minor: 150050, received_minor: 150050, net_minor: 150050, room_revenue_minor: 100000, room_tax_minor: 7500, extras_minor: 2000, cancellation_charges_minor: 500 } as never,
  };
  it("has a header, a row per day and a total row, with CRLF line ends", () => {
    const lines = reportCsv(report).split("\r\n");
    expect(lines).toHaveLength(5);                    // header, 2 days, total, trailing empty
    expect(lines[0]).toBe("Date,Online,Cash,Transfer,POS,Other,Received,Refunded,Net,Room revenue,Extras,Cancellation charges,Earned before tax,Tax");
    expect(lines[1]).toBe("2026-11-02,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00");
    expect(lines[2]).toBe("2026-11-03,0.00,1500.50,0.00,0.00,0.00,1500.50,0.00,1500.50,1000.00,20.00,5.00,1025.00,75.00");
    expect(lines[3]!.startsWith("Total,")).toBe(true);
    expect(lines[3]).toContain("1500.50");
  });
});

describe("csvFileName", () => {
  it("is a safe, readable name", () => {
    expect(csvFileName("Grand Hotel & Spa (Lekki)", "2026-11-01", "2026-11-07")).toBe("report-grand-hotel-spa-lekki-2026-11-01-to-2026-11-07.csv");
    expect(csvFileName("???", "2026-11-01", "2026-11-01")).toBe("report-hotel-2026-11-01-to-2026-11-01.csv");
  });
});
