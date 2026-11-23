import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkGuestIdForm, classifyGuestIdError, isGuestIdType, maskedGuestId, normaliseGuestIdNumber } from "./guest-id";

describe("normaliseGuestIdNumber", () => {
  it("trims, upper-cases and collapses spaces", () => {
    expect(normaliseGuestIdNumber("  a01234  567 ")).toBe("A01234 567");
  });
});

describe("checkGuestIdForm", () => {
  it("lets both blank through (that clears the ID)", () => {
    expect(checkGuestIdForm({ id_type: "", id_number: "  " })).toBeNull();
  });
  it("needs both or neither", () => {
    expect(checkGuestIdForm({ id_type: "passport", id_number: "" })).toBe("guest_id_both");
    expect(checkGuestIdForm({ id_type: "", id_number: "A1234567" })).toBe("guest_id_both");
  });
  it("accepts each type with a good number", () => {
    for (const t of ["nin", "passport", "drivers_licence", "voters_card", "other"]) {
      expect(checkGuestIdForm({ id_type: t, id_number: "12345678901" })).toBeNull();
    }
    expect(checkGuestIdForm({ id_type: "drivers_licence", id_number: "abc/123-456 78" })).toBeNull();
  });
  it("refuses an unknown type and bad numbers", () => {
    expect(checkGuestIdForm({ id_type: "library_card", id_number: "12345678" })).toBe("guest_id_type");
    expect(checkGuestIdForm({ id_type: "nin", id_number: "12345" })).toBe("guest_id_number");
    expect(checkGuestIdForm({ id_type: "nin", id_number: "1".repeat(41) })).toBe("guest_id_number");
    expect(checkGuestIdForm({ id_type: "nin", id_number: "1234 5678; drop" })).toBe("guest_id_number");
    expect(checkGuestIdForm({ id_type: "nin", id_number: "-1234567" })).toBe("guest_id_number");
  });
});

describe("isGuestIdType and maskedGuestId", () => {
  it("knows the five types", () => {
    expect(isGuestIdType("nin")).toBe(true);
    expect(isGuestIdType("selfie")).toBe(false);
    expect(isGuestIdType(null)).toBe(false);
  });
  it("shows only the type and the last three characters", () => {
    expect(maskedGuestId({ id_type: "passport", last3: "678" })).toBe("Passport, ending 678");
    expect(maskedGuestId({ id_type: "weird", last3: "123" })).toBe("ID, ending 123");
  });
});

describe("classifyGuestIdError", () => {
  it("maps database refusals", () => {
    expect(classifyGuestIdError({ message: "POLICY_VIOLATION: id both" })).toBe("guest_id_both");
    expect(classifyGuestIdError({ message: "POLICY_VIOLATION: id type" })).toBe("guest_id_type");
    expect(classifyGuestIdError({ message: "POLICY_VIOLATION: id number" })).toBe("guest_id_number");
    expect(classifyGuestIdError({ message: "NOT_FOUND" })).toBe("guest_id_forbidden");
    expect(classifyGuestIdError({ message: "boom" })).toBe("unknown");
  });
});

describe("saveGuestId error handling", () => {
  it("does not call an unexpected database failure a permission problem", () => {
    const src = readFileSync("lib/staff/guest-actions.ts", "utf8");
    const save = src.slice(src.indexOf("export async function saveGuestId"), src.indexOf("export type RevealedGuestId"));
    expect(save).toContain("back(page, { err: classifyGuestIdError(error) })");
    expect(save).not.toMatch(/=== "unknown" \?/);
  });
});
