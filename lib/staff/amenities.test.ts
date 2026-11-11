import { describe, expect, it } from "vitest";
import { addExtras, ALL_AMENITIES, amenityValue, splitAmenities } from "./amenities";
import { MAX_AMENITIES, MAX_AMENITY_LENGTH, parseAmenities } from "./room-setup";
import { crumbsFor } from "@/components/staff/breadcrumbs";

describe("amenity list", () => {
  it("fits what the server and database accept", () => {
    expect(new Set(ALL_AMENITIES.map((a) => a.toLowerCase())).size).toBe(ALL_AMENITIES.length);
    for (const a of ALL_AMENITIES) {
      expect(a.length).toBeLessThanOrEqual(MAX_AMENITY_LENGTH);
      expect(a).toBe(a.trim());
      expect(a).not.toMatch(/[,;\n]/);
    }
  });
  it("round-trips through the server's own parser", () => {
    expect(parseAmenities(amenityValue(["Free Wi-Fi", "Balcony"], ["Rooftop terrace"]))).toEqual([
      "Free Wi-Fi",
      "Balcony",
      "Rooftop terrace",
    ]);
  });
});

describe("splitAmenities", () => {
  it("matches the list ignoring case, keeps list order, and treats the rest as extras", () => {
    expect(splitAmenities(["balcony", "Rooftop terrace", "AIR CONDITIONING", "rooftop TERRACE"])).toEqual({
      picked: ["Air conditioning", "Balcony"],
      extras: ["Rooftop terrace"],
    });
  });
});

describe("addExtras", () => {
  it("adds several at once, tidied, skipping repeats of ticked or existing ones", () => {
    const r = addExtras(["Balcony"], ["Sea breeze"], "  Rooftop   pool , balcony; SEA breeze,, ");
    expect(r).toEqual({ extras: ["Sea breeze", "Rooftop pool"], error: null });
  });
  it("refuses a too-long item or going past the limit, adding nothing", () => {
    expect(addExtras([], [], "x".repeat(MAX_AMENITY_LENGTH + 1)).error).toMatch(/too long/);
    const picked = ALL_AMENITIES.slice(0, MAX_AMENITIES);
    const r = addExtras(picked, [], "One more");
    expect(r.error).toMatch(/Up to 20/);
    expect(r.extras).toEqual([]);
  });
});

describe("crumbsFor", () => {
  it("is empty on the overview and for non-staff addresses", () => {
    expect(crumbsFor("/app")).toEqual([]);
    expect(crumbsFor("/platform/plans")).toEqual([]);
  });
  it("names the room setup page and its parents", () => {
    expect(crumbsFor("/app/settings/rooms").map((c) => c.label)).toEqual(["Overview", "Settings", "Room types and rooms"]);
    expect(crumbsFor("/app/rooms").map((c) => c.label)).toEqual(["Overview", "Room Management"]);
  });
  it("names a single room's page, and keeps the room calendar its own name", () => {
    expect(crumbsFor("/app/rooms/3f0c9a52-1111-4222-8333-444455556666").map((c) => c.label)).toEqual([
      "Overview",
      "Room Management",
      "Room details",
    ]);
    expect(crumbsFor("/app/rooms/calendar").map((c) => c.label)).toEqual(["Overview", "Room Management", "Calendar"]);
  });
  it("names an id page for what it is", () => {
    const c = crumbsFor("/app/reservations/3f0c9a52-1111-4222-8333-444455556666/documents");
    expect(c.map((x) => x.label)).toEqual(["Overview", "Reservations", "Reservation", "Documents"]);
    expect(c[2]?.href).toBe("/app/reservations/3f0c9a52-1111-4222-8333-444455556666");
  });
});
