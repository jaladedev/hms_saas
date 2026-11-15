import { parseAmountToMinor } from "@/lib/staff/money-input";
import { parsePercent } from "@/lib/staff/discount";

export const MAX_PROMO_CODES = 50;
export const MAX_PROMO_PERCENT = 90;

export type PromoForm = {
  propertyId: string;
  promoId: string | null;
  code: string;
  kind: "percent" | "amount";
  /** Percent (1 to 90) or an amount in minor units, by kind. */
  value: number;
  validFrom: string;
  validTo: string;
  minNights: number;
  maxUses: number | null;
  active: boolean;
};
export type PromoCheck = { ok: true; value: PromoForm } | { ok: false; code: "promo_invalid" | "promo_dates" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Z0-9_-]{3,24}$/;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function realDate(v: string): boolean {
  if (!DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Reads the promo code form. The code is made upper case; "percent" reads 1 to 90 with up to two decimals, "amount" reads naira with
 * up to two decimals and keeps minor units. Empty dates and an empty "uses" mean no limit. The database checks again and decides who may save.
 */
export function parsePromoForm(raw: Record<string, unknown>): PromoCheck {
  const propertyId = text(raw.propertyId);
  const promoId = text(raw.promoId);
  const code = text(raw.code).toUpperCase();
  const kind = raw.kind === "amount" ? "amount" : raw.kind === "percent" ? "percent" : null;
  const validFrom = text(raw.validFrom);
  const validTo = text(raw.validTo);
  if (!UUID.test(propertyId) || (promoId !== "" && !UUID.test(promoId)) || !kind) return { ok: false, code: "promo_invalid" };
  if (!CODE.test(code)) return { ok: false, code: "promo_invalid" };

  let value: number;
  if (kind === "percent") {
    const p = parsePercent(raw.percent);
    if (p === null || p < 1 || p > MAX_PROMO_PERCENT) return { ok: false, code: "promo_invalid" };
    value = p;
  } else {
    const a = parseAmountToMinor(text(raw.amount));
    if (a === null || a <= 0) return { ok: false, code: "promo_invalid" };
    value = a;
  }

  const minRaw = text(raw.minNights);
  const minNights = minRaw === "" ? 1 : Number(minRaw);
  if (!Number.isInteger(minNights) || minNights < 1 || minNights > 30) return { ok: false, code: "promo_invalid" };
  const maxRaw = text(raw.maxUses);
  const maxUses = maxRaw === "" ? null : Number(maxRaw);
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100000)) return { ok: false, code: "promo_invalid" };

  if ((validFrom !== "" && !realDate(validFrom)) || (validTo !== "" && !realDate(validTo))) return { ok: false, code: "promo_dates" };
  if (validFrom !== "" && validTo !== "" && validTo < validFrom) return { ok: false, code: "promo_dates" };

  return {
    ok: true,
    value: { propertyId, promoId: promoId || null, code, kind, value, validFrom, validTo, minNights, maxUses, active: raw.active === "on" },
  };
}

export type PromoRow = {
  id: string;
  code: string;
  kind: "percent" | "amount";
  percent: number | null;
  amount_minor: number | null;
  valid_from: string | null;
  valid_to: string | null;
  min_nights: number;
  max_uses: number | null;
  is_active: boolean;
  ever_used: boolean;
  used: number;
  remaining: number | null;
};

/** Reads what promo_code_list returned; a row that is not well formed is dropped rather than shown wrong. */
export function parsePromoList(data: unknown): PromoRow[] {
  if (!Array.isArray(data)) return [];
  const rows: PromoRow[] = [];
  for (const r of data) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : null);
    const n = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : null);
    const kind = o.kind === "amount" ? "amount" : o.kind === "percent" ? "percent" : null;
    const id = s("id");
    const code = s("code");
    if (!id || !code || !kind) continue;
    rows.push({
      id,
      code,
      kind,
      percent: n("percent"),
      amount_minor: n("amount_minor"),
      valid_from: s("valid_from"),
      valid_to: s("valid_to"),
      min_nights: n("min_nights") ?? 1,
      max_uses: n("max_uses"),
      is_active: o.is_active === true,
      ever_used: o.ever_used === true,
      used: n("used") ?? 0,
      remaining: n("remaining"),
    });
  }
  return rows;
}

/** "10% off" or "5,000 off" (the caller formats the money). */
export function promoValueText(row: Pick<PromoRow, "kind" | "percent" | "amount_minor">, money: (minor: number) => string): string {
  if (row.kind === "percent") return `${row.percent ?? 0}% off`;
  return `${money(row.amount_minor ?? 0)} off`;
}

/** What a guest can book in: "any day", "from 1 Dec", "until 31 Dec", "1 Dec to 31 Dec". The caller formats the dates. */
export function promoWindowText(from: string | null, to: string | null, date: (iso: string) => string): string {
  if (from && to) return `${date(from)} to ${date(to)}`;
  if (from) return `from ${date(from)}`;
  if (to) return `until ${date(to)}`;
  return "any day";
}
