import { describe, expect, it } from "vitest";
import { groupPlaces, isHttpsLink, MAX_PLACE_BODY, MAX_PLACE_NAME, parsePlaceForm, safePlaceLink } from "./hotel-places";

const P = "11111111-1111-4111-8111-111111111111";
const base = { propertyId: P, placeId: "", name: " Mapo Hall ", body: " Colonial hall ", sort: "2", active: "on" };

describe("parsePlaceForm", () => {
  it("trims and reads a good form", () => {
    expect(parsePlaceForm(base)).toEqual({
      ok: true,
      value: { propertyId: P, placeId: null, name: "Mapo Hall", body: "Colonial hall", active: true, sort: 2, category: "other", link: "" },
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
      { ...base, category: "museum" },
      { ...base, link: "http://x.test" },
      { ...base, link: "javascript:alert(1)" },
      { ...base, link: "https://x.test/a b" },
    ])
      expect(parsePlaceForm(bad)).toEqual({ ok: false, code: "place_invalid" });
  });
});

describe("category and link", () => {
  it("reads a category and a link", () => {
    const r = parsePlaceForm({ ...base, category: "dining", link: " https://example.test/cafe " });
    expect(r.ok && r.value.category).toBe("dining");
    expect(r.ok && r.value.link).toBe("https://example.test/cafe");
  });
  it("accepts only https links without spaces or markup", () => {
    expect(isHttpsLink("https://example.test/a?b=1")).toBe(true);
    for (const v of [
      "http://x.test",
      "https://",
      "https://x.test/a b",
      'https://x.test/"',
      "https://x.test/<",
      "ftp://x",
      5,
      null,
      `https://x.test/${"a".repeat(200)}`,
    ])
      expect(isHttpsLink(v)).toBe(false);
    expect(safePlaceLink("javascript:alert(1)")).toBeNull();
    expect(safePlaceLink("https://x.test")).toBe("https://x.test");
  });
  it("groups by category in a fixed order, keeping the hotel's order inside a group", () => {
    const g = groupPlaces([
      { name: "A", body: "", category: "other" },
      { name: "B", body: "", category: "dining" },
      { name: "C", body: "", category: "sights" },
      { name: "D", body: "", category: "dining" },
      { name: "E", body: "" },
      { name: "F", body: "", category: "bogus" },
    ]);
    expect(g.map((x) => x.category)).toEqual(["dining", "sights", "other"]);
    expect(g[0]?.places.map((p) => p.name)).toEqual(["B", "D"]);
    expect(g[2]?.places.map((p) => p.name)).toEqual(["A", "E", "F"]);
    expect(groupPlaces([])).toEqual([]);
  });
});
