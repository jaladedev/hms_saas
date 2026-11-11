import { saveHotelTheme } from "@/lib/staff/hotel-profile-actions";
import { buttonPrimary, inputClass } from "@/components/staff/ui";
import { normalizeHex, parseTheme, primaryContrast, STANDARD_SWATCH, THEMES, THEME_IDS } from "@/lib/theme";

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
 * Chooses the hotel's look. Each card previews its own colours and heading font with inline styles (the values come from
 * lib/theme.ts, never from the form), so the choice can be seen before it is saved. The radios are real, so the keyboard and
 * screen readers work with no script.
 */
export function ThemePicker({
  propertyId,
  name,
  current,
  primary,
}: {
  propertyId: string;
  name: string;
  current: string | null;
  primary?: string | null;
}) {
  const selected = parseTheme(current) ?? "standard";
  const group = `theme-${propertyId}`;
  const color = normalizeHex(primary);
  const contrast = color ? primaryContrast(color, parseTheme(current)) : [];
  return (
    <form action={saveHotelTheme} className="mt-8">
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
                  defaultChecked={selected === c.value}
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
          {color && <span aria-hidden="true" className="h-8 w-8 rounded border border-line" style={{ background: color }} />}
          <input
            id={`${group}-primary`}
            name="primary"
            defaultValue={color ?? ""}
            placeholder="#0f766e"
            maxLength={7}
            pattern="#[0-9a-fA-F]{6}"
            className={`${inputClass} w-32 font-mono`}
          />
        </div>
        {contrast.length > 0 && (
          <ul className="mt-2 text-xs text-muted">
            {contrast.map((l) => (
              <li key={l.label}>
                {l.label}: {l.ratio}:1 {l.pass ? "(passes)" : "(too low)"}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button type="submit" className={`${buttonPrimary} mt-3`}>
        Save look
      </button>
    </form>
  );
}
