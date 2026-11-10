import { describe, expect, it } from "vitest";
import { channelsFileName } from "./channels-csv";
import { chargedMinor, chargeLabel, isCut, noShowsCsv, type NoShowList, type NoShowRow } from "./no-shows";

const row = (over: Partial<NoShowRow> = {}): NoShowRow => ({
  reservation_id: "r1",
  booking_reference: "HMS-1001",
  arrival_date: "2026-11-02",
  nights: 2,
  source: "phone",
  guest_name: "Ade Bello",
  charge_minor: 2_500_000,
  ...over,
});
const list = (over: Partial<NoShowList> = {}): NoShowList => ({
  property_id: "p",
  currency: "NGN",
  from: "2026-11-01",
  to: "2026-11-30",
  total: 2,
  rows: [
    row(),
    row({
      reservation_id: "r2",
      booking_reference: "HMS-1002",
      arrival_date: "2026-11-01",
      nights: 1,
      source: "walk_in",
      guest_name: 'Ngozi, "Nana" Okoye',
      charge_minor: 0,
    }),
  ],
  names_hidden: false,
  links_hidden: false,
  ...over,
});
const naira = (n: number) => `₦${n / 100}`;

describe("charge wording and totals", () => {
  it("shows a dash when nothing was charged", () => {
    expect(chargeLabel(0, naira)).toBe("–");
    expect(chargeLabel(2_500_000, naira)).toBe("₦25000");
  });
  it("adds the charges of the rows shown", () => {
    expect(chargedMinor(list().rows)).toBe(2_500_000);
    expect(chargedMinor([])).toBe(0);
  });
  it("says the list is cut only when the real count is higher than the rows", () => {
    expect(isCut(list())).toBe(false);
    expect(isCut(list({ total: 250 }))).toBe(true);
  });
});

describe("noShowsCsv", () => {
  it("writes every column, quoting names, with money in naira", () => {
    expect(noShowsCsv(list())).toBe(
      "Arrival,Nights,Source,Booking,Guest,Charge\r\n" +
        "2026-11-02,2,Phone,HMS-1001,Ade Bello,25000.00\r\n" +
        '2026-11-01,1,Walk-in,HMS-1002,"Ngozi, ""Nana"" Okoye",0.00\r\n',
    );
  });
  it("leaves out the guest column without guest.view and the booking column without reservation.view", () => {
    const hidden = noShowsCsv(
      list({
        names_hidden: true,
        links_hidden: true,
        rows: list().rows.map((r) => ({ ...r, guest_name: null, booking_reference: null, reservation_id: null })),
      }),
    );
    expect(hidden.split("\r\n")[0]).toBe("Arrival,Nights,Source,Charge");
    expect(hidden).not.toContain("Ade");
    expect(hidden).not.toContain("HMS-");
    expect(noShowsCsv(list({ names_hidden: true })).split("\r\n")[0]).toBe("Arrival,Nights,Source,Booking,Charge");
  });
  it("is a header alone for an empty list, and the file name says noshows", () => {
    expect(noShowsCsv(list({ total: 0, rows: [] }))).toBe("Arrival,Nights,Source,Booking,Guest,Charge\r\n");
    expect(channelsFileName("noshows", "Grand Hotel", "2026-11-01", "2026-11-30")).toBe("noshows-grand-hotel-2026-11-01-to-2026-11-30.csv");
  });
});
