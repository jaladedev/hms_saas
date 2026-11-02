/**
 * Setup history (`/app/settings/history`): who changed the hotel's setup, and what changed. Pure functions, so they
 * can be tested. The page reads `audit_logs` as the signed-in person; the table's row-level security shows a row only
 * to people with audit.view at that row's property, so nothing here decides who may see what.
 *
 * What counts as setup: room types and rooms, the rate plan and nightly prices, tax rules, and who was given or lost
 * a role. Rows are written by triggers (migrations 024 and 028) and by the staff functions (019); this file only
 * words them. Names are looked up from the live tables by id, because an update row records the changed columns and
 * not the thing's name; a deleted thing falls back to the name stored with the row.
 */
import { guestSummary, readConfig } from "./policies";
import type { TaxRuleRow } from "./tax-rules";

export type AuditRow = {
  id: string;
  property_id: string | null;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export const AUDIT_COLUMNS = "id, property_id, actor_user_id, action, entity_type, entity_id, metadata, created_at";
export const PAGE_SIZE = 50;

export const HISTORY_FILTERS = [
  { value: "all", label: "Everything" },
  { value: "rooms", label: "Room types and rooms" },
  { value: "rates", label: "Rates" },
  { value: "tax", label: "Tax rules" },
  { value: "policies", label: "Cancellation and payment policies" },
  { value: "staff", label: "Staff access" },
] as const;
export type HistoryFilter = (typeof HISTORY_FILTERS)[number]["value"];

/** Explicit action names, not prefixes: `room.blocked` and `room.transferred` also start with "room." and are not setup. */
export const FILTER_ACTIONS: Record<Exclude<HistoryFilter, "all">, string[]> = {
  rooms: ["room_type.created", "room_type.updated", "room_type.deleted", "room.created", "room.updated", "room.deleted"],
  rates: ["rate_plan.created", "rate_plan.updated", "rate_plan.deleted", "rates.set", "rates.changed", "rates.cleared"],
  tax: ["tax_rule.created", "tax_rule.updated", "tax_rule.deleted"],
  policies: ["property_policy.created"],
  staff: ["staff.role_added", "staff.role_removed", "staff.status_changed"],
};
export const actionsFor = (what: HistoryFilter): string[] =>
  what === "all" ? Object.values(FILTER_ACTIONS).flat() : FILTER_ACTIONS[what];

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads ?property=&what=&page= from the URL. Anything unrecognised falls back to the default. */
export function parseHistoryFilters(search: Search): { property: string | null; what: HistoryFilter; page: number } {
  const property = one(search.property);
  const what = one(search.what);
  const page = Number(one(search.page));
  return {
    property: property && GUID.test(property) ? property : null,
    what: HISTORY_FILTERS.some((f) => f.value === what) ? (what as HistoryFilter) : "all",
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
}

/** The query string for a link, leaving out what is already the default. */
export function historyQuery(f: { property: string | null; what: HistoryFilter; page: number }, over: Partial<{ page: number }> = {}): string {
  const page = over.page ?? f.page;
  const p = new URLSearchParams();
  if (f.property) p.set("property", f.property);
  if (f.what !== "all") p.set("what", f.what);
  if (page > 1) p.set("page", String(page));
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

export type Lookup = {
  roomTypes: Map<string, string>;
  rooms: Map<string, string>;
  ratePlans: Map<string, string>;
  taxRules: Map<string, Pick<TaxRuleRow, "name" | "basis">>;
  /** user id to display name; a person the viewer may not see is simply absent */
  people: Map<string, string>;
  /** role key to role name */
  roles: Map<string, string>;
  properties: Map<string, string>;
};
export type Format = { money: (minor: number) => string; date: (isoDate: string) => string };

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const asString = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** The ids on a page of history that need a name, by kind. Includes ids inside the metadata. */
export function collectIds(rows: AuditRow[]): { roomTypes: string[]; rooms: string[]; ratePlans: string[]; taxRules: string[]; users: string[] } {
  const sets = { roomTypes: new Set<string>(), rooms: new Set<string>(), ratePlans: new Set<string>(), taxRules: new Set<string>(), users: new Set<string>() };
  const add = (set: Set<string>, v: unknown) => { if (typeof v === "string" && GUID.test(v)) set.add(v); };
  for (const r of rows) {
    add(sets.users, r.actor_user_id);
    const m = asRecord(r.metadata);
    if (r.entity_type === "room_type") add(sets.roomTypes, r.entity_id);
    if (r.entity_type === "room") add(sets.rooms, r.entity_id);
    if (r.entity_type === "rate_plan") add(sets.ratePlans, r.entity_id);
    if (r.entity_type === "tax_rule") add(sets.taxRules, r.entity_id);
    if (r.entity_type === "membership") add(sets.users, m.user_id);
    add(sets.ratePlans, m.rate_plan_id);
    const changed = asRecord(m.changed);
    const roomTypeChange = asRecord(changed.room_type_id);
    add(sets.roomTypes, roomTypeChange.from);
    add(sets.roomTypes, roomTypeChange.to);
    add(sets.roomTypes, asRecord(m.values).room_type_id);
  }
  return Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, [...v]])) as ReturnType<typeof collectIds>;
}

