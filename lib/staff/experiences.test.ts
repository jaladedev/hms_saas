import { describe, expect, it } from "vitest";
import { canPostToFolio, parseExperienceForm, parseOpenRequests, unitLabel } from "./experiences";

const P = "00000000-0000-4000-8000-0000000000a2";
const base = { propertyId: P, name: " City tour ", body: " Half day ", price: "5,000.50", unit: "person", sort: "2", active: "on" };

describe("parseExperienceForm", () => {
  it("trims, converts naira to kobo and reads the switch", () => {
    const r = parseExperienceForm(base);
    expect(r).toEqual({
      ok: true,
      value: {
        propertyId: P,
        experienceId: null,
        name: "City tour",
        body: "Half day",
        priceMinor: 500050,
        unit: "person",
        active: true,
        sort: 2,
      },
    });
  });
  it("defaults the unit to person and an empty order to 0", () => {
    const r = parseExperienceForm({ ...base, unit: "", sort: "" });
    expect(r.ok && r.value.unit).toBe("person");
    expect(r.ok && r.value.sort).toBe(0);
  });
  it.each([
    ["no name", { name: "  " }],
    ["long name", { name: "x".repeat(61) }],
    ["long line", { body: "x".repeat(201) }],
    ["zero price", { price: "0" }],
    ["free text price", { price: "cheap" }],
    ["too many decimals", { price: "1.234" }],
    ["unknown unit", { unit: "group" }],
    ["bad property", { propertyId: "nope" }],
    ["bad order", { sort: "1.5" }],
  ])("refuses %s", (_label, change) => {
    expect(parseExperienceForm({ ...base, ...change })).toEqual({ ok: false, code: "experience_invalid" });
  });
  it("keeps an id when editing", () => {
    const r = parseExperienceForm({ ...base, experienceId: P });
    expect(r.ok && r.value.experienceId).toBe(P);
  });
});

describe("parseOpenRequests", () => {
  const good = { id: "a", name: "Tour", quantity: 2, total_minor: 100, status: "requested" };
  it("keeps well-formed rows and drops the rest", () => {
    expect(parseOpenRequests({ requests: [good, { id: "b" }, null, { ...good, status: "charged" }] })).toEqual([good]);
  });
  it("gives an empty list for anything else", () => {
    expect(parseOpenRequests(null)).toEqual([]);
    expect(parseOpenRequests({ requests: "x" })).toEqual([]);
  });
});

describe("folio and unit helpers", () => {
  it("posts to the folio only for a guest in the house or gone", () => {
    expect(canPostToFolio("checked_in")).toBe(true);
    expect(canPostToFolio("checked_out")).toBe(true);
    expect(canPostToFolio("confirmed")).toBe(false);
    expect(canPostToFolio("cancelled")).toBe(false);
  });
  it("words the unit", () => {
    expect(unitLabel("booking")).toBe("per booking");
    expect(unitLabel("person")).toBe("per person");
  });
});
