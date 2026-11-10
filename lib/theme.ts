import type { CSSProperties } from "react";

/**
 * The hotel's look (migration 093). The database records only the name; the colours and fonts each name stands for are here.
 * `null` is the standard look the app has always had (the values in app/globals.css), so a hotel that never chooses is unchanged.
 *
 * A theme is applied by overriding the design tokens on one wrapper element (the staff shell, the guest site), so every class
 * that reads a token (bg-primary, text-muted, border-line, font-display, ...) follows it with no per-screen code.
 *
 * Palettes start from the three themes in the prototype. Two muted colours were darkened because the originals fell below the
 * 4.5:1 contrast WCAG AA asks of body text (Luxury 4.47:1 and Classic 4.26:1 on their own backgrounds); theme.test.ts keeps every
 * theme above that line. The status colours (amber for pending, red for critical) are the same in every theme on purpose, so a
 * warning looks the same in any hotel.
 */
export const THEME_IDS = ["luxury", "modern", "classic"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export type Theme = {
  id: ThemeId;
  label: string;
  blurb: string;
  colors: {
    primary: string; // buttons, links, active marks; white text sits on it
    primaryStrong: string; // links and hover on the page background
    paper: string; // page background
    ink: string; // body text
    muted: string; // secondary text
    line: string; // borders
    sidebar: string; // navigation background; white text sits on it
    sidebarDeep: string; // a second, slightly lighter navigation tone
  };
  fonts: { display: string; body: string };
};

const SANS = '"Inter", ui-sans-serif, system-ui, sans-serif';

export const THEMES: Record<ThemeId, Theme> = {
  luxury: {
    id: "luxury",
    label: "Luxury",
    blurb: "Deep navy and cream with an elegant serif for headings.",
    colors: {
      primary: "#0A1931",
      primaryStrong: "#0A1931",
      paper: "#F8F6F0",
      ink: "#0A1931",
      muted: "#5F6675",
      line: "#E5E7EB",
      sidebar: "#0A1931",
      sidebarDeep: "#14284A",
    },
    fonts: { display: '"Playfair Display", ui-serif, Georgia, serif', body: SANS },
  },
  modern: {
    id: "modern",
    label: "Modern",
    blurb: "Fresh teal and mint with a clean geometric heading.",
    colors: {
      primary: "#0F766E",
      primaryStrong: "#115E59",
      paper: "#F0FDF5",
      ink: "#0F172A",
      muted: "#64748B",
      line: "#E2E8F0",
      sidebar: "#0F172A",
      sidebarDeep: "#1E293B",
    },
    fonts: { display: '"Sora", ui-sans-serif, system-ui, sans-serif', body: SANS },
  },
  classic: {
    id: "classic",
    label: "Classic",
    blurb: "Forest green and parchment, set in a traditional serif.",
    colors: {
      primary: "#1B4332",
      primaryStrong: "#1B4332",
      paper: "#FEFAE0",
      ink: "#1B4332",
      muted: "#7A6444",
      line: "#E9D5B5",
      sidebar: "#1B4332",
      sidebarDeep: "#2D5A44",
    },
    fonts: { display: '"Lora", ui-serif, Georgia, serif', body: '"Source Serif 4", ui-serif, Georgia, serif' },
  },
};

/** A stored theme name, or null for anything else (the standard look). Unknown values never reach a style attribute. */
export function parseTheme(value: unknown): ThemeId | null {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value) ? (value as ThemeId) : null;
}

/** The standard look's colours, for showing it beside the others in the picker. Mirrors app/globals.css. */
export const STANDARD_SWATCH = { primary: "#0f766e", paper: "#faf8f4", ink: "#1b2430", sidebar: "#0f1b2d" } as const;

/** Token overrides for a theme as an inline style, or undefined for the standard look (no override at all). */
export function themeStyle(id: ThemeId | null): CSSProperties | undefined {
  if (!id) return undefined;
  const t = THEMES[id];
  return {
    "--color-primary": t.colors.primary,
    "--color-primary-strong": t.colors.primaryStrong,
    "--color-paper": t.colors.paper,
    "--color-ink": t.colors.ink,
    "--color-muted": t.colors.muted,
    "--color-line": t.colors.line,
    "--color-navy-900": t.colors.sidebar,
    "--color-navy-800": t.colors.sidebarDeep,
    "--font-sans": t.fonts.body,
    "--font-display": t.fonts.display,
  } as CSSProperties;
}

/** Classes for the wrapper that carries the override: the page colour, text colour and body font follow the theme there. */
export const THEME_WRAPPER_CLASS = "bg-paper font-sans text-ink";

// ---- contrast (WCAG 2.x) ----------------------------------------------------------------------------------------------

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
}

/** WCAG contrast ratio between two #rrggbb colours: 1 (identical) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
