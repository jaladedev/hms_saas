import { describe, expect, it } from "vitest";
import { LEDGER_PAGE, MAX_LEDGER_ROWS, csvText, ledgerCsv, ledgerFileName, type LedgerRow } from "./ledger-csv";

const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  entry_at: "2026-11-24T14:05:44.123+00:00",
  entry_day: "2026-11-24",
  kind: "booking_payment",
  internal_reference: "PAY-1",
  provider_reference: "ps_abc",
  booking_reference: "BK-1",
  guest_name: "Ada Obi",
  method: "bank_transfer",
  provider: "paystack",
  group_reference: null,
  amount_minor: 150000,
  currency: "NGN",
  note: null,
  ...over,
});
const HEAD =
  "Date,Time (UTC),Type,Booking,Guest,Method,Online provider,Reference,Provider reference,Company payment reference,Amount,Currency,Note";
const lines = (csv: string) => csv.split("\n");
/** Line n of a CSV, and one comma-separated cell of it, as strings (an index past the end is an empty string, never undefined). */
const line = (csv: string, n: number): string => lines(csv)[n] ?? "";
const cell = (csv: string, n: number, col: number): string => line(csv, n).split(",")[col] ?? "";

describe("ledgerCsv", () => {
  it("is just the header for an empty period", () => {
    expect(ledgerCsv([])).toBe(`${HEAD}\n`);
  });

  it("writes one payment as readable words and exact money", () => {
    expect(line(ledgerCsv([row()]), 1)).toBe(
      "2026-11-24,2026-11-24 14:05,Booking payment,BK-1,Ada Obi,Bank transfer,paystack,PAY-1,ps_abc,,1500.00,NGN,",
    );
  });

  it("shows money paid back as a negative number, left as a real number (not text)", () => {
    const out =
      lines(
        ledgerCsv([
          row({ kind: "refund", amount_minor: -150000, method: null, provider: null, provider_reference: null, note: "guest cancelled" }),
        ]),
      )[1] ?? "";
    expect(out).toBe("2026-11-24,2026-11-24 14:05,Refund,BK-1,Ada Obi,,,PAY-1,,,-1500.00,NGN,guest cancelled");
    expect(out.split(",")[10]).toBe("-1500.00");
  });

  it("labels the three kinds and the manual methods, and passes an unknown method through", () => {
    const out = ledgerCsv([
      row({ kind: "extras_payment", method: "cash" }),
      row({ method: "pos" }),
      row({ method: "other" }),
      row({ method: "mobile_money" }),
    ]);
    const cells = lines(out)
      .slice(1, 5)
      .map((l) => l.split(","));
    expect(cells.map((c) => c[2])).toEqual(["Extras payment", "Booking payment", "Booking payment", "Booking payment"]);
    expect(cells.map((c) => c[5])).toEqual(["Cash", "POS", "Other", "mobile_money"]);
  });

  it("carries the company payment reference of a share of one", () => {
    expect(cell(ledgerCsv([row({ group_reference: "BANK-77" })]), 1, 9)).toBe("BANK-77");
  });

  it("keeps whole kobo exactly, with no floating point", () => {
    const amounts = [1, 99, 100, 101, 1999999, 1000000001].map((a) => cell(ledgerCsv([row({ amount_minor: a })]), 1, 10));
    expect(amounts).toEqual(["0.01", "0.99", "1.00", "1.01", "19999.99", "10000000.01"]);
  });

  it("quotes commas, quotes and line breaks in free text", () => {
    const out = ledgerCsv([row({ guest_name: 'Obi, Ada "Dee"', note: "line one\nline two" })]);
    expect(out).toContain('"Obi, Ada ""Dee"""');
    expect(out).toContain('"line one\nline two"');
  });

  it("leaves empty fields empty and writes an unreadable time as empty", () => {
    const out = line(ledgerCsv([row({ guest_name: null, booking_reference: null, entry_at: "not a time" })]), 1).split(",");
    expect(out[1]).toBe("");
    expect(out[3]).toBe("");
    expect(out[4]).toBe("");
  });

  it("states the time in UTC whatever offset it arrives with", () => {
    expect(cell(ledgerCsv([row({ entry_at: "2026-11-24T15:05:44+01:00" })]), 1, 1)).toBe("2026-11-24 14:05");
  });
});

describe("spreadsheet formula injection", () => {
  const lead = ["=1+1", "+1", "@SUM(A1)", "-2+3", "\tx", "\rx"];
  it.each(lead)("neutralises free text that starts with %j", (text) => {
    expect(csvText(text).replace(/^"/, "").startsWith("'")).toBe(true);
  });
  it("does it in every free-text column, including the guest name, references and note", () => {
    const out = ledgerCsv([
      row({
        guest_name: "=cmd",
        booking_reference: "+BK",
        internal_reference: "@PAY",
        provider_reference: "-ref",
        group_reference: "=g",
        note: "-note",
      }),
    ]);
    const cells = line(out, 1).split(",");
    expect(cells[3]).toBe("'+BK");
    expect(cells[4]).toBe("'=cmd");
    expect(cells[7]).toBe("'@PAY");
    expect(cells[8]).toBe("'-ref");
    expect(cells[9]).toBe("'=g");
    expect(cells[12]).toBe("'-note");
  });
  it("does not touch a minus that is part of the text, or the sign of an amount", () => {
    expect(csvText("Ada-Obi")).toBe("Ada-Obi");
    expect(csvText("")).toBe("");
    expect(csvText(null)).toBe("");
    expect(cell(ledgerCsv([row({ amount_minor: -5 })]), 1, 10)).toBe("-0.05");
  });
});

describe("ledgerFileName and limits", () => {
  it("makes a safe file name from the hotel and the period", () => {
    expect(ledgerFileName("Hotel Éclat & Spa!", "2026-11-01", "2026-11-24")).toBe("ledger-hotel-clat-spa-2026-11-01-to-2026-11-24.csv");
    expect(ledgerFileName("???", "2026-11-01", "2026-11-24")).toBe("ledger-hotel-2026-11-01-to-2026-11-24.csv");
  });
  it("reads in pages the API can return and refuses more rows than one file holds", () => {
    expect(LEDGER_PAGE).toBeLessThanOrEqual(1000);
    expect(MAX_LEDGER_ROWS % LEDGER_PAGE).toBe(0);
  });
});
