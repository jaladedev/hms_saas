import type { NightAuditErrorCode } from "./night-audit-messages";

export {
  NIGHT_AUDIT_ERROR_MESSAGES,
  NIGHT_AUDIT_OK_MESSAGES,
  type NightAuditErrorCode,
  type NightAuditOkCode,
} from "./night-audit-messages";

/** What the database keeps for a day: the daily report row as it stood. Amounts are kobo. */
export type DayFigures = {
  rooms_sold: number;
  room_revenue_minor: number;
  room_tax_minor: number;
  room_service_minor: number;
  extras_minor: number;
  extras_tax_minor: number;
  cash_in_minor: number;
  refunds_paid_minor: number;
};

export type ItemRef = { reservation_id: string; booking_reference: string };
export type PaymentRef = ItemRef & { amount_minor: number };

export type OpenItems = {
  arrivals_not_checked_in: number;
  arrivals: ItemRef[];
  departures_not_checked_out: number;
  departures: ItemRef[];
  unverified_payments: number;
  unverified_payments_minor: number;
  payments: PaymentRef[];
  total: number;
};

export type AuditPreview = {
  day: string;
  today: string;
  closed: boolean;
  closed_at: string | null;
  override_note: string | null;
  items: OpenItems;
  figures: DayFigures;
  kept_figures: DayFigures | null;
};

export type AuditDay = {
  day: string;
  closed: boolean;
  closed_at: string | null;
  override_note: string | null;
  open_items: number | null;
  figures: DayFigures;
  changed_since_close: boolean | null;
};

const FIGURE_KEYS = [
  "rooms_sold",
  "room_revenue_minor",
  "room_tax_minor",
  "room_service_minor",
  "extras_minor",
  "extras_tax_minor",
  "cash_in_minor",
  "refunds_paid_minor",
] as const satisfies readonly (keyof DayFigures)[];

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** A real calendar day in YYYY-MM-DD, or null. */
export function isDay(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** The day from the address, limited to today or earlier (a later day cannot be closed); anything else is today. */
export function parseDay(value: string | undefined, today: string): string {
  return isDay(value) && value <= today ? value : today;
}

export function parseFigures(data: unknown): DayFigures | null {
  const o = rec(data);
  if (!o) return null;
  const f = {} as DayFigures;
  for (const k of FIGURE_KEYS) f[k] = num(o[k]);
  return f;
}

/** True when the figures a day was closed with differ from what the report says now (rooms available is not compared). */
export function figuresChanged(kept: DayFigures, live: DayFigures): boolean {
  return FIGURE_KEYS.some((k) => kept[k] !== live[k]);
}

function refs<T extends ItemRef>(data: unknown, extra: (o: Record<string, unknown>) => Omit<T, keyof ItemRef>): T[] {
  if (!Array.isArray(data)) return [];
  const out: T[] = [];
  for (const e of data) {
    const o = rec(e);
    const id = o && str(o.reservation_id);
    const ref = o && str(o.booking_reference);
    if (!o || !id || !ref) continue;
    out.push({ reservation_id: id, booking_reference: ref, ...extra(o) } as T);
  }
  return out;
}

export function parseItems(data: unknown): OpenItems | null {
  const o = rec(data);
  if (!o) return null;
  return {
    arrivals_not_checked_in: num(o.arrivals_not_checked_in),
    arrivals: refs<ItemRef>(o.arrivals, () => ({})),
    departures_not_checked_out: num(o.departures_not_checked_out),
    departures: refs<ItemRef>(o.departures, () => ({})),
    unverified_payments: num(o.unverified_payments),
    unverified_payments_minor: num(o.unverified_payments_minor),
    payments: refs<PaymentRef>(o.payments, (p) => ({ amount_minor: num(p.amount_minor) })),
    total: num(o.total),
  };
}

/** Reads what night_audit_preview returned. A malformed answer gives null so the page shows an error instead of wrong numbers. */
export function parsePreview(data: unknown): AuditPreview | null {
  const o = rec(data);
  if (!o) return null;
  const items = parseItems(o.items);
  const figures = parseFigures(o.figures);
  const day = str(o.day);
  const today = str(o.today);
  if (!items || !figures || !day || !today) return null;
  return {
    day,
    today,
    closed: o.closed === true,
    closed_at: str(o.closed_at),
    override_note: str(o.override_note),
    items,
    figures,
    kept_figures: parseFigures(o.kept_figures),
  };
}

/** Reads what night_audit_days returned (newest first). Rows that are not well formed are dropped. */
export function parseDays(data: unknown): AuditDay[] {
  if (!Array.isArray(data)) return [];
  const rows: AuditDay[] = [];
  for (const e of data) {
    const o = rec(e);
    const day = o && str(o.day);
    const figures = o && parseFigures(o.figures);
    if (!o || !day || !figures) continue;
    rows.push({
      day,
      closed: o.closed === true,
      closed_at: str(o.closed_at),
      override_note: str(o.override_note),
      open_items: typeof o.open_items === "number" ? o.open_items : null,
      figures,
      changed_since_close: typeof o.changed_since_close === "boolean" ? o.changed_since_close : null,
    });
  }
  return rows;
}

/** Maps a database refusal to a night audit code, or null when it is not one (the shared classifier then decides). */
export function classifyNightAuditError(message: string): NightAuditErrorCode | null {
  if (/POLICY_VIOLATION: future day/.test(message)) return "na_future";
  if (/POLICY_VIOLATION: day too old/.test(message)) return "na_old";
  if (/POLICY_VIOLATION: day required/.test(message)) return "na_day";
  if (/INVALID_STATE: already closed/.test(message)) return "na_closed";
  if (/POLICY_VIOLATION: open items need a note/.test(message)) return "na_note_needed";
  if (/POLICY_VIOLATION: note length/.test(message)) return "na_note_length";
  return null;
}

/** "3 items open" / "1 item open" / "Nothing open". */
export function openItemsLabel(total: number): string {
  if (total <= 0) return "Nothing open";
  return total === 1 ? "1 item open" : `${total} items open`;
}
