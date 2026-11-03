import { describe, expect, it } from "vitest";
import { csvField, csvFileName, major } from "./reports-csv";

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

describe("csvFileName", () => {
  it("is a safe, readable name", () => {
    expect(csvFileName("Grand Hotel & Spa (Lekki)", "2026-11-01", "2026-11-07")).toBe("report-grand-hotel-spa-lekki-2026-11-01-to-2026-11-07.csv");
    expect(csvFileName("???", "2026-11-01", "2026-11-01")).toBe("report-hotel-2026-11-01-to-2026-11-01.csv");
  });
});
