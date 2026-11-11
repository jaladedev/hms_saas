import { describe, expect, it } from "vitest";
import { facilityList, socialLinks } from "@/lib/guest-site/hotel";
import { normalizeFacebook, normalizeInstagram, parseExtrasForm, parseFacilities } from "./hotel-extras";

describe("facilities", () => {
  it("splits on lines and commas, trims, drops blanks and repeats, keeps order", () => {
    expect(parseFacilities("Pool\n  Restaurant , Bar\r\n\n gym,  POOL ,Gym")).toEqual(["Pool", "Restaurant", "Bar", "gym"]);
    expect(parseFacilities("   \n , ")).toEqual([]);
    expect(parseFacilities("")).toEqual([]);
  });
  it("collapses inner spaces", () => {
    expect(parseFacilities("Conference    room")).toEqual(["Conference room"]);
  });
  it("refuses more than 20 or one over 40 characters, and allows exactly those limits", () => {
    expect(parseFacilities(Array.from({ length: 20 }, (_, i) => `F${i}`).join("\n"))).toHaveLength(20);
    expect(parseFacilities(Array.from({ length: 21 }, (_, i) => `F${i}`).join("\n"))).toBeNull();
    expect(parseFacilities("x".repeat(40))).toEqual(["x".repeat(40)]);
    expect(parseFacilities("x".repeat(41))).toBeNull();
  });
});

describe("instagram link", () => {
  it.each([
    ["bodijaboutique", "https://instagram.com/bodijaboutique"],
    ["@bodijaboutique", "https://instagram.com/bodijaboutique"],
    ["instagram.com/bodijaboutique", "https://instagram.com/bodijaboutique"],
    ["https://www.instagram.com/bodija.boutique/", "https://instagram.com/bodija.boutique"],
    ["HTTP://INSTAGRAM.COM/Bodija_1?hl=en", "https://instagram.com/Bodija_1"],
    ["  @a  ", "https://instagram.com/a"],
  ])("accepts %s", (input, out) => expect(normalizeInstagram(input)).toBe(out));
  it("treats empty as not shown", () => {
    expect(normalizeInstagram("")).toBeNull();
    expect(normalizeInstagram("   ")).toBeNull();
  });
  it.each([
    "https://facebook.com/bodijaboutique",
    "https://evil.com/bodija",
    "https://instagram.com.evil.com/bodija",
    "instagram.com/a/b",
    "javascript:alert(1)",
    "two words",
    "x".repeat(31),
    "@",
    "https://instagram.com/",
  ])("refuses %s", (input) => expect(normalizeInstagram(input)).toBe("invalid"));
});

describe("facebook link", () => {
  it("accepts a name, an address or a pasted page", () => {
    expect(normalizeFacebook("bodijaboutique")).toBe("https://facebook.com/bodijaboutique");
    expect(normalizeFacebook("https://www.facebook.com/bodija.boutique/")).toBe("https://facebook.com/bodija.boutique");
    expect(normalizeFacebook("facebook.com/bodija-boutique?ref=x")).toBe("https://facebook.com/bodija-boutique");
  });
  it("refuses a name under 5 characters, another site and a profile.php address", () => {
    expect(normalizeFacebook("abcd")).toBe("invalid");
    expect(normalizeFacebook("https://instagram.com/bodijaboutique")).toBe("invalid");
    expect(normalizeFacebook("https://facebook.com/profile.php?id=1")).toBe("invalid");
    expect(normalizeFacebook("https://facebook.com.evil.com/bodijaboutique")).toBe("invalid");
  });
});

describe("hotel extras form", () => {
  const id = "00000000-0000-0000-0000-0000000000a2";
  it("reads a good form and turns names into links", () => {
    expect(parseExtrasForm({ propertyId: id, facilities: "Pool\nGym", instagram: "@bodija", facebook: "" })).toEqual({
      ok: true,
      value: { propertyId: id, facilities: ["Pool", "Gym"], instagram: "https://instagram.com/bodija", facebook: null },
    });
  });
  it("refuses a bad id, bad facilities or a bad link with one answer", () => {
    const bad = { ok: false, code: "setup_invalid" };
    expect(parseExtrasForm({ propertyId: "nope", facilities: "", instagram: "", facebook: "" })).toEqual(bad);
    expect(parseExtrasForm({ propertyId: id, facilities: "x".repeat(41), instagram: "", facebook: "" })).toEqual(bad);
    expect(parseExtrasForm({ propertyId: id, facilities: "", instagram: "https://evil.com/x", facebook: "" })).toEqual(bad);
    expect(parseExtrasForm({ propertyId: id, facilities: "", instagram: "", facebook: "abcd" })).toEqual(bad);
  });
  it("treats missing fields as empty", () => {
    expect(parseExtrasForm({ propertyId: id })).toEqual({
      ok: true,
      value: { propertyId: id, facilities: [], instagram: null, facebook: null },
    });
  });
});

describe("guest site: what is drawn", () => {
  it("draws only well-formed https links on the two sites", () => {
    expect(socialLinks({ instagram: "https://www.instagram.com/bodija/", facebook: "https://facebook.com/bodijaboutique" })).toEqual([
      { label: "Instagram", href: "https://www.instagram.com/bodija/" },
      { label: "Facebook", href: "https://facebook.com/bodijaboutique" },
    ]);
    expect(socialLinks({})).toEqual([]);
    expect(socialLinks({ instagram: null, facebook: null })).toEqual([]);
  });
  it("draws nothing for anything that could be a script or another site, whatever the database held", () => {
    for (const bad of [
      "javascript:alert(1)",
      "http://instagram.com/x",
      "https://evil.com/x",
      "https://instagram.com.evil.com/x",
      "https://instagram.com/x?y=1",
      "https://instagram.com/a/b",
      "https://facebook.com/abcd",
      42 as unknown as string,
    ]) {
      expect(socialLinks({ instagram: bad, facebook: bad })).toEqual([]);
    }
  });
  it("lists facilities cleanly and survives odd data", () => {
    expect(facilityList({ facilities: [" Pool ", "pool", "", "Gym"] })).toEqual(["Pool", "Gym"]);
    expect(facilityList({})).toEqual([]);
    expect(facilityList({ facilities: null })).toEqual([]);
    expect(facilityList({ facilities: ["a", 3 as unknown as string, "b"] })).toEqual(["a", "b"]);
    expect(facilityList({ facilities: Array.from({ length: 30 }, (_, i) => `F${i}`) })).toHaveLength(20);
  });
});
