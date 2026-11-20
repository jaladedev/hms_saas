import { parseAmountToMinor } from "@/lib/staff/money-input";

export const MAX_PRICING_RULES = 40;
export const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export type RuleKind = "occupancy" | "lead_time" | "weekday" | "event";
export const RULE_KINDS: { kind: RuleKind; label: string }[] = [
  { kind: "occupancy", label: "Occupancy (share of rooms taken)" },
  { kind: "lead_time", label: "Days before arrival" },
  { kind: "weekday", label: "Day of the week" },
  { kind: "event", label: "Event dates" },
];

export type RuleForm = {
  propertyId: string;
  ruleId: string | null;
  roomTypeId: string | null;
  name: string;
  kind: RuleKind;
  from: number | null;
  to: number | null;
  weekdays: number[];
  dateFrom: string | null;
  dateTo: string | null;
  percent: number;
  active: boolean;
};
export type RuleCheck = { ok: true; value: RuleForm } | { ok: false; code: "pricing_invalid" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SIGNED_PERCENT = /^-?\d{1,3}(\.\d{1,2})?$/;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function realDate(v: string): boolean {
  if (!DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function wholeNumber(v: string, min: number, max: number): number | null {
  if (!/^\d{1,3}$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}

/** A signed percent such as "-10", "12.5" or "+5" (up to two decimals); null for anything else. The database checks the -50 to 100 range again. */
export function parseSignedPercent(raw: unknown): number | null {
  const s = text(raw).replace(/^\+/, "").replace(/%$/, "");
  if (!SIGNED_PERCENT.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reads the pricing rule form. Weekdays come as checkboxes day1 (Monday) to day7 (Sunday). Only the fields of the chosen kind are kept.
 * The database checks again and decides who may save.
 */
export function parseRuleForm(raw: Record<string, unknown>): RuleCheck {
  const bad = { ok: false, code: "pricing_invalid" } as const;
  const propertyId = text(raw.propertyId);
  const ruleId = text(raw.ruleId);
  const roomTypeId = text(raw.roomTypeId);
  const name = text(raw.name);
  const kind = RULE_KINDS.find((k) => k.kind === raw.kind)?.kind;
  if (!UUID.test(propertyId) || (ruleId !== "" && !UUID.test(ruleId)) || (roomTypeId !== "" && !UUID.test(roomTypeId)) || !kind) return bad;
  if (name.length < 1 || name.length > 60) return bad;
  const percent = parseSignedPercent(raw.percent);
  if (percent === null || percent === 0 || percent < -50 || percent > 100) return bad;

  let from: number | null = null;
  let to: number | null = null;
  let weekdays: number[] = [];
  let dateFrom: string | null = null;
  let dateTo: string | null = null;
  if (kind === "occupancy" || kind === "lead_time") {
    const max = kind === "occupancy" ? 100 : 365;
    from = wholeNumber(text(raw.from), 0, max);
    to = wholeNumber(text(raw.to), 0, max);
    if (from === null || to === null || to < from) return bad;
  } else if (kind === "weekday") {
    weekdays = [1, 2, 3, 4, 5, 6, 7].filter((d) => raw[`day${d}`] === "on");
    if (weekdays.length === 0) return bad;
  } else {
    dateFrom = text(raw.dateFrom);
    dateTo = text(raw.dateTo);
    if (!realDate(dateFrom) || !realDate(dateTo) || dateTo < dateFrom) return bad;
  }
  return {
    ok: true,
    value: {
      propertyId,
      ruleId: ruleId || null,
      roomTypeId: roomTypeId || null,
      name,
      kind,
      from,
      to,
      weekdays,
      dateFrom,
      dateTo,
      percent,
      active: raw.active === "on",
    },
  };
}

export type LimitsForm = { propertyId: string; roomTypeId: string; floor: number | null; ceiling: number | null };
export type LimitsCheck = { ok: true; value: LimitsForm } | { ok: false; code: "pricing_invalid" };

/** Floor and ceiling in naira (up to two decimals), each optional; both empty clears the limits. A floor above the ceiling is refused. */
export function parseLimitsForm(raw: Record<string, unknown>): LimitsCheck {
  const bad = { ok: false, code: "pricing_invalid" } as const;
  const propertyId = text(raw.propertyId);
  const roomTypeId = text(raw.roomTypeId);
  if (!UUID.test(propertyId) || !UUID.test(roomTypeId)) return bad;
  const one = (v: unknown): number | null | undefined => {
    const s = text(v);
    if (s === "") return null;
    const n = parseAmountToMinor(s);
    return n === null || n <= 0 ? undefined : n;
  };
  const floor = one(raw.floor);
  const ceiling = one(raw.ceiling);
  if (floor === undefined || ceiling === undefined) return bad;
  if (floor !== null && ceiling !== null && floor > ceiling) return bad;
  return { ok: true, value: { propertyId, roomTypeId, floor, ceiling } };
}

export type RuleRow = {
  id: string;
  room_type_id: string | null;
  room_type_name: string | null;
  name: string;
  kind: RuleKind;
  band_from: number | null;
  band_to: number | null;
  weekdays: number[];
  date_from: string | null;
  date_to: string | null;
  adjust_percent: number;
  is_active: boolean;
};

/** Reads what pricing_rule_list returned; a row that is not well formed is dropped rather than shown wrong. */
export function parseRuleList(data: unknown): RuleRow[] {
  if (!Array.isArray(data)) return [];
  const rows: RuleRow[] = [];
  for (const r of data) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : null);
    const n = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : null);
    const kind = RULE_KINDS.find((k) => k.kind === o.kind)?.kind;
    const id = s("id");
    const name = s("name");
    const percent =
      typeof o.adjust_percent === "number" ? o.adjust_percent : typeof o.adjust_percent === "string" ? Number(o.adjust_percent) : NaN;
    if (!id || !name || !kind || !Number.isFinite(percent)) continue;
    rows.push({
      id,
      room_type_id: s("room_type_id"),
      room_type_name: s("room_type_name"),
      name,
      kind,
      band_from: n("band_from"),
      band_to: n("band_to"),
      weekdays: Array.isArray(o.weekdays) ? (o.weekdays as unknown[]).filter((d): d is number => typeof d === "number") : [],
      date_from: s("date_from"),
      date_to: s("date_to"),
      adjust_percent: percent,
      is_active: o.is_active === true,
    });
  }
  return rows;
}

/** "+10%", "-5%" or "+12.5%". */
export function percentText(p: number): string {
  return `${p > 0 ? "+" : p < 0 ? "-" : ""}${Math.abs(p)}%`;
}

/** Weekday numbers as short names, with a range for a run: [1,2,3,4,5] is "Mon to Fri", [5,6] is "Fri, Sat". */
export function weekdaysText(days: number[]): string {
  const d = [...new Set(days)].filter((x) => x >= 1 && x <= 7).sort((a, b) => a - b);
  if (d.length === 0) return "no days";
  if (d.length === 7) return "every day";
  const first = d[0] as number;
  const last = d[d.length - 1] as number;
  if (d.length >= 3 && last - first === d.length - 1) return `${WEEKDAY_NAMES[first - 1]} to ${WEEKDAY_NAMES[last - 1]}`;
  return d.map((x) => WEEKDAY_NAMES[x - 1]).join(", ");
}

/** One line for a rule: "Occupancy 70 to 100%", "3 to 14 days before arrival", "Fri, Sat", "12 Dec to 4 Jan". The caller formats dates. */
export function ruleWhenText(
  r: Pick<RuleRow, "kind" | "band_from" | "band_to" | "weekdays" | "date_from" | "date_to">,
  date: (iso: string) => string,
): string {
  switch (r.kind) {
    case "occupancy":
      return `Occupancy ${r.band_from ?? 0} to ${r.band_to ?? 0}%`;
    case "lead_time":
      return `${r.band_from ?? 0} to ${r.band_to ?? 0} days before arrival`;
    case "weekday":
      return weekdaysText(r.weekdays);
    case "event":
      return r.date_from && r.date_to
        ? r.date_from === r.date_to
          ? date(r.date_from)
          : `${date(r.date_from)} to ${date(r.date_to)}`
        : "event";
  }
}

export type LimitRow = {
  room_type_id: string;
  room_type_name: string;
  base_rate_minor: number;
  floor_minor: number | null;
  ceiling_minor: number | null;
};

export function parseLimitsList(data: unknown): LimitRow[] {
  if (!Array.isArray(data)) return [];
  const rows: LimitRow[] = [];
  for (const r of data) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const n = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : null);
    if (typeof o.room_type_id !== "string" || typeof o.room_type_name !== "string") continue;
    rows.push({
      room_type_id: o.room_type_id,
      room_type_name: o.room_type_name,
      base_rate_minor: n("base_rate_minor") ?? 0,
      floor_minor: n("floor_minor"),
      ceiling_minor: n("ceiling_minor"),
    });
  }
  return rows;
}

export type SuggestedNight = {
  night: string;
  current_minor: number;
  /** The price the rules start from (the price before automatic pricing touched the night). */
  base_minor: number;
  /** True when automatic pricing set the current price. */
  auto: boolean;
  suggested_minor: number;
  change_percent: number;
  occupancy_percent: number | null;
  lead_days: number;
  rules: string[];
  limited: "floor" | "ceiling" | null;
};
export type SuggestionType = { room_type_id: string; room_type_name: string; nights: SuggestedNight[] };

export function parseSuggestions(data: unknown): SuggestionType[] {
  if (!Array.isArray(data)) return [];
  const out: SuggestionType[] = [];
  for (const t of data) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    if (typeof o.room_type_id !== "string" || typeof o.room_type_name !== "string" || !Array.isArray(o.nights)) continue;
    const nights: SuggestedNight[] = [];
    for (const raw of o.nights) {
      if (!raw || typeof raw !== "object") continue;
      const n = raw as Record<string, unknown>;
      const num = (v: unknown) =>
        typeof v === "number" && Number.isFinite(v)
          ? v
          : typeof v === "string" && v !== "" && Number.isFinite(Number(v))
            ? Number(v)
            : null;
      const cur = num(n.current_minor);
      const sug = num(n.suggested_minor);
      if (typeof n.night !== "string" || cur === null || sug === null) continue;
      nights.push({
        night: n.night,
        current_minor: cur,
        base_minor: num(n.base_minor) ?? cur,
        auto: n.auto === true,
        suggested_minor: sug,
        change_percent: num(n.change_percent) ?? 0,
        occupancy_percent: num(n.occupancy_percent),
        lead_days: num(n.lead_days) ?? 0,
        rules: Array.isArray(n.rules) ? (n.rules as unknown[]).filter((x): x is string => typeof x === "string") : [],
        limited: n.limited === "floor" || n.limited === "ceiling" ? n.limited : null,
      });
    }
    out.push({ room_type_id: o.room_type_id, room_type_name: o.room_type_name, nights });
  }
  return out;
}

