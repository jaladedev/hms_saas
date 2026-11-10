import { describe, expect, it } from "vitest";
import { isPropertyId, pickProperty, returnPath, withoutPropertyParam } from "./property-choice";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const list = [{ id: A }, { id: B }];

describe("pickProperty", () => {
  it("prefers the address, then the remembered choice, then the first", () => {
    expect(pickProperty(list, B, A)?.id).toBe(B);
    expect(pickProperty(list, undefined, B)?.id).toBe(B);
    expect(pickProperty(list, undefined, undefined)?.id).toBe(A);
  });
  it("ignores ids that are not in the list", () => {
    expect(pickProperty(list, "nope", "also-nope")?.id).toBe(A);
    expect(pickProperty(list, "nope", B)?.id).toBe(B);
  });
  it("returns undefined for an empty list", () => {
    expect(pickProperty([], A, B)).toBeUndefined();
  });
});

describe("isPropertyId", () => {
  it("accepts uuids only", () => {
    expect(isPropertyId(A)).toBe(true);
    expect(isPropertyId("abc")).toBe(false);
    expect(isPropertyId(undefined)).toBe(false);
  });
});

describe("returnPath", () => {
  it("allows paths inside /app", () => {
    expect(returnPath("/app/reports?from=2026-11-01")).toBe("/app/reports?from=2026-11-01");
    expect(returnPath("/app")).toBe("/app");
  });
  it("sends anything else to the overview", () => {
    for (const bad of [null, undefined, "", "https://evil.example", "//evil.example", "/platform", "/app//x", "/app\\x", "/application"])
      expect(returnPath(bad)).toBe("/app");
  });
});

describe("withoutPropertyParam", () => {
  it("drops only the property parameter", () => {
    expect(withoutPropertyParam(`/app/reports?property=${A}&from=2026-11-01`)).toBe("/app/reports?from=2026-11-01");
    expect(withoutPropertyParam(`/app/rooms/calendar?property=${A}`)).toBe("/app/rooms/calendar");
    expect(withoutPropertyParam("/app/reports")).toBe("/app/reports");
  });
});
