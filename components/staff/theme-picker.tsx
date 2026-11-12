import { buttonPrimary, inputClass } from "@/components/staff/ui";
import { ThemeEditor } from "@/components/staff/theme-editor";
import { saveHotelTheme } from "@/lib/staff/hotel-profile-actions";

/**
 * Chooses the hotel's look: theme, optional main colour and optional fonts, with a live preview (the client part is
 * `ThemeEditor`). This wrapper only supplies the server action and the staff screens' control classes.
 */
export function ThemePicker({
  propertyId,
  name,
  current,
  primary,
  fontDisplay,
  fontBody,
  radius,
}: {
  propertyId: string;
  name: string;
  current: string | null;
  primary?: string | null;
  fontDisplay?: string | null;
  fontBody?: string | null;
  radius?: string | null;
}) {
  return (
    <ThemeEditor
      action={saveHotelTheme}
      propertyId={propertyId}
      name={name}
      current={current}
      primary={primary}
      fontDisplay={fontDisplay}
      fontBody={fontBody}
      radius={radius}
      buttonClass={buttonPrimary}
      inputClass={inputClass}
    />
  );
}
