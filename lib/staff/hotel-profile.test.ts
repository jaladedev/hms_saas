import { describe, expect, it } from "vitest";
import { parseBasicsForm, parseProfileForm, parseThemeForm, telHref, timeInput } from "./hotel-profile";

const ID = "00000000-0000-4000-8000-0000000000a2";

describe("parseProfileForm", () => {
  it("trims, and turns blanks into null", () => {
    expect(parseProfileForm({ propertyId: ID, phone: " +234 802 000 0000 ", email: " a@b.co ", intro: "  Hi  " })).toEqual({
      ok: true,
      value: { propertyId: ID, phone: "+234 802 000 0000", email: "a@b.co", intro: "Hi" },
    });
    expect(parseProfileForm({ propertyId: ID, phone: "  ", email: "", intro: undefined })).toEqual({
      ok: true,
      value: { propertyId: ID, phone: null, email: null, intro: null },
    });
  });
  it("refuses a bad property id, phone, email or an intro over 500 characters", () => {
    const bad = (o: Record<string, unknown>) => parseProfileForm({ propertyId: ID, ...o });
    expect(parseProfileForm({ propertyId: "x" }).ok).toBe(false);
    expect(bad({ phone: "call me" }).ok).toBe(false);
    expect(bad({ phone: "1234" }).ok).toBe(false);
    expect(bad({ phone: "1".repeat(33) }).ok).toBe(false);
    expect(bad({ email: "no-at.com" }).ok).toBe(false);
    expect(bad({ email: "a@b" }).ok).toBe(false);
    expect(bad({ email: "a b@c.co" }).ok).toBe(false);
    expect(bad({ intro: "x".repeat(501) }).ok).toBe(false);
    expect(bad({ intro: "x".repeat(500) }).ok).toBe(true);
  });
});

describe("telHref", () => {
  it("keeps digits and a leading plus", () => {
    expect(telHref("+234 (802) 000-0000")).toBe("tel:+2348020000000");
    expect(telHref("0802 000 0000")).toBe("tel:08020000000");
  });
  it("gives null when there is nothing to dial", () => {
    expect(telHref(null)).toBeNull();
    expect(telHref("()- ")).toBeNull();
  });
});

