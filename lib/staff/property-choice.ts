/** Which property a page shows when it can show only one. Pure, so the rule is tested without a server. */

export const ACTIVE_PROPERTY_COOKIE = "hms_property";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isPropertyId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/**
 * The property from the address (?property=) wins, so a link always opens what it says. Next comes the one the person
 * picked in the header, then the first. A remembered id the person can no longer see (access removed, property closed)
 * is ignored rather than trusted: the choice only ever comes from `list`, which the database already limited.
 */
export function pickProperty<T extends { id: string }>(
  list: readonly T[],
  requested: string | undefined,
  remembered: string | undefined,
): T | undefined {
  return list.find((p) => p.id === requested) ?? list.find((p) => p.id === remembered) ?? list[0];
}

/** Where to return after switching: only a path inside /app, never another site. Anything else goes to the overview. */
export function returnPath(value: string | null | undefined): string {
  if (!value || value.length > 500) return "/app";
  if (!/^\/app(?:[/?#]|$)/.test(value)) return "/app";
  // eslint-disable-next-line no-control-regex
  if (/[\\\s\u0000-\u001f]/.test(value) || value.includes("//")) return "/app";
  return value;
}

/** The path with any ?property= removed, so the person's new choice is not overridden by an old link. */
export function withoutPropertyParam(path: string): string {
  const [base, query = ""] = path.split("?", 2) as [string, string?];
  const [q, hash] = query.split("#", 2) as [string, string?];
  const params = new URLSearchParams(q);
  params.delete("property");
  const s = params.toString();
  return `${base}${s ? `?${s}` : ""}${hash ? `#${hash}` : ""}`;
}
