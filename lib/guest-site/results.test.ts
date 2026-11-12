import { describe, expect, it } from "vitest";
import { amenityOptions, nightlyBreakdown, parseResultsView, soldOutTypes, viewQuotes } from "./results";

const q = (name: string, total: number, occ: number, amenities: string[] = []) => ({
  name,
  total_minor: total,
  max_occupancy: occ,
  amenities,
});
const quotes = [
  q("Deluxe", 6800000, 2, ["Wi-Fi", "Balcony"]),
  q("Standard", 4500000, 2, ["wi-fi"]),
  q("Family", 9500000, 4, ["Wi-Fi", "Kitchen"]),
  q("Suite", 4500000, 3),
];

describe("parseResultsView", () => {
  it("defaults to cheapest first with no filter", () => {
    expect(parseResultsView({})).toEqual({ sort: "price_asc", minGuests: 0, amenity: null });
  });
  it("reads a valid sort, guest count and amenity, and ignores nonsense", () => {
    expect(parseResultsView({ sort: "price_desc", guests: "3", amenity: " Wi-Fi " })).toEqual({
      sort: "price_desc",
      minGuests: 3,
      amenity: "Wi-Fi",
    });
    expect(parseResultsView({ sort: "name" }).sort).toBe("name");
    expect(parseResultsView({ sort: "drop table", guests: "-1", amenity: "x".repeat(61) })).toEqual({
      sort: "price_asc",
      minGuests: 0,
      amenity: null,
    });
    expect(parseResultsView({ guests: "2.5" }).minGuests).toBe(0);
    expect(parseResultsView({ guests: "99" }).minGuests).toBe(0);
    expect(parseResultsView({ sort: ["name", "price_desc"] }).sort).toBe("name");
  });
});

describe("viewQuotes", () => {
  const names = (v: Parameters<typeof viewQuotes>[1]) => viewQuotes(quotes, v).map((x) => x.name);
  it("sorts by price, keeping the hotel's own order for equal totals", () => {
    expect(names({ sort: "price_asc", minGuests: 0, amenity: null })).toEqual(["Standard", "Suite", "Deluxe", "Family"]);
    expect(names({ sort: "price_desc", minGuests: 0, amenity: null })).toEqual(["Family", "Deluxe", "Standard", "Suite"]);
    expect(names({ sort: "name", minGuests: 0, amenity: null })).toEqual(["Deluxe", "Family", "Standard", "Suite"]);
  });
  it("filters by how many it sleeps and by amenity, ignoring case", () => {
    expect(names({ sort: "price_asc", minGuests: 3, amenity: null })).toEqual(["Suite", "Family"]);
    expect(names({ sort: "price_asc", minGuests: 0, amenity: "WI-FI" })).toEqual(["Standard", "Deluxe", "Family"]);
    expect(names({ sort: "price_asc", minGuests: 4, amenity: "Balcony" })).toEqual([]);
  });
  it("does not change the list it is given", () => {
    const before = quotes.map((x) => x.name);
    viewQuotes(quotes, { sort: "name", minGuests: 0, amenity: null });
    expect(quotes.map((x) => x.name)).toEqual(before);
  });
});

describe("amenityOptions", () => {
  it("lists each amenity once, alphabetically, whatever its case", () => {
    expect(amenityOptions(quotes)).toEqual(["Balcony", "Kitchen", "Wi-Fi"]);
    expect(amenityOptions([{}])).toEqual([]);
  });
});

describe("nightlyBreakdown", () => {
  it("shows nights times the rate plus tax when the rate is the same every night", () => {
    const t = {
      nights: [
        { date: "a", rate_minor: 4500000 },
        { date: "b", rate_minor: 4500000 },
      ],
      subtotal_minor: 9000000,
      tax_minor: 675000,
    };
    expect(nightlyBreakdown(t, "NGN")).toBe("2 nights × ₦45,000.00 + ₦6,750.00 tax");
  });
  it("shows the subtotal when rates differ, and leaves out tax when there is none", () => {
    const t = {
      nights: [
        { date: "a", rate_minor: 4500000 },
        { date: "b", rate_minor: 5000000 },
      ],
      subtotal_minor: 9500000,
      tax_minor: 0,
    };
    expect(nightlyBreakdown(t, "NGN")).toBe("2 nights: ₦95,000.00");
    expect(nightlyBreakdown({ nights: [{ date: "a", rate_minor: 100 }], subtotal_minor: 100, tax_minor: 0 }, "NGN")).toBe(
      "1 night × ₦1.00",
    );
  });
});

describe("soldOutTypes", () => {
  const all = [
    { room_type_id: "1", max_adults: 2, max_occupancy: 2 },
    { room_type_id: "2", max_adults: 2, max_occupancy: 3 },
    { room_type_id: "3", max_adults: 1, max_occupancy: 1 },
  ] as never[];
  it("lists the types with no room free that the party would fit in", () => {
    expect(soldOutTypes(all, [{ room_type_id: "1" }], 2, 1).map((t) => t.room_type_id)).toEqual(["2"]);
    expect(soldOutTypes(all, [], 1, 0).map((t) => t.room_type_id)).toEqual(["1", "2", "3"]);
    expect(soldOutTypes(all, [], 2, 2)).toEqual([]);
  });
});