export function actorName(row: Pick<AuditRow, "actor_user_id">, people: Map<string, string>): string {
  if (!row.actor_user_id) return "The system";
  return people.get(row.actor_user_id) ?? "A staff member";
}

const LABELS: Record<string, string> = {
  name: "Name", code: "Code", slug: "Web address", description: "Description", bed_config: "Beds",
  max_adults: "Most adults", max_children: "Most children", max_occupancy: "Most people in all",
  base_rate_minor: "Standard price a night", currency: "Currency", is_public: "Bookable online", status: "Status",
  room_number: "Room number", floor: "Floor", room_type_id: "Room type", operational_status: "Service status",
  is_default: "Standard plan", cancellation_policy: "Cancellation policy", payment_policy: "Payment policy",
  basis: "Kind of tax", rate_value: "Rate", sequence: "Order", compounds: "Applied on top of earlier rules",
  effective_from: "First day", effective_to: "Last day", applies_to_charges: "Taxes extras",
};
export const fieldLabel = (key: string): string => LABELS[key] ?? key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

const WORDS: Record<string, Record<string, string>> = {
  status: { active: "Active", inactive: "Switched off" },
  operational_status: { active: "In service", out_of_service: "Out of service", retired: "Retired" },
  basis: { percent: "A percentage of the night's price", fixed_per_night: "A fixed amount each night" },
};

