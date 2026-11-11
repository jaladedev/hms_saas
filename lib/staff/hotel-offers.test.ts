import { describe, expect, it } from "vitest";
import { MAX_BODY, MAX_TITLE, offerWindow, parseOfferForm } from "./hotel-offers";

const P = "00000000-0000-0000-0000-0000000000a2";
const O = "00000000-0000-0000-0000-0000000000f1";
const base = {
  propertyId: P,
  title: "Weekend escape",
  body: "Two nights",
  badge: "10% off",
  validFrom: "",
  validTo: "",
  sort: "",
  active: "on",
};

describe("parseOfferForm", () => {
  it("reads a complete form and trims the text", () => {
    const r = parseOfferForm({
      ...base,
      title: "  Weekend escape  ",
      offerId: O,
      validFrom: "2026-12-01",
      validTo: "2026-12-31",
      sort: "3",
    });
    expect(r).toEqual({
      ok: true,
      value: {
        propertyId: P,
        offerId: O,
        title: "Weekend escape",
        body: "Two nights",
        badge: "10% off",
        validFrom: "2026-12-01",
        validTo: "2026-12-31",
        active: true,
        sort: 3,
      },
    });
  });
  it("treats empty dates and a missing id as none, and an unticked box as off", () => {
    const r = parseOfferForm({ ...base, active: undefined });
    expect(r.ok && r.value.offerId).toBeNull();
    expect(r.ok && r.value.active).toBe(false);
    expect(r.ok && r.value.validFrom).toBe("");
  });
  it("refuses a missing or too long title, text or badge, and bad ids", () => {
    for (const over of [
      { title: "  " },
      { title: "x".repeat(MAX_TITLE + 1) },
      { body: "x".repeat(MAX_BODY + 1) },
      { badge: "x".repeat(25) },
      { propertyId: "nope" },
      { offerId: "nope" },
    ]) {
      expect(parseOfferForm({ ...base, ...over })).toEqual({ ok: false, code: "offer_invalid" });
    }
    expect(parseOfferForm({ ...base, title: "x".repeat(MAX_TITLE) }).ok).toBe(true);
  });
  it("refuses impossible dates and an end before the start", () => {
    for (const over of [{ validFrom: "2026-02-30" }, { validTo: "soon" }, { validFrom: "2026-12-31", validTo: "2026-12-01" }]) {
      expect(parseOfferForm({ ...base, ...over })).toEqual({ ok: false, code: "offer_dates" });
    }
    expect(parseOfferForm({ ...base, validFrom: "2026-12-01", validTo: "2026-12-01" }).ok).toBe(true);
  });
  it("refuses a sort order that is not a small whole number", () => {
    for (const sort of ["1.5", "abc", "5000"]) expect(parseOfferForm({ ...base, sort })).toEqual({ ok: false, code: "offer_invalid" });
  });
});

describe("offerWindow", () => {
  it("describes each shape", () => {
    expect(offerWindow(null, null)).toBe("Always");
    expect(offerWindow("2026-12-01", null)).toBe("From 2026-12-01");
    expect(offerWindow(null, "2026-12-31")).toBe("Until 2026-12-31");
    expect(offerWindow("2026-12-01", "2026-12-31")).toBe("2026-12-01 to 2026-12-31");
  });
});
