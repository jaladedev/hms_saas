/** CSV helpers shared by the report downloads. Amounts are written in major units (naira) with two decimals. Pure, so they can be tested. */

/** Kobo to "1234.50", exactly, with no floating point. */
export function major(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(minor));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** One CSV field: quoted when it holds a comma, quote, or line break; a leading = + - @ is neutralised so a spreadsheet never runs it. */
export function csvField(v: string | number): string {
  let s = String(v);
  if (typeof v === "string" && /^[=+@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvFileName(propertyName: string, from: string, to: string): string {
  const slug =
    propertyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "hotel";
  return `report-${slug}-${from}-to-${to}.csv`;
}
