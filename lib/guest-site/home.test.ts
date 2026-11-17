import { describe, expect, it } from "vitest";
import {
  amenityHighlights,
  bentoLayout,
  capacityLabel,
  freeCancellationBadge,
  fromPriceLabel,
  guestsLabel,
  monogram,
  nightDayLabel,
  nightPriceLabel,
  offerUntilLabel,
  onlyChosenType,
  stayLimitProblem,
  stayRule,
} from "./home";

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

describe("price calendar labels", () => {
  it("shows a night's price in whole naira, and n/a when there is no rate", () => {
    expect(nightPriceLabel(2500000, "NGN")).toBe("₦25,000");
    expect(nightPriceLabel(null, "NGN")).toBe("n/a");
    expect(nightPriceLabel(undefined, "NGN")).toBe("n/a");
    expect(nightPriceLabel(Number.NaN, "NGN")).toBe("n/a");
  });
  it("shows a night's date as day and month, with no time zone shift", () => {
    expect(nightDayLabel("2026-11-12")).toBe("12 Nov");
    expect(nightDayLabel("2027-01-01")).toBe("1 Jan");
    expect(nightDayLabel("nope")).toBe("nope");
  });
});

describe("stayRule", () => {
  it("says nothing when the hotel has no limit", () => {
    expect(stayRule({})).toBeNull();
    expect(stayRule(null)).toBeNull();
    expect(stayRule({ min_nights: 1, max_nights: 30 })).toBeNull();
  });
  it("says what the hotel asks for", () => {
    expect(stayRule({ min_nights: 2, max_nights: 14 })).toBe("Stays of 2 to 14 nights");
    expect(stayRule({ min_nights: 3, max_nights: 30 })).toBe("Minimum stay: 3 nights");
    expect(stayRule({ min_nights: 1, max_nights: 7 })).toBe("Maximum stay: 7 nights");
    expect(stayRule({ min_nights: 2, max_nights: 2 })).toBe("Stays of exactly 2 nights");
    expect(stayRule({ min_nights: 1, max_nights: 1 })).toBe("Maximum stay: 1 night");
  });
  it("ignores values the database would ignore", () => {
    expect(stayRule({ min_nights: 0, max_nights: 99 })).toBeNull();
  });
});

describe("stayLimitProblem", () => {
  const rule = { min_nights: 2, max_nights: 5 };
  it("is null inside the limits, at both edges, and when the hotel has none", () => {
    expect(stayLimitProblem(rule, 2)).toBeNull();
    expect(stayLimitProblem(rule, 5)).toBeNull();
    expect(stayLimitProblem({}, 1)).toBeNull();
    expect(stayLimitProblem({}, 30)).toBeNull();
    expect(stayLimitProblem(null, 3)).toBeNull();
  });
  it("says the rule and the searched length outside them", () => {
    expect(stayLimitProblem(rule, 1)).toBe(
      "Stays of 2 to 5 nights. Your search is for 1 night, so no rooms are shown. Change your dates to see what is available.",
    );
    expect(stayLimitProblem(rule, 6)).toContain("Your search is for 6 nights");
    expect(stayLimitProblem({ min_nights: 3, max_nights: 30 }, 2)).toContain("Minimum stay: 3 nights");
    expect(stayLimitProblem({ min_nights: 1, max_nights: 7 }, 8)).toContain("Maximum stay: 7 nights");
  });
  it("ignores a length that is not a whole number of nights", () => {
    expect(stayLimitProblem(rule, 0)).toBeNull();
    expect(stayLimitProblem(rule, 2.5)).toBeNull();
  });
});

describe("bentoLayout", () => {
  it("puts the first type wide, the second dark and the rest in the row, keeping the hotel's order", () => {
    const l = bentoLayout(["a", "b", "c", "d", "e"]);
    expect(l.featured).toBe("a");
    expect(l.highlight).toBe("b");
    expect(l.small).toEqual(["c", "d", "e"]);
  });

  it("handles one type, two types and none, never hiding a type", () => {
    expect(bentoLayout(["a"])).toEqual({ featured: "a", highlight: null, small: [] });
    expect(bentoLayout(["a", "b"])).toEqual({ featured: "a", highlight: "b", small: [] });
    expect(bentoLayout([])).toEqual({ featured: null, highlight: null, small: [] });
    const many = Array.from({ length: 9 }, (_, i) => i);
    const l = bentoLayout(many);
    expect([l.featured, l.highlight, ...l.small]).toEqual(many);
  });
});

describe("guestsLabel", () => {
  it("is singular for one and plural otherwise", () => {
    expect(guestsLabel(1)).toBe("1 guest");
    expect(guestsLabel(2)).toBe("2 guests");
    expect(guestsLabel(6)).toBe("6 guests");
  });
});
