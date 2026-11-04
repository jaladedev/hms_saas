import { describe, expect, it } from "vitest";
import { countryLabel, lostBp, parseKind, shareBp, sourceLabel, type ChannelReport, type GuestReport } from "./channels";
import { channelsCsv, channelsFileName, guestsCsv } from "./channels-csv";

describe("shares", () => {
  it("rounds half up in hundredths of a percent and has no answer for an empty whole", () => {
    expect(shareBp(1, 3)).toBe(3333);
    expect(shareBp(2, 3)).toBe(6667);
    expect(shareBp(5, 5)).toBe(10000);
    expect(shareBp(0, 5)).toBe(0);
    expect(shareBp(0, 0)).toBeNull();
  });
  it("counts cancelled and no-shows against everything that was due", () => {
    expect(lostBp({ bookings: 6, cancelled: 3, no_shows: 1 })).toBe(4000);
    expect(lostBp({ bookings: 0, cancelled: 0, no_shows: 0 })).toBeNull();
    expect(lostBp({ bookings: 0, cancelled: 2, no_shows: 0 })).toBe(10000);
  });
});

describe("labels", () => {
  it("names sources and countries, and copes with the unknown ones", () => {
    expect(sourceLabel("walk_in")).toBe("Walk-in");
    expect(sourceLabel("something_new")).toBe("something_new");
    expect(countryLabel("NG")).toBe("Nigeria");
    expect(countryLabel("gh")).toBe("Ghana");
    expect(countryLabel("unknown")).toBe("No country recorded");
    expect(countryLabel("???")).toBe("???");
  });
  it("reads the csv kind, defaulting to channels", () => {
    expect(parseKind("guests")).toBe("guests");
    expect(parseKind("channels")).toBe("channels");
    expect(parseKind("x")).toBe("channels");
    expect(parseKind(null)).toBe("channels");
  });
});

const channels: ChannelReport = {
  property_id: "p", currency: "NGN", from: "2026-11-01", to: "2026-11-30",
  rows: [
    { source: "website", bookings: 3, room_nights: 6, room_revenue_minor: 3_000_000, cancelled: 1, no_shows: 0 },
    { source: "phone", bookings: 0, room_nights: 0, room_revenue_minor: 0, cancelled: 0, no_shows: 0 },
  ],
  totals: { bookings: 3, room_nights: 6, room_revenue_minor: 3_000_000, cancelled: 1, no_shows: 0 },
};

describe("channelsCsv", () => {
  it("writes a row per source and a total, with blanks where a share has no answer", () => {
    const l = channelsCsv(channels).split("\r\n");
    expect(l[0]).toBe("Source,Bookings,Room nights,Room revenue,Share of revenue %,Cancelled,No-shows,Cancelled or no-show %");
    expect(l[1]).toBe("Website,3,6,30000.00,100.00,1,0,25.00");
    expect(l[2]).toBe("Phone,0,0,0.00,0.00,0,0,");
    expect(l[3]).toBe("Total,3,6,30000.00,100.00,1,0,25.00");
  });
});

describe("guestsCsv", () => {
  const g: GuestReport = {
    property_id: "p", currency: "NGN", from: "2026-11-01", to: "2026-11-30", guests_total: 3, guests_new: 2, guests_returning: 1,
    countries: [{ country: "NG", guests: 2, room_nights: 5 }, { country: "unknown", guests: 1, room_nights: 1 }],
    top_guests: [{ guest_id: "g", name: "=Evil, Ada", stays: 2, room_nights: 3, room_revenue_minor: 750_000 }], names_hidden: false,
  };
  it("writes the summary, countries and top guests, neutralising names a spreadsheet would run", () => {
    const text = guestsCsv(g);
    expect(text).toContain("Guests,New,Returning\r\n3,2,1\r\n");
    expect(text).toContain("Nigeria,2,5");
    expect(text).toContain("No country recorded,1,1");
    expect(text).toContain(`"'=Evil, Ada",2,3,7500.00`);
  });
  it("leaves the names out when the caller may not see them", () => {
    const text = guestsCsv({ ...g, top_guests: [], names_hidden: true });
    expect(text).not.toContain("Top guest");
    expect(text).toContain("Country,Guests,Room nights");
  });
});

describe("channelsFileName", () => {
  it("names the file after the kind, the hotel and the range", () => {
    expect(channelsFileName("guests", "Hotel A!", "2026-11-01", "2026-11-30")).toBe("guests-hotel-a-2026-11-01-to-2026-11-30.csv");
  });
});
