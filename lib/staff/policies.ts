/**
 * Cancellation and payment policies screen (`/app/settings/policies`): wording and input checks. Pure functions, so
 * they can be tested. The database decides who may write (property_policies insert needs property.configure) and
 * how a rule is applied (`cancel_reservation`, `create_payment_attempt`, `check_in`); this file only turns a form
 * into the JSON those functions already read, and the JSON back into sentences.
 *
 * A policy is versioned: saving inserts a new `property_policies` row, never an edit. A booking copies the policy
 * in force on the day it is made into its own snapshot, so a new version never changes a booking already made.
 * Keys this screen does not manage (for example `check_in_time`) are carried over from the previous version.
 */
import { z } from "zod";
import { parseAmountToMinor } from "./money-input";

export type ChargeType = "percent" | "nights" | "fixed";
export type CancellationRule = { within_hours: number; charge: { type: ChargeType; value: number } };
export type OnlinePayment = { mode: "full" } | { mode: "deposit_percent"; value: number };
export type CheckinPayment = "none" | "full";
/** Whether guests may cancel from their booking link (migration 038). Read from the policy in force today, not the booking's snapshot. */
export type GuestCancellation = "on" | "off";
/** What leaving early means for the price (migration 060): "none" keeps the whole price, "credit" takes unused nights off, "one_night" keeps tonight's. */
export type EarlyCheckout = "none" | "credit" | "one_night";

export type PolicyConfig = {
  cancellation_rules: CancellationRule[];
  online_payment: OnlinePayment;
  checkin_payment: CheckinPayment;
  guest_cancellation: GuestCancellation;
  early_checkout: EarlyCheckout;
  /** How many days before arrival a guest may be checked in (migration 061): 0 is off, 1 to 7 is on. */
  early_checkin_days: number;
  /** Whether guests may edit their phone and send change requests from their booking link (migration 069): off unless the key says "on". */
  guest_changes: "on" | "off";
  /** Dates and room requests close this many hours before arrival (migration 069). 48 when the key is absent. */
  guest_change_hours: number;
};

export type PolicyRow = { id: string; property_id: string; version: number; effective_from: string; config: Record<string, unknown> };
export const POLICY_COLUMNS = "id, property_id, version, effective_from, config";

export const MAX_RULES = 8;
export const MAX_WINDOW_HOURS = 24 * 365;
export const MAX_NIGHTS = 30;

export const CHARGE_LABEL: Record<ChargeType, string> = { percent: "Percent of the total", nights: "First nights", fixed: "Fixed amount" };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** The managed part of a stored config, read defensively: anything unusable is dropped, never guessed at. */
export function readConfig(config: unknown): PolicyConfig {
  const c = isObject(config) ? config : {};
  const rules: CancellationRule[] = [];
  if (Array.isArray(c.cancellation_rules)) {
    for (const r of c.cancellation_rules) {
      if (!isObject(r) || !isObject(r.charge)) continue;
      const hours = Number(r.within_hours);
      const type = r.charge.type;
      const value = Number(r.charge.value);
      if (!Number.isFinite(hours) || hours < 0 || !Number.isFinite(value) || value < 0) continue;
      if (type !== "percent" && type !== "nights" && type !== "fixed") continue;
      rules.push({ within_hours: hours, charge: { type, value } });
    }
  }
  const op = isObject(c.online_payment) ? c.online_payment : {};
  const pct = Number(op.value);
  const online: OnlinePayment = op.mode === "deposit_percent" && Number.isFinite(pct) && pct > 0 && pct <= 100
    ? { mode: "deposit_percent", value: pct } : { mode: "full" };
  return { cancellation_rules: sortRules(rules), online_payment: online, checkin_payment: c.checkin_payment === "full" ? "full" : "none", guest_cancellation: c.guest_cancellation === "off" ? "off" : "on", early_checkout: c.early_checkout === "credit" || c.early_checkout === "one_night" ? c.early_checkout : "none", early_checkin_days: Number.isInteger(c.early_checkin_days) && (c.early_checkin_days as number) >= 1 && (c.early_checkin_days as number) <= 7 ? (c.early_checkin_days as number) : 0, guest_changes: c.guest_changes === "on" ? "on" : "off", guest_change_hours: Number.isInteger(c.guest_change_hours) && (c.guest_change_hours as number) >= 0 && (c.guest_change_hours as number) <= 720 ? (c.guest_change_hours as number) : 48 };
}

/** Widest window first, the order a person reads them in. The database picks the smallest window that still covers the time left. */
export function sortRules(rules: CancellationRule[]): CancellationRule[] {
  return [...rules].sort((a, b) => b.within_hours - a.within_hours);
}

/** "7 days", "48 hours", "check-in time": how a window reads. */
export function describeWindow(hours: number): string {
  if (hours === 0) return "after check-in time";
  if (hours % 24 === 0) { const d = hours / 24; return `${d} ${d === 1 ? "day" : "days"} or less before check-in`; }
  return `${hours} ${hours === 1 ? "hour" : "hours"} or less before check-in`;
}

