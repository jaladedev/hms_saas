/** Kobo (minor units) to a display string such as "₦2,500.00". */
export function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat("en-NG", { style: "currency", currency }).format(minor / 100);
}

/** "2026-11-03" to "Tue 3 Nov 2026", without any timezone shift. */
export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return isoDate;
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

/** "14:00:00" to "14:00". */
export function formatTime(t: string): string {
  return t.slice(0, 5);
}
