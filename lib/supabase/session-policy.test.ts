import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SESSION_ONLY_COOKIE, sessionCookieOptions, sessionOnlyFlagOptions, wantsRemember } from "./session-policy";

const supabaseOptions = { path: "/", sameSite: "lax" as const, httpOnly: false, maxAge: 34560000 };

describe("sessionCookieOptions", () => {
  it("leaves the options alone when the person chose to stay signed in", () => {
    expect(sessionCookieOptions(supabaseOptions, false)).toEqual(supabaseOptions);
  });

  it("drops the lifetime, and only the lifetime, for a session-only login", () => {
    const out = sessionCookieOptions({ ...supabaseOptions, expires: new Date(Date.now() + 1e9) }, true);
    expect(out).toEqual({ path: "/", sameSite: "lax", httpOnly: false });
    expect(out).not.toHaveProperty("maxAge");
    expect(out).not.toHaveProperty("expires");
  });

  it("does not change the options it was given", () => {
    const given = { ...supabaseOptions };
    sessionCookieOptions(given, true);
    expect(given.maxAge).toBe(34560000);
  });

  it("never touches a cookie that is being removed, or sign-out would leave the session behind", () => {
    const gone = { ...supabaseOptions, maxAge: 0 };
    expect(sessionCookieOptions(gone, true)).toEqual(gone);
    const past = { path: "/", expires: new Date(0) };
    expect(sessionCookieOptions(past, true)).toEqual(past);
    expect(sessionCookieOptions({ path: "/", maxAge: -1 }, true)).toEqual({ path: "/", maxAge: -1 });
  });

  it("copes with no options at all", () => {
    expect(sessionCookieOptions(undefined, true)).toBeUndefined();
    expect(sessionCookieOptions(undefined, false)).toBeUndefined();
  });
});

describe("wantsRemember", () => {
  it("is true only for the value a ticked checkbox sends", () => {
    expect(wantsRemember("on")).toBe(true);
    for (const v of [undefined, null, "", "off", "true", "1", "ON", ["on"], true]) expect(wantsRemember(v)).toBe(false);
  });
});

describe("the flag cookie", () => {
  it("is a session cookie the page's scripts cannot read", () => {
    const o = sessionOnlyFlagOptions(true);
    expect(o).toMatchObject({ path: "/", httpOnly: true, sameSite: "lax", secure: true });
    expect(o).not.toHaveProperty("maxAge");
    expect(o).not.toHaveProperty("expires");
    expect(sessionOnlyFlagOptions(false).secure).toBe(false);
  });
});

describe("every place that writes the session cookies applies the policy", () => {
  // If one writer skipped it, its first token refresh would turn a session-only login back into a year-long one.
  for (const file of ["lib/supabase/server.ts", "proxy.ts"]) {
    it(`${file} reads the flag and passes the options through sessionCookieOptions`, () => {
      const src = readFileSync(file, "utf8");
      expect(src).toContain("SESSION_ONLY_COOKIE");
      expect(src).toMatch(/\.set\(name, value, sessionCookieOptions\(options, sessionOnly\)\)/);
      expect(src).not.toMatch(/\.set\(name, value, options\)/);
    });
  }
  it("sign-in sets the flag when the box is not ticked and clears it when it is; sign-out clears it", () => {
    const src = readFileSync("lib/staff/auth-actions.ts", "utf8");
    expect(src).toContain("!wantsRemember(raw.remember)");
    expect(src).toContain("createClient({ sessionOnly })");
    expect(src).toMatch(/jar\.set\(SESSION_ONLY_COOKIE/);
    expect(src).toMatch(/jar\.delete\(SESSION_ONLY_COOKIE\)/);
    expect(src).toMatch(/\(await cookies\(\)\)\.delete\(SESSION_ONLY_COOKIE\)/);
  });
  it("the cookie's name is what the two readers look for", () => {
    expect(SESSION_ONLY_COOKIE).toBe("hms_session_only");
  });
});