export function describeCharge(c: CancellationRule["charge"], formatMinor: (minor: number) => string): string {
  const v = Number.parseFloat(c.value.toFixed(4));
  if (c.type === "percent") return v >= 100 ? "the full stay" : `${v}% of the total`;
  if (c.type === "nights") return v === 1 ? "the first night of each room" : `the first ${v} nights of each room`;
  return formatMinor(Math.round(c.value));
}

/** The sentences a guest would read on the reserve page. */
export function guestSummary(cfg: PolicyConfig, formatMinor: (minor: number) => string): string[] {
  const lines: string[] = [];
  lines.push(cfg.online_payment.mode === "deposit_percent"
    ? `Pay a ${Number.parseFloat(cfg.online_payment.value.toFixed(4))}% deposit online to confirm your booking. The balance is due at the hotel.`
    : "Pay the full amount online to confirm your booking.");
  if (cfg.checkin_payment === "full") lines.push("The booking must be fully paid before check-in.");
  const rules = cfg.cancellation_rules;
  const widest = rules[0];
  if (!widest) {
    lines.push("You can cancel free of charge at any time before check-in.");
  } else {
    lines.push(widest.within_hours > 0 ? `Cancel free of charge until ${describeWindow(widest.within_hours).replace(" or less before check-in", "")} before check-in.` : "Cancel free of charge until check-in time.");
    for (const r of rules) lines.push(`${r.within_hours === 0 ? "After check-in time" : `Within ${describeWindow(r.within_hours).replace(" or less before check-in", "")} of check-in`}, you pay ${describeCharge(r.charge, formatMinor)}.`);
  }
  if (cfg.guest_cancellation === "off") lines.push("To cancel, contact the hotel: bookings cannot be cancelled online.");
  return lines;
}