/** How many nights a room type's suggestions would change, and the biggest rise and fall in percent, for the one-line summary. */
export function suggestionSummary(nights: SuggestedNight[]): { changed: number; up: number; down: number } {
  let changed = 0;
  let up = 0;
  let down = 0;
  for (const n of nights) {
    if (n.suggested_minor === n.current_minor || n.current_minor <= 0) continue;
    changed += 1;
    const pct = ((n.suggested_minor - n.current_minor) * 100) / n.current_minor;
    if (pct > up) up = pct;
    if (pct < down) down = pct;
  }
  return { changed, up: Math.round(up * 10) / 10, down: Math.round(down * 10) / 10 };
}

export type AutoApplySettings = {
  auto_apply: boolean;
  last_applied_at: string | null;
  nights_managed: number;
  nights_by_hand: number;
  last_set: number | null;
};

/** The automatic-pricing switch and its last run (pricing_settings_get). Anything unreadable reads as switched off. */
export function parseAutoSettings(data: unknown): AutoApplySettings {
  const o = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const count = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0;
  const sum = o.last_summary && typeof o.last_summary === "object" ? (o.last_summary as Record<string, unknown>) : null;
  return {
    auto_apply: o.auto_apply === true,
    last_applied_at: typeof o.last_applied_at === "string" ? o.last_applied_at : null,
    nights_managed: count(o.nights_managed),
    nights_by_hand: count(o.nights_by_hand),
    last_set: sum ? count(sum.nights_set) : null,
  };
}
