"use client";

import { useState } from "react";
import {
  BODY_FONTS,
  DISPLAY_FONTS,
  normalizeHex,
  parseBodyFont,
  parseRadius,
  RADII,
  parseDisplayFont,
  parseTheme,
  previewStyle,
  primaryContrast,
  STANDARD_SWATCH,
  THEME_IDS,
  THEME_WRAPPER_CLASS,
  THEMES,
} from "@/lib/theme";

type Choice = {
  value: string;
  label: string;
  blurb: string;
  paper: string;
  ink: string;
  primary: string;
  sidebar: string;
  display: string;
};

const CHOICES: Choice[] = [
  {
    value: "standard",
    label: "Standard",
    blurb: "The look HMS has always had: navy navigation, teal buttons, warm white.",
    paper: STANDARD_SWATCH.paper,
    ink: STANDARD_SWATCH.ink,
    primary: STANDARD_SWATCH.primary,
    sidebar: STANDARD_SWATCH.sidebar,
    display: '"Playfair Display", ui-serif, Georgia, serif',
  },
  ...THEME_IDS.map((id) => {
    const t = THEMES[id];
    return {
      value: id,
      label: t.label,
      blurb: t.blurb,
      paper: t.colors.paper,
      ink: t.colors.ink,
      primary: t.colors.primary,
      sidebar: t.colors.sidebar,
      display: t.fonts.display,
    };
  }),
];

/**
 * The hotel's look form with a live preview. Everything shown is computed from lib/theme.ts as the person changes the fields, and
 * nothing is saved until they press the button. The form fields are real, so with no script the form still posts. The server
 * action and the class names come in as props so this file imports only the pure theme rules.
 */