export type PolicyField = "rules" | "deposit" | "date";
export type PolicyInput = Record<string, unknown>;

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
function isoDate(v: unknown): string | null {
  const m = ISO.exec(clean(v, 10));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const GUID = z.guid();

/**
 * The form's fields, checked. Rules arrive as parallel fields `rule_hours_0`, `rule_type_0`, `rule_value_0`, and a
 * row with every field empty is skipped (an unused slot). A fixed amount is typed in naira and stored as kobo.
 */
export function validatePolicy(input: PolicyInput):
  | { ok: true; value: { propertyId: string; effectiveFrom: string; config: PolicyConfig } }
  | { ok: false; code: "policy_invalid"; field: PolicyField } {
  const bad = (field: PolicyField) => ({ ok: false as const, code: "policy_invalid" as const, field });
  const propertyId = GUID.safeParse(input.propertyId);
  if (!propertyId.success) return bad("rules");
  const effectiveFrom = isoDate(input.effectiveFrom);
  if (!effectiveFrom) return bad("date");

  const rules: CancellationRule[] = [];
  for (let i = 0; i < MAX_RULES; i++) {
    const hours = clean(input[`rule_hours_${i}`], 8);
    const type = clean(input[`rule_type_${i}`], 10);
    const value = clean(input[`rule_value_${i}`], 20);
    if (hours === "" && value === "") continue;
    if (!/^\d{1,4}$/.test(hours)) return bad("rules");
    const h = Number(hours);
    if (h > MAX_WINDOW_HOURS) return bad("rules");
    let v: number | null;
    if (type === "percent") {
      const m = /^(\d{1,3}(?:\.\d{1,2})?)\s*%?$/.exec(value);
      v = m ? Number(m[1]) : null;
      if (v === null || v <= 0 || v > 100) return bad("rules");
    } else if (type === "nights") {
      v = /^\d{1,2}$/.test(value) ? Number(value) : null;
      if (v === null || v < 1 || v > MAX_NIGHTS) return bad("rules");
    } else if (type === "fixed") {
      v = parseAmountToMinor(value);
      if (v === null) return bad("rules");
    } else return bad("rules");
    rules.push({ within_hours: h, charge: { type, value: v } });
  }
  // Two rules with the same window would be ambiguous: the database takes whichever it meets first.
  if (new Set(rules.map((r) => r.within_hours)).size !== rules.length) return bad("rules");

  const mode = clean(input.onlineMode, 20);
  let online: OnlinePayment;
  if (mode === "full") online = { mode: "full" };
  else if (mode === "deposit_percent") {
    const m = /^(\d{1,3}(?:\.\d{1,2})?)\s*%?$/.exec(clean(input.depositPercent, 10));
    const pct = m ? Number(m[1]) : NaN;
    if (!(pct > 0 && pct <= 100)) return bad("deposit");
    online = { mode: "deposit_percent", value: pct };
  } else return bad("deposit");

  const checkin = clean(input.checkinPayment, 10);
  if (checkin !== "none" && checkin !== "full") return bad("rules");

  // A form from before this field existed leaves it out: that means "on", as a policy without the key does.
  const guestCancel = input.guestCancellation === undefined ? "on" : clean(input.guestCancellation, 5);
  if (guestCancel !== "on" && guestCancel !== "off") return bad("rules");

  // Likewise a form from before this field existed means "keep the whole price".
  const early = input.earlyCheckout === undefined ? "none" : clean(input.earlyCheckout, 10);
  if (early !== "none" && early !== "credit" && early !== "one_night") return bad("rules");

  // And a form from before early check-in existed means "not allowed". The field is whole days, 0 to 7.
  const eciRaw = input.earlyCheckinDays === undefined ? "0" : clean(input.earlyCheckinDays, 3);
  if (!/^[0-7]$/.test(eciRaw)) return bad("rules");
  const earlyCheckinDays = Number(eciRaw);

  // Guest changes: a form from before this existed means "off" and the usual 48 hours. The window is whole hours, 0 to 720.
  const guestChanges = input.guestChanges === undefined ? "off" : clean(input.guestChanges, 5);
  if (guestChanges !== "on" && guestChanges !== "off") return bad("rules");
  const gchRaw = input.guestChangeHours === undefined ? "48" : clean(input.guestChangeHours, 4);
  if (!/^\d{1,3}$/.test(gchRaw) || Number(gchRaw) > 720) return bad("rules");
  const guestChangeHours = Number(gchRaw);

  return { ok: true, value: { propertyId: propertyId.data, effectiveFrom, config: { cancellation_rules: sortRules(rules), online_payment: online, checkin_payment: checkin, guest_cancellation: guestCancel, early_checkout: early, early_checkin_days: earlyCheckinDays, guest_changes: guestChanges, guest_change_hours: guestChangeHours } } };
}

/**
 * The config to store: the previous version's keys this screen does not manage are kept, the managed ones replaced.
 *
 * `checkin_payment` is stored only as "full". "No payment needed at check-in" is the key being absent, which is what
 * check_in (008) and guest_policy (032) read, and what the database check in migration 035 requires: it refuses any
 * other value, so writing "none" would make every such policy fail to save.
 */
export function mergeConfig(previous: unknown, next: PolicyConfig): Record<string, unknown> {
  const base = isObject(previous) ? { ...previous } : {};
  delete base.cancellation_rules; delete base.online_payment; delete base.checkin_payment; delete base.guest_cancellation; delete base.early_checkout; delete base.early_checkin_days; delete base.guest_changes; delete base.guest_change_hours;
  const { checkin_payment, early_checkout, early_checkin_days, guest_changes, guest_change_hours, ...rest } = next;
  // Both are stored only when they say something: an absent key is "no payment needed" and "keep the whole price".
  return { ...base, ...rest, ...(checkin_payment === "full" ? { checkin_payment } : {}), ...(early_checkout !== "none" ? { early_checkout } : {}), ...(early_checkin_days > 0 ? { early_checkin_days } : {}), ...(guest_changes === "on" ? { guest_changes } : {}), ...(guest_changes === "on" && guest_change_hours !== 48 ? { guest_change_hours } : {}) };
}

/**
 * A new version must start on or after today at the property, and after the latest version already stored: a
 * version dated before the newest one would never be read (the database takes the latest start date that has come).
 */
export function checkEffectiveDate(effectiveFrom: string, today: string, latestFrom: string | null): "ok" | "past" | "not_after_latest" {
  if (effectiveFrom < today) return "past";
  if (latestFrom !== null && effectiveFrom <= latestFrom) return "not_after_latest";
  return "ok";
}

/** The version in force on a date, the next one scheduled, and the number to give a new version. */
export function versionsOn(rows: Pick<PolicyRow, "version" | "effective_from">[], today: string): { current: number | null; upcoming: number | null; nextVersion: number } {
  const sorted = [...rows].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  const started = sorted.filter((r) => r.effective_from <= today);
  const later = sorted.filter((r) => r.effective_from > today);
  const maxVersion = rows.reduce((m, r) => Math.max(m, r.version), 0);
  return { current: started.at(-1)?.version ?? null, upcoming: later[0]?.version ?? null, nextVersion: maxVersion + 1 };
}

/** Which refusal a failed write means: the database's own words are never shown. */
export function classifyPolicyError(err: { code?: string; message?: string }): "policy_forbidden" | "policy_conflict" | "policy_invalid" | "unknown" {
  const msg = err.message ?? "";
  if (err.code === "42501" || /row-level security/i.test(msg)) return "policy_forbidden";
  if (err.code === "23505") return "policy_conflict";
  // Migration 043: the database's own date rules. Losing a race to another person's newer version means reload; a past date is invalid.
  if (/POLICY_VIOLATION: policy date not after the latest version/.test(msg)) return "policy_conflict";
  if (/POLICY_VIOLATION: policy date in the past/.test(msg)) return "policy_invalid";
  if (err.code === "23514" || err.code === "22P02" || err.code === "22007" || err.code === "22008") return "policy_invalid";
  return "unknown";
}
