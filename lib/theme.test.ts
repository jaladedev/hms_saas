import { describe, expect, it } from "vitest";
import {
  BODY_FONTS,
  DISPLAY_FONTS,
  lookStyle,
  parseBodyFont,
  parseDisplayFont,
  parseRadius,
  RADII,
  previewStyle,
  STANDARD_STYLE,
  contrastRatio,
  darken,
  normalizeHex,
  parseTheme,
  primaryContrast,
  strongShade,
  STANDARD_SWATCH,
  THEME_IDS,
  THEMES,
  themeStyle,
} from "./theme";

const WHITE = "#ffffff";
// The status colours every theme keeps (app/globals.css).
const PENDING = "#b45309";
const CRITICAL = "#b91c1c";
const AA = 4.5;

describe("parseTheme", () => {
  it("accepts the three names and nothing else", () => {
    for (const id of THEME_IDS) expect(parseTheme(id)).toBe(id);
    for (const bad of ["Luxury", "neon", "", " modern", null, undefined, 3, {}, ["luxury"], "<script>"]) expect(parseTheme(bad)).toBeNull();
  });
});

describe("themeStyle", () => {
  it("leaves the standard look alone", () => {
    expect(themeStyle(null)).toBeUndefined();
  });
  it("overrides exactly the tokens the app reads, with real values", () => {
    const style = themeStyle("modern") as Record<string, string>;
    expect(Object.keys(style).sort()).toEqual(
      [
        "--color-ink",
        "--color-line",
        "--color-muted",
        "--color-navy-800",
        "--color-navy-900",
        "--color-paper",
        "--color-primary",
        "--color-primary-strong",
        "--font-display",
        "--font-sans",
      ].sort(),
    );
    for (const v of Object.values(style)) expect(v).not.toMatch(/undefined|null|[;{}<>]/);
    expect(style["--color-primary"]).toBe("#0F766E");
  });
  it("uses only well-formed colours", () => {
    for (const t of Object.values(THEMES)) for (const c of Object.values(t.colors)) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});

describe("contrast", () => {
  it("measures the known extremes", () => {
    expect(contrastRatio("#000000", WHITE)).toBeCloseTo(21, 5);
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 5);
  });

  const all = [
    {
      name: "standard",
      c: {
        primary: STANDARD_SWATCH.primary,
        primaryStrong: "#115e59",
        paper: STANDARD_SWATCH.paper,
        ink: STANDARD_SWATCH.ink,
        muted: "#5b6573",
        sidebar: STANDARD_SWATCH.sidebar,
      },
    },
    ...Object.values(THEMES).map((t) => ({ name: t.id, c: t.colors })),
  ];

  for (const { name, c } of all) {
    describe(`${name} theme`, () => {
      it("keeps body and secondary text readable on the page and on white cards", () => {
        for (const bg of [c.paper, WHITE]) {
          expect(contrastRatio(c.ink, bg)).toBeGreaterThanOrEqual(AA);
          expect(contrastRatio(c.muted, bg)).toBeGreaterThanOrEqual(AA);
        }
      });
      it("keeps buttons, links and the navigation readable", () => {
        expect(contrastRatio(WHITE, c.primary)).toBeGreaterThanOrEqual(AA); // white text on a primary button
        expect(contrastRatio(c.primary, c.paper)).toBeGreaterThanOrEqual(AA); // primary links on the page
        expect(contrastRatio(c.primary, WHITE)).toBeGreaterThanOrEqual(AA); // primary links on a white card
        expect(contrastRatio(c.primaryStrong, c.paper)).toBeGreaterThanOrEqual(AA);
        expect(contrastRatio(WHITE, c.sidebar)).toBeGreaterThanOrEqual(AA); // white navigation text
      });
      it("keeps the amber and red status text readable on the page", () => {
        expect(contrastRatio(PENDING, c.paper)).toBeGreaterThanOrEqual(AA);
        expect(contrastRatio(CRITICAL, c.paper)).toBeGreaterThanOrEqual(AA);
      });
    });
  }

  it("keeps the sidebar's lighter tone dark enough for white text", () => {
    for (const t of Object.values(THEMES)) expect(contrastRatio(WHITE, t.colors.sidebarDeep)).toBeGreaterThanOrEqual(AA);
  });
});

describe("main colour", () => {
  it("normalizeHex keeps only six-digit hex colours, lower case", () => {
    expect(normalizeHex(" #0F766E ")).toBe("#0f766e");
    for (const bad of ["#fff", "0f766e", "red", "", null, 3]) expect(normalizeHex(bad)).toBeNull();
  });
  it("strongShade reads on the page colour and never lightens", () => {
    for (const c of ["#0f766e", "#2563eb", "#c6a96b"])
      for (const paper of ["#faf8f4", "#f0fdf5"]) expect(contrastRatio(strongShade(c, paper), paper)).toBeGreaterThanOrEqual(AA);
    expect(darken("#336699", 0)).toBe("#336699");
  });
  it("primaryContrast fails a pale colour and passes a deep one", () => {
    expect(primaryContrast("#ffff00", null).some((l) => !l.pass)).toBe(true);
    expect(primaryContrast("#7c2d12", "classic" as never).every((l) => l.pass)).toBe(true);
  });
  it("themeStyle lays the colour over a theme, and works on the standard look", () => {
    const over = themeStyle("luxury", "#7c2d12") as Record<string, string>;
    expect(over["--color-primary"]).toBe("#7c2d12");
    expect(over["--color-paper"]).toBe(THEMES.luxury.colors.paper);
    const alone = themeStyle(null, "#7c2d12") as Record<string, string>;
    expect(alone["--color-primary"]).toBe("#7c2d12");
    expect(alone["--color-paper"]).toBeUndefined();
    expect(themeStyle(null, null)).toBeUndefined();
    expect(themeStyle(null, "teal")).toBeUndefined();
    expect((themeStyle("modern", "teal") as Record<string, string>)["--color-primary"]).toBe(THEMES.modern.colors.primary);
  });
});

describe("fonts", () => {
  it("parse only the listed keys", () => {
    expect(parseDisplayFont("outfit")).toBe("outfit");
    expect(parseBodyFont("source-serif")).toBe("source-serif");
    for (const bad of ["inter", "Outfit", "comic-sans", "", null, 3]) expect(parseDisplayFont(bad)).toBeNull();
    for (const bad of ["sora", "Inter", "", null]) expect(parseBodyFont(bad)).toBeNull();
    expect(DISPLAY_FONTS.length).toBe(4);
    expect(BODY_FONTS.length).toBe(2);
  });
  it("lookStyle is empty for the standard look and ignores unknown values", () => {
    expect(lookStyle({})).toBeUndefined();
    expect(lookStyle({ theme: "neon", primary: "teal", fontDisplay: "x", fontBody: "y" })).toBeUndefined();
  });
  it("lookStyle sets fonts alone, and over a theme", () => {
    const alone = lookStyle({ fontDisplay: "outfit" }) as Record<string, string>;
    expect(alone["--font-display"]).toContain("Outfit");
    expect(alone["--font-sans"]).toBeUndefined();
    const over = lookStyle({ theme: "luxury", fontDisplay: "sora", fontBody: "source-serif" }) as Record<string, string>;
    expect(over["--font-display"]).toContain("Sora");
    expect(over["--font-sans"]).toContain("Source Serif 4");
    expect(over["--color-paper"]).toBe(THEMES.luxury.colors.paper);
    const own = lookStyle({ theme: "luxury" }) as Record<string, string>;
    expect(own["--font-display"]).toContain("Playfair");
  });
  it("previewStyle always sets every token, so it never shows the hotel's saved look", () => {
    const std = previewStyle({}) as Record<string, string>;
    for (const k of Object.keys(STANDARD_STYLE)) expect(std[k], k).toBeTruthy();
    const mixed = previewStyle({ theme: "classic", primary: "#7c2d12", fontBody: "inter" }) as Record<string, string>;
    expect(mixed["--color-primary"]).toBe("#7c2d12");
    expect(mixed["--color-paper"]).toBe(THEMES.classic.colors.paper);
    expect(mixed["--font-sans"]).toContain("Inter");
  });
});

describe("corners", () => {
  it("parse only the listed keys", () => {
    expect(parseRadius("sharp")).toBe("sharp");
    expect(parseRadius("round")).toBe("round");
    for (const bad of ["Round", "pill", "8px", "", null, 3]) expect(parseRadius(bad)).toBeNull();
    expect(RADII.length).toBe(2);
  });
  it("lookStyle sets every corner token, and nothing for an unknown key", () => {
    expect(lookStyle({ radius: "pill" })).toBeUndefined();
    const sharp = lookStyle({ radius: "sharp" }) as Record<string, string>;
    for (const k of ["base", "sm", "md", "lg", "xl", "2xl"]) expect(sharp[`--radius-${k}`], k).toBe("0rem");
    const over = lookStyle({ theme: "luxury", radius: "round" }) as Record<string, string>;
    expect(over["--radius-2xl"]).toBe("1.5rem");
    expect(over["--color-paper"]).toBe(THEMES.luxury.colors.paper);
  });
  it("the standard preview carries the standard corners, so choosing Standard shows them again", () => {
    const std = previewStyle({}) as Record<string, string>;
    expect(std["--radius-base"]).toBe("0.25rem");
    expect((previewStyle({ radius: "sharp" }) as Record<string, string>)["--radius-lg"]).toBe("0rem");
  });
});
