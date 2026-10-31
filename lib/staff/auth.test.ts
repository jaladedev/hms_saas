import { describe, expect, it } from "vitest";
import { classifyAuthError, safeNext, signInErrorMessage } from "./auth";

describe("safeNext", () => {
  it("keeps paths inside /app, with their query", () => {
    expect(safeNext("/app")).toBe("/app");
    expect(safeNext("/app/refunds")).toBe("/app/refunds");
    expect(safeNext("/app/reservations/abc/settlement?ok=requested")).toBe("/app/reservations/abc/settlement?ok=requested");
  });
  it("refuses anything that could leave the site or the staff area", () => {
    for (const bad of [
      "https://evil.example", "//evil.example", "/\\evil.example", "/app//evil.example", "/application", "/appx/refunds",
      "/login", "/", "app/refunds", "javascript:alert(1)", "/app/x\nSet-Cookie: a=b", "/app/ x", "", "/app/" + "a".repeat(600),
    ]) {
      expect(safeNext(bad), bad).toBe("/app");
    }
    expect(safeNext(null)).toBe("/app");
    expect(safeNext(undefined)).toBe("/app");
  });
});

describe("sign-in messages", () => {
  it("gives the same wording for unknown and wrong, and for any unrecognised code", () => {
    expect(signInErrorMessage("invalid")).toBe(signInErrorMessage("whatever"));
    expect(signInErrorMessage("invalid")).not.toMatch(/exist|found|unknown email/i);
    expect(signInErrorMessage(undefined)).toBeNull();
    expect(signInErrorMessage("no_access")).toMatch(/not active at any hotel/);
  });
  it("classifies what Supabase Auth reports without echoing it", () => {
    expect(classifyAuthError({ status: 400, name: "AuthApiError" })).toBe("invalid");
    expect(classifyAuthError({ status: 429, name: "AuthApiError" })).toBe("rate");
    expect(classifyAuthError({ status: 503, name: "AuthApiError" })).toBe("unavailable");
    expect(classifyAuthError({ name: "AuthRetryableFetchError" })).toBe("unavailable");
  });
});