/** One value as a person reads it. `basis` is the tax rule's kind, which decides what a rate means. */
export function formatValue(key: string, value: unknown, lookup: Lookup, fmt: Format, basis?: string | null): string {
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return "changed";
  if (key.endsWith("_minor")) {
    const n = asNumber(value);
    return n === null ? String(value) : fmt.money(n);
  }
  if (key === "rate_value") {
    const n = asNumber(value);
    if (n === null) return String(value);
    if (basis === "percent") return `${Number.parseFloat(n.toFixed(4))}%`;
    if (basis === "fixed_per_night") return `${fmt.money(Math.round(n))} a night`;
    return String(n);
  }
  if ((key === "effective_from" || key === "effective_to") && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return fmt.date(value);
  if (key === "room_type_id" && typeof value === "string") return lookup.roomTypes.get(value) ?? "another room type";
  const word = WORDS[key]?.[String(value)];
  return word ?? String(value);
}

/** The name of the thing a row is about: its live name, else the name stored with the row, else a plain noun. */
export function entityName(row: AuditRow, lookup: Lookup): string {
  const values = asRecord(asRecord(row.metadata).values);
  const id = row.entity_id ?? "";
  switch (row.entity_type) {
    case "room_type": return lookup.roomTypes.get(id) ?? asString(values.name) ?? "a room type";
    case "room": {
      const number = lookup.rooms.get(id) ?? asString(values.room_number);
      return number ? `room ${number}` : "a room";
    }
    case "rate_plan": return lookup.ratePlans.get(id) ?? asString(values.name) ?? "a rate plan";
    case "tax_rule": return lookup.taxRules.get(id)?.name ?? asString(values.name) ?? "a tax rule";
    default: return "something";
  }
}

const NOUN: Record<string, string> = { room_type: "room type", room: "", rate_plan: "rate plan", tax_rule: "tax rule" };
const nameWithNoun = (type: string, name: string) => {
  const noun = NOUN[type];
  // "room 101" already says what it is; a fallback like "a room type" does too.
  return !noun || name.startsWith("a ") ? name : `the ${noun} \u201c${name}\u201d`;
};

function priceRange(lo: unknown, hi: unknown, fmt: Format): string | null {
  const a = asNumber(lo);
  const b = asNumber(hi);
  if (a === null || b === null) return null;
  return a === b ? fmt.money(a) : `${fmt.money(a)} to ${fmt.money(b)}`;
}

function nightsLine(m: Record<string, unknown>, fmt: Format): string | null {
  const nights = asNumber(m.nights);
  const from = asString(m.from);
  const to = asString(m.to);
  if (nights === null) return null;
  const count = `${nights} ${nights === 1 ? "night" : "nights"}`;
  if (!from || !to) return count;
  return from === to ? `${count}: ${fmt.date(from)}` : `${count}: ${fmt.date(from)} to ${fmt.date(to)}`;
}

function personName(m: Record<string, unknown>, lookup: Lookup): string {
  const id = asString(m.user_id);
  return (id && lookup.people.get(id)) || "a staff member";
}
const roleName = (m: Record<string, unknown>, lookup: Lookup): string => {
  const key = asString(m.role);
  return (key && lookup.roles.get(key)) || key || "a role";
};
const scopeOf = (m: Record<string, unknown>, lookup: Lookup): string => {
  const p = asString(m.property_id);
  return p ? lookup.properties.get(p) ?? "one property" : "all properties";
};

/** A sentence for the row, and the lines of detail under it (what changed, from and to). */
export function describeEvent(row: AuditRow, lookup: Lookup, fmt: Format): { summary: string; details: string[] } {
  const m = asRecord(row.metadata);
  const [family, verb] = row.action.split(".");
  const name = entityName(row, lookup);

  // Nightly prices: one row per room type per statement
  if (family === "rates") {
    const target = nameWithNoun("room_type", name);
    const nights = nightsLine(m, fmt);
    if (verb === "set") {
      const price = priceRange(m.amount_minor_min, m.amount_minor_max, fmt);
      return { summary: `Set nightly prices for ${target}`, details: [nights, price ? `Price: ${price}` : null].filter((x): x is string => x !== null) };
    }
    if (verb === "changed") {
      const was = priceRange(m.old_amount_minor_min, m.old_amount_minor_max, fmt);
      const now = priceRange(m.new_amount_minor_min, m.new_amount_minor_max, fmt);
      return { summary: `Changed nightly prices for ${target}`, details: [nights, was && now ? `Price: ${was} \u2192 ${now}` : null].filter((x): x is string => x !== null) };
    }
    if (verb === "cleared") {
      const was = priceRange(m.old_amount_minor_min, m.old_amount_minor_max, fmt);
      return { summary: `Cleared nightly prices for ${target}, which go back to the standard price`, details: [nights, was ? `Was: ${was}` : null].filter((x): x is string => x !== null) };
    }
  }

  if (row.entity_type === "membership") {
    const person = personName(m, lookup);
    if (row.action === "staff.role_added") {
      return { summary: `${m.new_member === true ? "Added" : "Gave"} ${person} ${m.new_member === true ? "as" : "the role"} ${roleName(m, lookup)}`, details: [`Covers: ${scopeOf(m, lookup)}`] };
    }
    if (row.action === "staff.role_removed") return { summary: `Removed the role ${roleName(m, lookup)} from ${person}`, details: [`Covered: ${scopeOf(m, lookup)}`] };
    if (row.action === "staff.status_changed") return { summary: `Changed ${person}'s access from ${asString(m.from) ?? "unknown"} to ${asString(m.to) ?? "unknown"}`, details: [] };
  }

  // A published policy version (migration 031): the sentences guests would read, not the raw settings.
  if (row.action === "property_policy.created") {
    const values = asRecord(m.values);
    const version = asNumber(values.version);
    const from = asString(values.effective_from);
    return {
      summary: `Published ${version === null ? "a new policy version" : `policy version ${version}`}${from ? `, starting ${fmt.date(from)}` : ""}`,
      details: guestSummary(readConfig(values.config), fmt.money),
    };
  }

  if (verb === "created" || verb === "deleted") {
    const values = asRecord(m.values);
    const basis = asString(values.basis);
    const details = Object.entries(values)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${fieldLabel(k)}: ${formatValue(k, v, lookup, fmt, basis)}`);
    return { summary: `${verb === "created" ? "Added" : "Removed"} ${nameWithNoun(row.entity_type, name)}`, details };
  }

  if (verb === "updated") {
    const changed = asRecord(m.changed);
    const basis = (row.entity_id && lookup.taxRules.get(row.entity_id)?.basis) || null;
    const details = Object.entries(changed).map(([k, change]) => {
      const c = asRecord(change);
      const label = fieldLabel(k);
      if (typeof c.from === "object" && c.from !== null || typeof c.to === "object" && c.to !== null) return `${label} changed`;
      return `${label}: ${formatValue(k, c.from, lookup, fmt, basis)} \u2192 ${formatValue(k, c.to, lookup, fmt, basis)}`;
    });
    return { summary: `Changed ${nameWithNoun(row.entity_type, name)}`, details };
  }

  return { summary: row.action, details: [] };
}
