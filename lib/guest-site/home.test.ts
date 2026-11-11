import { describe, expect, it } from "vitest";
import { amenityHighlights, capacityLabel, freeCancellationBadge, fromPriceLabel, monogram, offerUntilLabel, onlyChosenType } from "./home";

describe("fromPriceLabel", () => {
  it("formats the nightly price, and gives nothing for a missing or non-positive one", () => {
    expect(fromPriceLabel(2500000, "NGN")).toBe("From ₦25,000.00 / night");
    expect(fromPriceLabel(null, "NGN")).toBeNull();
    expect(fromPriceLabel(undefined, "NGN")).toBeNull();
    expect(fromPriceLabel(0, "NGN")).toBeNull();
    expect(fromPriceLabel(-5, "NGN")).toBeNull();
    expect(fromPriceLabel(Number.NaN, "NGN")).toBeNull();
  });
});

describe("capacityLabel", () => {
  it("says guests, singular for one", () => {
    expect(capacityLabel(1)).toBe("1 guest");
    expect(capacityLabel(2)).toBe("Up to 2 guests");
    expect(capacityLabel(4)).toBe("Up to 4 guests");
  });
});

describe("amenityHighlights", () => {
  it("lists each amenity once across room types, in first-seen order, up to the limit", () => {
    const types = [{ amenities: ["Wi-Fi", "Air conditioning"] }, { amenities: ["wi-fi", "  Breakfast  ", "", "Pool"] }];
    expect(amenityHighlights(types, 10)).toEqual(["Wi-Fi", "Air conditioning", "Breakfast", "Pool"]);
    expect(amenityHighlights(types, 3)).toEqual(["Wi-Fi", "Air conditioning", "Breakfast"]);
    expect(amenityHighlights([], 5)).toEqual([]);
    expect(amenityHighlights([{ amenities: undefined as unknown as string[] }], 5)).toEqual([]);
  });
});

describe("monogram", () => {
  it("is the first letter, upper-case, even for an emoji or a leading space", () => {
    expect(monogram("Bodija Boutique")).toBe("B");
    expect(monogram("  royal palace")).toBe("R");
    expect(monogram("🏨 Hotel")).toBe("🏨");
    expect(monogram("")).toBe("?");
    expect(monogram(null)).toBe("?");
  });
});

describe("freeCancellationBadge", () => {
  const rule = (hours: number) => ({ within_hours: hours, charge: { type: "percent", value: 50 } });
  it("names the free window from the widest rule", () => {
    expect(freeCancellationBadge({ cancellation_rules: [rule(24), rule(12)] })).toBe("Free cancellation until 1 day before check-in");
    expect(freeCancellationBadge({ cancellation_rules: [rule(36)] })).toBe("Free cancellation until 36 hours before check-in");
    expect(freeCancellationBadge({ cancellation_rules: [rule(0)] })).toBe("Free cancellation until check-in time");
  });
  it("says until check-in when there are no rules", () => {
    expect(freeCancellationBadge({ cancellation_rules: [] })).toBe("Free cancellation until check-in");
    expect(freeCancellationBadge({})).toBe("Free cancellation until check-in");
    expect(freeCancellationBadge(null)).toBe("Free cancellation until check-in");
  });
  it("says nothing when guests cannot cancel online", () => {
    expect(freeCancellationBadge({ cancellation_rules: [rule(24)], guest_cancellation: "off" })).toBeNull();
  });
});

describe("onlyChosenType", () => {
  const types = [{ room_type_id: "a" }, { room_type_id: "b" }];
  it("keeps the chosen type, or everything when none or an unknown one is chosen", () => {
    expect(onlyChosenType(types, "b")).toEqual([{ room_type_id: "b" }]);
    expect(onlyChosenType(types, undefined)).toEqual(types);
    expect(onlyChosenType(types, "")).toEqual(types);
    expect(onlyChosenType(types, "zzz")).toEqual(types);
  });
});

describe("offerUntilLabel", () => {
  it("words an end date, and is null for none or a bad value", () => {
    expect(offerUntilLabel("2026-11-30")).toMatch(/^Until .*2026/);
    for (const bad of [null, undefined, "", "soon", "2026-11-30T00:00:00Z"]) expect(offerUntilLabel(bad)).toBeNull();
  });
});