export function ThemeEditor({
  action,
  propertyId,
  name,
  current,
  primary,
  fontDisplay,
  fontBody,
  radius,
  buttonClass,
  inputClass,
}: {
  action: (formData: FormData) => void | Promise<void>;
  propertyId: string;
  name: string;
  current: string | null;
  primary?: string | null;
  fontDisplay?: string | null;
  fontBody?: string | null;
  radius?: string | null;
  buttonClass: string;
  inputClass: string;
}) {
  const group = `theme-${propertyId}`;
  const [theme, setTheme] = useState<string>(parseTheme(current) ?? "standard");
  const [color, setColor] = useState<string>(normalizeHex(primary) ?? "");
  const [display, setDisplay] = useState<string>(parseDisplayFont(fontDisplay) ?? "");
  const [body, setBody] = useState<string>(parseBodyFont(fontBody) ?? "");
  const [corners, setCorners] = useState<string>(parseRadius(radius) ?? "");

  const themeId = parseTheme(theme);
  const hex = normalizeHex(color);
  const colorBad = color.trim() !== "" && !hex;
  const contrast = hex ? primaryContrast(hex, themeId) : [];
  const failing = contrast.some((l) => !l.pass);
  const style = previewStyle({ theme: themeId, primary: hex, fontDisplay: display, fontBody: body, radius: corners });
  const dirty =
    theme !== (parseTheme(current) ?? "standard") ||
    (hex ?? "") !== (normalizeHex(primary) ?? "") ||
    display !== (parseDisplayFont(fontDisplay) ?? "") ||
    body !== (parseBodyFont(fontBody) ?? "") ||
    corners !== (parseRadius(radius) ?? "");

  return (
    <form action={action} className="mt-8">
      <input type="hidden" name="propertyId" value={propertyId} />
      <fieldset>
        <legend className="text-sm font-medium">Look and feel</legend>
        <p className="mt-1 max-w-prose text-sm text-muted">
          Colours and fonts for {name}&rsquo;s website and for the staff screens when working in this hotel. Statuses such as &ldquo;Needs
          attention&rdquo; keep their amber and red in every look.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {CHOICES.map((c) => (
            <label
              key={c.value}
              htmlFor={`${group}-${c.value}`}
              className="flex cursor-pointer flex-col gap-2 rounded border border-line bg-white p-3 has-[:checked]:border-primary has-[:checked]:ring-2 has-[:checked]:ring-primary"
            >
              <span className="flex items-center gap-2">
                <input
                  id={`${group}-${c.value}`}
                  type="radio"
                  name="theme"
                  value={c.value}
                  checked={theme === c.value}
                  onChange={() => setTheme(c.value)}
                  className="accent-primary"
                />
                <span className="font-medium">{c.label}</span>
              </span>
              <span aria-hidden="true" className="flex h-16 overflow-hidden rounded border border-line">
                <span className="w-1/4" style={{ background: c.sidebar }} />
                <span className="flex flex-1 flex-col justify-center gap-1 px-3" style={{ background: c.paper, color: c.ink }}>
                  <span className="text-sm" style={{ fontFamily: c.display }}>
                    Deluxe Room
                  </span>
                  <span className="inline-block w-fit rounded px-2 py-0.5 text-xs text-white" style={{ background: c.primary }}>
                    Book now
                  </span>
                </span>
              </span>
              <span className="text-xs text-muted">{c.blurb}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-4">
        <label htmlFor={`${group}-primary`} className="text-sm font-medium">
          Main colour (optional)
        </label>
        <p className="mt-1 max-w-prose text-sm text-muted">
          Replaces the look&rsquo;s own button and link colour. Enter six hex digits such as #0f766e, or leave it blank. It is refused if
          white text cannot be read on it (WCAG AA, 4.5 to 1).
        </p>
        <div className="mt-2 flex items-center gap-3">
          <input
            type="color"
            aria-label="Pick a main colour"
            value={hex ?? "#0f766e"}
            onChange={(e) => setColor(e.target.value)}
            className="h-9 w-9 cursor-pointer rounded border border-line bg-white p-0.5"
          />
          <input
            id={`${group}-primary`}
            name="primary"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            placeholder="#0f766e"
            maxLength={7}
            pattern="#[0-9a-fA-F]{6}"
            aria-invalid={colorBad}
            className={`${inputClass} w-32! font-mono`}
          />
          {color !== "" && (
            <button type="button" onClick={() => setColor("")} className="text-sm text-primary-strong underline">
              Use the look&rsquo;s own
            </button>
          )}
        </div>
        {colorBad && <p className="mt-2 text-xs text-critical">Six hex digits with a #, such as #0f766e.</p>}
        {contrast.length > 0 && (
          <ul className="mt-2 text-xs text-muted" aria-live="polite">
            {contrast.map((l) => (
              <li key={l.label} className={l.pass ? "" : "text-critical"}>
                {l.label}: {l.ratio}:1 {l.pass ? "(passes)" : "(too low: choose a darker colour)"}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4 grid max-w-xl gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${group}-fd`} className="text-sm font-medium">
            Heading font (optional)
          </label>
          <select
            id={`${group}-fd`}
            name="fontDisplay"
            value={display}
            onChange={(e) => setDisplay(e.target.value)}
            className={`${inputClass} mt-1 w-full`}
          >
            <option value="">The look&rsquo;s own</option>
            {DISPLAY_FONTS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${group}-fb`} className="text-sm font-medium">
            Body font (optional)
          </label>
          <select
            id={`${group}-fb`}
            name="fontBody"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className={`${inputClass} mt-1 w-full`}
          >
            <option value="">The look&rsquo;s own</option>
            {BODY_FONTS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-3 max-w-xs">
        <label htmlFor={`${group}-radius`} className="text-sm font-medium">
          Corners (optional)
        </label>
        <select
          id={`${group}-radius`}
          name="radius"
          value={corners}
          onChange={(e) => setCorners(e.target.value)}
          className={`${inputClass} mt-1 w-full`}
        >
          <option value="">Standard</option>
          {RADII.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-5">
        <h3 className="text-sm font-medium">Preview</h3>
        <p className="text-xs text-muted">How the choices above look on a staff screen. Not saved until you press the button.</p>
        <div
          aria-hidden="true"
          data-testid="theme-preview"
          className={`mt-2 flex max-w-xl overflow-hidden rounded border border-line ${THEME_WRAPPER_CLASS}`}
          style={style}
        >
          <div className="w-28 shrink-0 bg-navy-900 p-3 text-xs text-white">
            <div className="font-display text-base">HMS</div>
            <div className="mt-3 space-y-1 text-white/80">
              <div>Overview</div>
              <div>Reservations</div>
              <div>Rooms</div>
            </div>
          </div>
          <div className="flex-1 p-4">
            <h4 className="font-display text-xl">Reservations</h4>
            <p className="mt-1 text-sm text-muted">Arrivals today and rooms to turn over.</p>
            <div className="mt-3 rounded border border-line bg-white p-3 text-sm">
              <div className="font-medium">Deluxe Room · 2 nights</div>
              <a className="text-primary-strong underline">View booking</a>
            </div>
            <span className="mt-3 inline-block rounded bg-primary px-3 py-1.5 text-sm text-white">Check in</span>
            <span className="ml-2 inline-block rounded bg-pending/10 px-2 py-1 text-xs text-pending">Needs attention</span>
          </div>
        </div>
      </div>

      <button type="submit" disabled={colorBad || failing} className={`${buttonClass} mt-4 disabled:opacity-50`}>
        Save look
      </button>
      {dirty && <span className="ml-3 text-xs text-muted">Unsaved changes</span>}
    </form>
  );
}
