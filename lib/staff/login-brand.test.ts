import { describe, expect, it } from "vitest";
import { loginBrand } from "./login-brand";

describe("loginBrand", () => {
  it("takes the hotel's name and logo path", () => {
    expect(loginBrand({ name: "Hotel Ibadan", logo: "t/p/logo.png" })).toEqual({ name: "Hotel Ibadan", mark: "H", logo: "t/p/logo.png" });
  });
  it("trims, and uses the first letter as the mark", () => {
    expect(loginBrand({ name: "  élan Suites ", logo: null })).toEqual({ name: "élan Suites", mark: "É", logo: null });
  });
  it("has no logo when it is blank or missing", () => {
    expect(loginBrand({ name: "A", logo: "   " })?.logo).toBeNull();
    expect(loginBrand({ name: "A" })?.logo).toBeNull();
  });
  it("is null when there is no usable hotel: unknown host, failed lookup, blank or odd name", () => {
    for (const h of [
      null,
      undefined,
      { name: "", logo: null },
      { name: "   ", logo: null },
      { name: null as unknown as string, logo: null },
      { name: 7 as unknown as string, logo: null },
    ]) {
      expect(loginBrand(h)).toBeNull();
    }
  });
});
