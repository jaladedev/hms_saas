import { describe, expect, it } from "vitest";
import { parseBasicsForm, parseProfileForm, telHref, timeInput } from "./hotel-profile";

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