describe("parseBasicsForm", () => {
  const ok = {
    propertyId: ID,
    name: " Hotel A ",
    address: " 5 River Road ",
    city: " Lagos ",
    state: " Lagos State ",
    checkIn: "15:00",
    checkOut: "11:30",
  };
  it("trims and accepts valid details; a blank address means none", () => {
    expect(parseBasicsForm(ok)).toEqual({
      ok: true,
      value: {
        propertyId: ID,
        name: "Hotel A",
        address: "5 River Road",
        city: "Lagos",
        state: "Lagos State",
        checkIn: "15:00",
        checkOut: "11:30",
      },
    });
    expect(parseBasicsForm({ ...ok, address: "  " })).toMatchObject({ ok: true, value: { address: null } });
  });
  it("refuses a missing or oversized name, town or state, a long address, a bad id and bad times", () => {
    for (const bad of [
      { name: " " },
      { name: "n".repeat(121) },
      { address: "a".repeat(201) },
      { city: "" },
      { city: "c".repeat(81) },
      { state: " " },
      { propertyId: "x" },
      { checkIn: "" },
      { checkIn: "24:00" },
      { checkOut: "9:30" },
      { checkOut: "12:60" },
    ]) {
      expect(parseBasicsForm({ ...ok, ...bad }).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("timeInput", () => {
  it("cuts seconds off", () => {
    expect(timeInput("14:00:00")).toBe("14:00");
    expect(timeInput(null)).toBe("");
  });
});

describe("parseThemeForm", () => {
  const id = "00000000-0000-0000-0000-0000000000a2";
  it("accepts the three themes and the standard look", () => {
    expect(parseThemeForm({ propertyId: id, theme: "luxury" })).toEqual({
      ok: true,
      value: { propertyId: id, theme: "luxury", primary: null, fontDisplay: null, fontBody: null, radius: null },
    });
    expect(parseThemeForm({ propertyId: id, theme: " classic " })).toEqual({
      ok: true,
      value: { propertyId: id, theme: "classic", primary: null, fontDisplay: null, fontBody: null, radius: null },
    });
    expect(parseThemeForm({ propertyId: id, theme: "standard" })).toEqual({
      ok: true,
      value: { propertyId: id, theme: null, primary: null, fontDisplay: null, fontBody: null, radius: null },
    });
  });
  it("refuses anything else, and a bad hotel id", () => {
    for (const theme of ["", "neon", "Luxury", "default", "luxury; drop table properties", undefined, 3]) {
      expect(parseThemeForm({ propertyId: id, theme })).toEqual({ ok: false, code: "setup_invalid" });
    }
    expect(parseThemeForm({ propertyId: "nope", theme: "modern" })).toEqual({ ok: false, code: "setup_invalid" });
    expect(parseThemeForm({ theme: "modern" })).toEqual({ ok: false, code: "setup_invalid" });
  });
});

describe("parseThemeForm main colour", () => {
  const id = "00000000-0000-0000-0000-0000000000a2";
  it("accepts a readable colour, normalised, with or without a theme", () => {
    expect(parseThemeForm({ propertyId: id, theme: "modern", primary: " #7C2D12 " })).toEqual({
      ok: true,
      value: { propertyId: id, theme: "modern", primary: "#7c2d12", fontDisplay: null, fontBody: null, radius: null },
    });
    expect(parseThemeForm({ propertyId: id, theme: "standard", primary: "#7c2d12" })).toEqual({
      ok: true,
      value: { propertyId: id, theme: null, primary: "#7c2d12", fontDisplay: null, fontBody: null, radius: null },
    });
  });
  it("treats a blank colour as none, refuses a malformed one, and refuses one white text cannot be read on", () => {
    expect(parseThemeForm({ propertyId: id, theme: "luxury", primary: "  " })).toMatchObject({
      ok: true,
      value: { primary: null, fontDisplay: null, fontBody: null, radius: null },
    });
    expect(parseThemeForm({ propertyId: id, theme: "luxury", primary: "teal" })).toEqual({ ok: false, code: "theme_color" });
    expect(parseThemeForm({ propertyId: id, theme: "luxury", primary: "#fff" })).toEqual({ ok: false, code: "theme_color" });
    expect(parseThemeForm({ propertyId: id, theme: "luxury", primary: "#ffff00" })).toEqual({ ok: false, code: "theme_contrast" });
  });
});

describe("parseThemeForm fonts", () => {
  const id = "00000000-0000-0000-0000-0000000000a2";
  it("accepts listed fonts, blank as none", () => {
    expect(parseThemeForm({ propertyId: id, theme: "standard", fontDisplay: "outfit", fontBody: "source-serif" })).toEqual({
      ok: true,
      value: { propertyId: id, theme: null, primary: null, fontDisplay: "outfit", fontBody: "source-serif", radius: null },
    });
    expect(parseThemeForm({ propertyId: id, theme: "standard", fontDisplay: "", fontBody: " " })).toMatchObject({
      ok: true,
      value: { fontDisplay: null, fontBody: null, radius: null },
    });
  });
  it("refuses unknown fonts, and a font in the wrong list", () => {
    for (const raw of [{ fontDisplay: "comic-sans" }, { fontDisplay: "inter" }, { fontBody: "sora" }, { fontBody: "x; y" }])
      expect(parseThemeForm({ propertyId: id, theme: "standard", ...raw })).toEqual({ ok: false, code: "theme_font" });
  });
});

describe("parseThemeForm corners", () => {
  const id = "00000000-0000-0000-0000-0000000000a2";
  it("accepts sharp and round, blank as standard", () => {
    expect(parseThemeForm({ propertyId: id, theme: "standard", radius: "round" })).toMatchObject({ ok: true, value: { radius: "round" } });
    expect(parseThemeForm({ propertyId: id, theme: "standard", radius: "sharp" })).toMatchObject({ ok: true, value: { radius: "sharp" } });
    expect(parseThemeForm({ propertyId: id, theme: "standard", radius: " " })).toMatchObject({ ok: true, value: { radius: null } });
  });
  it("refuses anything else", () => {
    for (const radius of ["pill", "8px", "Round", "round; x"])
      expect(parseThemeForm({ propertyId: id, theme: "standard", radius })).toEqual({ ok: false, code: "theme_radius" });
  });
});
