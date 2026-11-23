import { describe, expect, it } from "vitest";
import {
  classifyThemeDraftError,
  draftChanges,
  isThemeImageKind,
  joinChanges,
  MAX_FAVICON_BYTES,
  MAX_HERO_BYTES,
  themeImagePath,
  validateThemeImage,
  type ThemeLook,
} from "./theme-images";

const look = (over: Partial<ThemeLook> = {}): ThemeLook => ({
  theme: null,
  theme_primary: null,
  theme_font_display: null,
  theme_font_body: null,
  theme_radius: null,
  favicon_path: null,
  hero_path: null,
  ...over,
});

describe("validateThemeImage", () => {
  it("accepts jpeg, png and webp within each kind's limit", () => {
    for (const [type, ext] of [
      ["image/jpeg", "jpg"],
      ["image/png", "png"],
      ["image/webp", "webp"],
    ] as const) {
      expect(validateThemeImage("favicon", { type, size: MAX_FAVICON_BYTES })).toEqual({ ok: true, contentType: type, ext });
      expect(validateThemeImage("hero", { type, size: MAX_HERO_BYTES })).toEqual({ ok: true, contentType: type, ext });
    }
  });
  it("holds a favicon to a smaller size than a hero image", () => {
    expect(validateThemeImage("favicon", { type: "image/png", size: MAX_FAVICON_BYTES + 1 })).toEqual({
      ok: false,
      code: "theme_image_file",
    });
    expect(validateThemeImage("hero", { type: "image/png", size: MAX_FAVICON_BYTES + 1 }).ok).toBe(true);
    expect(validateThemeImage("hero", { type: "image/png", size: MAX_HERO_BYTES + 1 })).toEqual({ ok: false, code: "theme_image_file" });
  });
  it("refuses svg, gif, pdf, empty files and a missing file", () => {
    for (const type of ["image/svg+xml", "image/gif", "application/pdf"]) {
      expect(validateThemeImage("hero", { type, size: 10 })).toEqual({ ok: false, code: "theme_image_file" });
    }
    expect(validateThemeImage("hero", { type: "image/png", size: 0 })).toEqual({ ok: false, code: "theme_image_file" });
    expect(validateThemeImage("hero", null)).toEqual({ ok: false, code: "theme_image_file" });
  });
});

describe("themeImagePath and isThemeImageKind", () => {
  it("builds tenant / property / kind / id . extension", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(themeImagePath("favicon", "t", "p", id, "png")).toBe(`t/p/favicon/${id}.png`);
    expect(themeImagePath("hero", "t", "p", id, "jpg")).toBe(`t/p/hero/${id}.jpg`);
  });
  it("knows favicon and hero only", () => {
    expect(isThemeImageKind("favicon")).toBe(true);
    expect(isThemeImageKind("hero")).toBe(true);
    expect(isThemeImageKind("logo")).toBe(false);
    expect(isThemeImageKind(null)).toBe(false);
  });
});

describe("draftChanges and joinChanges", () => {
  it("lists exactly what differs, in a fixed order", () => {
    expect(draftChanges(look(), look())).toEqual([]);
    expect(draftChanges(look(), look({ theme: "luxury", theme_primary: "#0f766e", hero_path: "a" }))).toEqual([
      "theme",
      "main colour",
      "hero image",
    ]);
    expect(
      draftChanges(
        look({ favicon_path: "x" }),
        look({ favicon_path: null, theme_radius: "round", theme_font_body: "inter", theme_font_display: "lora" }),
      ),
    ).toEqual(["heading font", "body font", "corners", "favicon"]);
  });
  it("reads a list in words", () => {
    expect(joinChanges([])).toBe("");
    expect(joinChanges(["theme"])).toBe("theme");
    expect(joinChanges(["theme", "favicon"])).toBe("theme and favicon");
    expect(joinChanges(["theme", "main colour", "favicon"])).toBe("theme, main colour and favicon");
  });
});

describe("classifyThemeDraftError", () => {
  it("maps database refusals to our codes", () => {
    expect(classifyThemeDraftError({ message: "INVALID_STATE: no draft" })).toBe("theme_no_draft");
    expect(classifyThemeDraftError({ message: "NOT_FOUND" })).toBe("setup_forbidden");
    expect(classifyThemeDraftError({ code: "42501" })).toBe("setup_forbidden");
    expect(classifyThemeDraftError({ message: "POLICY_VIOLATION: image kind" })).toBe("theme_image_file");
    expect(classifyThemeDraftError({ code: "23514" })).toBe("theme_image_file");
    expect(classifyThemeDraftError({ message: "INVALID_COLOR" })).toBe("setup_invalid");
    expect(classifyThemeDraftError({ message: "boom" })).toBe("unknown");
  });
});
