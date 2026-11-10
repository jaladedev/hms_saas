/**
 * Rules for the Profile & Preferences screen. Pure functions, tested without a database. The database (update_my_profile,
 * migration 092) validates again and decides; these checks only spare a round trip and word the answer.
 */

export const DENSITIES = [
  { value: "comfortable", label: "Comfortable", note: "The standard spacing." },
  { value: "compact", label: "Compact", note: "Tighter spacing, so more fits on the screen." },
] as const;
export type Density = (typeof DENSITIES)[number]["value"];

/** Anything that is not a known density is the default, so a bad value in the database or a cookie never breaks a page. */
export function parseDensity(v: unknown): Density {
  return v === "compact" ? "compact" : "comfortable";
}

export type ProfileForm = { full_name: string; phone: string; density: string };

export function checkProfileForm(f: ProfileForm): "profile_name" | "profile_phone" | "profile_density" | null {
  const name = f.full_name.replace(/\s+/g, " ").trim();
  if (name.length === 0 || name.length > 200) return "profile_name";
  if (f.phone.trim().length > 40) return "profile_phone";
  if (!DENSITIES.some((d) => d.value === f.density)) return "profile_density";
  return null;
}

/** Turns a database refusal from update_my_profile into the same codes checkProfileForm uses. */
export function profileErrorCode(message: string): "profile_name" | "profile_phone" | "profile_density" | null {
  if (/POLICY_VIOLATION: name/.test(message)) return "profile_name";
  if (/POLICY_VIOLATION: too long/.test(message)) return "profile_phone";
  if (/POLICY_VIOLATION: density/.test(message)) return "profile_density";
  return null;
}

/** Display text for a permission key such as "guest.manage": the area, and what it lets the person do. */
export type PermissionGroup = { area: string; actions: string[] };

const AREA_LABEL: Record<string, string> = {
  audit: "Audit trail",
  channel: "Booking sources",
  discount: "Discounts",
  folio: "Extras and folio",
  guest: "Guests",
  housekeeping: "Housekeeping",
  invoice: "Invoices",
  maintenance: "Maintenance",
  payment: "Payments",
  property: "Hotel settings",
  rate: "Rates",
  refund: "Refunds",
  report: "Reports",
  reservation: "Reservations",
  room: "Rooms",
  staff: "Staff and access",
  tax: "Tax",
};

const titleCase = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Groups permission keys by the part before the first dot, so a role's dozens of keys read as a short list by area.
 * An area without a friendly name is shown as its key, and a key with no dot is its own area with no action, so a new
 * permission is never hidden just because this file has not heard of it.
 */
export function groupPermissions(keys: readonly string[]): PermissionGroup[] {
  const byArea = new Map<string, Set<string>>();
  for (const key of keys) {
    const dot = key.indexOf(".");
    const area = dot === -1 ? key : key.slice(0, dot);
    const action = dot === -1 ? "" : key.slice(dot + 1).replace(/[._]/g, " ");
    const set = byArea.get(area) ?? new Set<string>();
    if (action) set.add(action);
    byArea.set(area, set);
  }
  return [...byArea]
    .map(([area, actions]) => ({ area: AREA_LABEL[area] ?? titleCase(area), actions: [...actions].sort() }))
    .sort((a, b) => a.area.localeCompare(b.area));
}

export type RoleGrant = { role_name: string; property_id: string | null };

/**
 * One line per role: "Front Desk, all hotels" or "Front Desk, Hotel A". A role held for several hotels is listed once with
 * each hotel's name, so the list stays short for someone who covers a group.
 */
export function describeRoles(grants: readonly RoleGrant[], propertyName: (id: string) => string | undefined): string[] {
  const byRole = new Map<string, { all: boolean; props: Set<string> }>();
  for (const g of grants) {
    const e = byRole.get(g.role_name) ?? { all: false, props: new Set<string>() };
    if (g.property_id === null) e.all = true;
    else e.props.add(propertyName(g.property_id) ?? "a hotel you can no longer see");
    byRole.set(g.role_name, e);
  }
  return [...byRole]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([role, e]) => (e.all ? `${role}, all hotels` : `${role}, ${[...e.props].sort().join(" and ")}`));
}
