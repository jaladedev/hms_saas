import { describe, expect, it } from "vitest";
import { contrastRatio, parseTheme, STANDARD_SWATCH, THEME_IDS, THEMES, themeStyle } from "./theme";

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
