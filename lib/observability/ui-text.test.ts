import { describe, expect, it } from "vitest";
import { isConnectionError } from "./ui-text";

describe("isConnectionError", () => {
  it("recognises the browsers' own network failures", () => {
    expect(isConnectionError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isConnectionError(new TypeError("Load failed"))).toBe(true);
    expect(isConnectionError(new Error("NetworkError when attempting to fetch resource."))).toBe(true);
    expect(isConnectionError({ name: "TypeError", message: "fetch failed" })).toBe(true);
  });
  it("leaves real application errors alone", () => {
    expect(isConnectionError(new Error("An error occurred in the Server Components render."))).toBe(false);
    expect(isConnectionError(new Error("INVALID_STATE: on an invoice"))).toBe(false);
    expect(isConnectionError(null)).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
  });
});
