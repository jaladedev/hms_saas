import { describe, expect, it } from "vitest";
import { adrMinor, formatBp, isQuietDay, occupancyBp, revparMinor, type OccupancyDay, type OccupancyReport } from "./occupancy";
import { occupancyCsv, occupancyFileName } from "./occupancy-csv";

const day = (over: Partial<OccupancyDay> = {}): OccupancyDay => ({
  date: "2026-11-03",
  rooms_total: 10,
  rooms_blocked: 0,
  rooms_available: 10,
  rooms_sold: 0,
  room_revenue_minor: 0,
  arrivals: 0,
  departures: 0,
  no_shows: 0,
  ...over,
});

describe("occupancy, ADR and RevPAR", () => {
  it("works occupancy out in hundredths of a percent, rounding half up", () => {
    expect(occupancyBp(day({ rooms_sold: 7, rooms_available: 10 }))).toBe(7000);
    expect(occupancyBp(day({ rooms_sold: 1, rooms_available: 3 }))).toBe(3333);
    expect(occupancyBp(day({ rooms_sold: 2, rooms_available: 3 }))).toBe(6667);
    expect(occupancyBp(day({ rooms_sold: 10, rooms_available: 10 }))).toBe(10000);
    expect(occupancyBp(day({ rooms_sold: 0, rooms_available: 10 }))).toBe(0);
  });
  it("has no answer when there is nothing to divide by", () => {
    expect(occupancyBp(day({ rooms_available: 0 }))).toBeNull();
    expect(revparMinor(day({ rooms_available: 0, room_revenue_minor: 5 }))).toBeNull();
    expect(adrMinor(day({ rooms_sold: 0 }))).toBeNull();
  });
  it("divides revenue by sold nights for ADR and by available nights for RevPAR", () => {
    const d = day({ rooms_sold: 4, rooms_available: 10, room_revenue_minor: 1_000_000 });
    expect(adrMinor(d)).toBe(250_000);
    expect(revparMinor(d)).toBe(100_000);
    expect(adrMinor(day({ rooms_sold: 3, rooms_available: 3, room_revenue_minor: 100 }))).toBe(33);
    expect(adrMinor(day({ rooms_sold: 3, rooms_available: 3, room_revenue_minor: 101 }))).toBe(34);
  });
  it("does not lose precision on big sums", () => {
    expect(adrMinor(day({ rooms_sold: 92 * 40, rooms_available: 92 * 50, room_revenue_minor: 92 * 40 * 4_500_000 }))).toBe(4_500_000);
  });
});

describe("formatBp", () => {
  it("writes a short percentage", () => {
    expect(formatBp(7340)).toBe("73.4%");
    expect(formatBp(3333)).toBe("33.33%");
    expect(formatBp(10000)).toBe("100%");
    expect(formatBp(0)).toBe("0%");
    expect(formatBp(5)).toBe("0.05%");
    expect(formatBp(null)).toBe("–");
  });
});

describe("isQuietDay", () => {
  it("is quiet only when nothing is sold, arriving, leaving or missed", () => {
    expect(isQuietDay(day())).toBe(true);
    for (const k of ["rooms_sold", "arrivals", "departures", "no_shows"] as const) expect(isQuietDay(day({ [k]: 1 })), k).toBe(false);
  });
});

describe("occupancyCsv", () => {
  const report: OccupancyReport = {
    property_id: "p",
    currency: "NGN",
    timezone: "Africa/Lagos",
    from: "2026-11-03",
    to: "2026-11-04",
    days: [
      day({ rooms_sold: 4, rooms_available: 10, room_revenue_minor: 1_000_000, arrivals: 2 }),
      day({ date: "2026-11-04", rooms_available: 0, rooms_total: 0 }),
    ],
    totals: {
      rooms_total: 10,
      rooms_blocked: 0,
      rooms_available: 10,
      rooms_sold: 4,
      room_revenue_minor: 1_000_000,
      arrivals: 2,
      departures: 0,
      no_shows: 0,
    },
  };
  it("writes a header, a row per day and a total, with blanks where a ratio has no answer", () => {
    const lines = occupancyCsv(report).split("\r\n");
    expect(lines[0]).toBe("Date,Rooms in service,Blocked,Available,Sold,Occupancy %,Room revenue,ADR,RevPAR,Arrivals,Departures,No-shows");
    expect(lines[1]).toBe("2026-11-03,10,0,10,4,40.00,10000.00,2500.00,1000.00,2,0,0");
    expect(lines[2]).toBe("2026-11-04,0,0,0,0,,0.00,,,0,0,0");
    expect(lines[3]).toBe("Total,10,0,10,4,40.00,10000.00,2500.00,1000.00,2,0,0");
    expect(lines[4]).toBe("");
  });
  it("names the file after the hotel and the range", () => {
    expect(occupancyFileName("Hotel A (Ibadan)!", "2026-11-01", "2026-11-30")).toBe(
      "occupancy-hotel-a-ibadan-2026-11-01-to-2026-11-30.csv",
    );
    expect(occupancyFileName("???", "2026-11-01", "2026-11-02")).toBe("occupancy-hotel-2026-11-01-to-2026-11-02.csv");
  });
});
