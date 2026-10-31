/** "2026-10-31T14:05:00Z" as "31 Oct 2026, 15:05" in the property's own timezone. */
export function formatDateTime(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone }).format(t);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(t) + " UTC";
  }
}

/** "3 hours" / "25 minutes" for how long something has been waiting. */
export function formatAge(minutes: number | null): string {
  if (minutes === null) return "";
  if (minutes < 60) return `${Math.max(minutes, 0)} min`;
  const h = Math.floor(minutes / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} days`;
}
