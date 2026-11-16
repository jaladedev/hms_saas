import { describe, expect, it } from "vitest";
import { experienceUnit, parseExperienceRequest, requestStatusLabel } from "./experiences";

const ID = "00000000-0000-4000-8000-000000000001";

describe("parseExperienceRequest", () => {
  it("reads a good form", () => {
    expect(parseExperienceRequest({ experienceId: ID, quantity: "2", date: "2026-12-01", note: " vegetarian " })).toEqual({
      experienceId: ID,
      quantity: 2,
      date: "2026-12-01",
      note: "vegetarian",
    });
  });
  it("treats an empty day and note as none", () => {
    expect(parseExperienceRequest({ experienceId: ID, quantity: "1", date: "", note: "" })).toEqual({
      experienceId: ID,
      quantity: 1,
      date: null,
      note: "",
    });
  });
  it("refuses a bad id, quantity, day or note", () => {
    expect(parseExperienceRequest({ experienceId: "x", quantity: "1" })).toEqual({ error: "bad_request" });
    for (const q of ["0", "21", "1.5", "", "-1", "abc"])
      expect(parseExperienceRequest({ experienceId: ID, quantity: q })).toEqual({ error: "experience_quantity" });
    expect(parseExperienceRequest({ experienceId: ID, quantity: "1", date: "tomorrow" })).toEqual({ error: "experience_date" });
    expect(parseExperienceRequest({ experienceId: ID, quantity: "1", note: "x".repeat(201) })).toEqual({ error: "experience_note" });
  });
});

describe("wording", () => {
  it("words units and states", () => {
    expect(experienceUnit("booking")).toBe("per booking");
    expect(experienceUnit("person")).toBe("per person");
    expect(requestStatusLabel("requested")).toBe("Waiting for the hotel");
    expect(requestStatusLabel("charged")).toBe("Added to your bill");
    expect(requestStatusLabel("anything")).toBe("Waiting for the hotel");
  });
});
