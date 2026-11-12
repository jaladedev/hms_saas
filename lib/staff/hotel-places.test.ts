import { describe, expect, it } from "vitest";
import { MAX_PLACE_BODY, MAX_PLACE_NAME, parsePlaceForm } from "./hotel-places";

const P = "11111111-1111-4111-8111-111111111111";
const base = { propertyId: P, placeId: "", name: " Mapo Hall ", body: " Colonial hall ", sort: "2", active: "on" };

describe("parsePlaceForm", () => {
  it("trims and reads a good form", () => {
    expect(parsePlaceForm(base)).toEqual({
      ok: true,
      value: { propertyId: P, placeId: null, name: "Mapo Hall", body: "Colonial hall", active: true, sort: 2 },
    });
  });
  it("reads an unticked box as off and a blank order as 0", () => {
    const r = parsePlaceForm({ ...base, active: undefined, sort: "" });
    expect(r.ok && r.value.active).toBe(false);
    expect(r.ok && r.value.sort).toBe(0);
  });
  it("accepts an existing place id", () => {
    const r = parsePlaceForm({ ...base, placeId: "22222222-2222-4222-8222-222222222222" });
    expect(r.ok && r.value.placeId).toBe("22222222-2222-4222-8222-222222222222");
  });
  it("refuses bad input", () => {
    for (const bad of [
      { ...base, propertyId: "x" },
      { ...base, placeId: "nope" },
      { ...base, name: "  " },
      { ...base, name: "x".repeat(MAX_PLACE_NAME + 1) },
      { ...base, body: "x".repeat(MAX_PLACE_BODY + 1) },
      { ...base, sort: "1.5" },
      { ...base, sort: "5000" },
    ])
      expect(parsePlaceForm(bad)).toEqual({ ok: false, code: "place_invalid" });
  });
});
