/**
 * The discount limits screen (migration 059). Pure functions, so they can be tested. The database decides who may set a limit
 * (only the owner, `staff.manage`) and which roles can have one; these helpers work out what to show and check the form's shape.
 *
 * A role's limit at a hotel is that hotel's own setting if it has one, otherwise the platform default (`discount_caps`).
 * The roles listed are the ones with a default, which is exactly the roles that can discount.
 */
import { parsePercent, type Parsed } from "./discount";
import type { ErrorCode } from "./refunds";

export type DefaultCap = { role_key: string; max_percent: number | string };
export type OverrideCap = { property_id: string; role_key: string; max_percent: number | string };
export type RoleName = { key: string; name: string };

export type RoleCap = { roleKey: string; name: string; percent: number; defaultPercent: number; source: "override" | "default" };

/** The usual order first, anything else after it by name. */
const ORDER = ["owner", "general_manager", "front_desk"];

export function buildCaps(propertyId: string, defaults: DefaultCap[], overrides: OverrideCap[], roles: RoleName[]): RoleCap[] {
  const name = new Map(roles.map((r) => [r.key, r.name]));
  const mine = new Map(overrides.filter((o) => o.property_id === propertyId).map((o) => [o.role_key, Number(o.max_percent)]));
  return defaults
    .map((d): RoleCap => {
      const own = mine.get(d.role_key);
      return {
        roleKey: d.role_key, name: name.get(d.role_key) ?? d.role_key, defaultPercent: Number(d.max_percent),
        percent: own ?? Number(d.max_percent), source: own === undefined ? "default" : "override",
      };
    })
    .sort((a, b) => {
      const ia = ORDER.indexOf(a.roleKey), ib = ORDER.indexOf(b.roleKey);
      if (ia !== ib) return (ia === -1 ? ORDER.length : ia) - (ib === -1 ? ORDER.length : ib);
      return a.name.localeCompare(b.name);
    });
}

/** "10%", "7.5%", "0%": no trailing zeros. */
export const percentText = (p: number): string => `${Number(p.toFixed(2))}%`;

export const capSummary = (c: RoleCap): string =>
  c.percent === 0 ? "cannot give discounts" : c.percent >= 100 ? "may discount up to a free stay" : `may discount up to ${percentText(c.percent)}`;

/** Prefills the input: 10 -> "10", 7.5 -> "7.5". */
export const percentInput = (p: number): string => String(Number(p.toFixed(2)));

export type CapForm = { property: string; role: string; percent: number | null };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `reset` ("Use the default") wins over the percent field; otherwise the percent must be 0 to 100 with at most two decimals. */
export function parseCapForm(raw: Record<string, FormDataEntryValue | undefined>): Parsed<CapForm> {
  const property = typeof raw.property === "string" && GUID.test(raw.property) ? raw.property : null;
  const role = typeof raw.role === "string" && /^[a-z_]{1,40}$/.test(raw.role) ? raw.role : null;
  if (!property || !role) return { ok: false, code: "bad_request" };
  if (raw.reset !== undefined) return { ok: true, value: { property, role, percent: null } };
  const percent = parsePercent(raw.percent);
  if (percent === null) return { ok: false, code: "dc_cap_percent" };
  return { ok: true, value: { property, role, percent } };
}

export function classifyCapError(message: string): ErrorCode {
  if (/POLICY_VIOLATION: percent/.test(message)) return "dc_cap_percent";
  if (/POLICY_VIOLATION: role/.test(message)) return "dc_cap_role";
  if (/NOT_FOUND/.test(message)) return "not_found";
  return "unknown";
}

export const capResultCode = (data: unknown): "discount_cap_set" | "discount_cap_reset" =>
  (data as { source?: string } | null)?.source === "default" ? "discount_cap_reset" : "discount_cap_set";
