import { describe, expect, it } from "vitest";
import {
  afterSignIn,
  callbackTarget,
  classifyAuthError,
  classifyUpdateError,
  resetErrorMessage,
  safeNext,
  signInErrorMessage,
  signInNotice,
  siteOrigin,
  validateNewPassword,
} from "./auth";

describe("safeNext", () => {
  it("keeps paths inside /app, with their query", () => {
    expect(safeNext("/app")).toBe("/app");
    expect(safeNext("/app/refunds")).toBe("/app/refunds");
    expect(safeNext("/app/reservations/abc/settlement?ok=requested")).toBe("/app/reservations/abc/settlement?ok=requested");
  });
  it("refuses anything that could leave the site or the staff area", () => {
    for (const bad of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/app//evil.example",
      "/application",
      "/appx/refunds",
      "/login",
      "/",
      "app/refunds",
      "javascript:alert(1)",
      "/app/x\nSet-Cookie: a=b",
      "/app/ x",
      "",
      "/app/" + "a".repeat(600),
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

describe("recovery flow rules", () => {
  it("only lets the callback land on the reset page or inside /app", () => {
    expect(callbackTarget("/reset-password")).toBe("/reset-password");
    expect(callbackTarget("/app/refunds")).toBe("/app/refunds");
    for (const bad of ["https://evil.example", "//evil.example", "/reset-password/../x", "/login", null, undefined, ""]) {
      expect(callbackTarget(bad), String(bad)).toBe("/app");
    }
  });
  it("validates a new password", () => {
    expect(validateNewPassword("abcdefghij", "abcdefghij")).toBeNull();
    expect(validateNewPassword("abcdefghij", "abcdefghik")).toBe("mismatch");
    expect(validateNewPassword("short", "short")).toBe("short");
    expect(validateNewPassword("a".repeat(72), "a".repeat(72))).toBeNull();
    expect(validateNewPassword("a".repeat(73), "a".repeat(73))).toBe("long");
    expect(validateNewPassword("é".repeat(37), "é".repeat(37))).toBe("long"); // 74 bytes, 37 characters
  });
  it("words every problem and never echoes raw auth text", () => {
    for (const c of ["mismatch", "short", "long", "same", "weak", "expired", "unavailable", "anything"]) {
      expect(resetErrorMessage(c)).toBeTruthy();
    }
    expect(resetErrorMessage(undefined)).toBeNull();
    expect(classifyUpdateError({ code: "same_password", status: 422 })).toBe("same");
    expect(classifyUpdateError({ code: "weak_password", status: 422 })).toBe("weak");
    expect(classifyUpdateError({ code: "session_not_found", status: 403 })).toBe("expired");
    expect(classifyUpdateError({ status: 500 })).toBe("unavailable");
  });
  it("builds the recovery link origin only from a plausible host", () => {
    const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });
    expect(siteOrigin(h({ host: "hotel.example.com", "x-forwarded-proto": "https" }), true)).toBe("https://hotel.example.com");
    expect(siteOrigin(h({ host: "localhost:3000" }), false)).toBe("http://localhost:3000");
    expect(siteOrigin(h({ host: "a.example", "x-forwarded-host": "b.example, c.example", "x-forwarded-proto": "https, http" }), true)).toBe(
      "https://b.example",
    );
    expect(siteOrigin(h({ host: "x.example" }), true)).toBe("https://x.example");
    for (const bad of ["evil.example/path", "a b", "a.example@evil.example", "", "-bad.example"]) {
      expect(siteOrigin(h({ host: bad }), true), bad).toBeNull();
    }
  });
  it("shows the reset notice only for the known code", () => {
    expect(signInNotice("reset")).toMatch(/password was changed/);
    expect(signInNotice("x")).toBeNull();
  });
});

describe("safeNext and /platform", () => {
  it("allows paths inside /platform and nothing that only starts with the word", () => {
    expect(safeNext("/platform")).toBe("/platform");
    expect(safeNext("/platform/5e0bf524-147f-43a5-8476-e0baecadd7e9?ok=created")).toBe(
      "/platform/5e0bf524-147f-43a5-8476-e0baecadd7e9?ok=created",
    );
    expect(safeNext("/platformer")).toBe("/app");
    expect(safeNext("/platform//evil.example")).toBe("/app");
    expect(safeNext("/platform\\evil")).toBe("/app");
  });
});

describe("afterSignIn", () => {
  const member = { member: true, platform: false };
  const both = { member: true, platform: true };
  const platformOnly = { member: false, platform: true };
  it("sends a hotel member where they were going, or to /app", () => {
    expect(afterSignIn(undefined, member)).toBe("/app");
    expect(afterSignIn("/app/refunds", member)).toBe("/app/refunds");
  });
  it("sends a platform admin with no hotel to /platform, whatever the default", () => {
    expect(afterSignIn(undefined, platformOnly)).toBe("/platform");
    expect(afterSignIn("/app/refunds", platformOnly)).toBe("/platform");
    expect(afterSignIn("/platform/abc", platformOnly)).toBe("/platform/abc");
  });
  it("lets someone who is both go where they asked", () => {
    expect(afterSignIn("/platform", both)).toBe("/platform");
    expect(afterSignIn("/app/guests", both)).toBe("/app/guests");
    expect(afterSignIn(undefined, both)).toBe("/app");
  });
  it("never sends a hotel member into /platform", () => {
    expect(afterSignIn("/platform", member)).toBe("/app");
    expect(afterSignIn("/platform/abc", member)).toBe("/app");
  });
});
