import { PAY_METHODS, type GroupErrorCode } from "./groups";
import { parseAmountToMinor } from "./money-input";

/**
 * Company credit balance forms and answers (migration 168). The database enforces every rule (permission, the group_bookings flag, the
 * balance, what the group owes); these only turn what a form sends into a clean call and the database's answers into screen values.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{8,100}$/;
const MAX = 1_000_000_000_000;
type Raw = Record<string, unknown>;
type Parsed<T> = { ok: true; value: T } | { ok: false; code: GroupErrorCode };
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const bad = { ok: false, code: "group_pay_invalid" } as const;

export type CreditDepositForm = {
  companyId: string;
  amountMinor: number;
  method: string;
  reference: string | null;
  note: string | null;
  key: string;
};
export function parseCreditDepositForm(raw: Raw): Parsed<CreditDepositForm> {
  const companyId = text(raw.companyId);
  const method = text(raw.method);
  const reference = text(raw.reference);
  const note = text(raw.note);
  const key = text(raw.key);
  const amount = parseAmountToMinor(text(raw.amount));
  if (
    !UUID.test(companyId) ||
    !KEY.test(key) ||
    !(PAY_METHODS as readonly string[]).includes(method) ||
    reference.length > 60 ||
    note.length > 200
  )
    return bad;
  if (amount === null || amount <= 0 || amount > MAX) return bad;
  return { ok: true, value: { companyId, amountMinor: amount, method, reference: reference || null, note: note || null, key } };
}

export type CreditWithdrawForm = { companyId: string; amountMinor: number; reason: string; key: string };
export function parseCreditWithdrawForm(raw: Raw): Parsed<CreditWithdrawForm> {
  const companyId = text(raw.companyId);
  const reason = text(raw.reason);
  const key = text(raw.key);
  const amount = parseAmountToMinor(text(raw.amount));
  if (!UUID.test(companyId) || !KEY.test(key) || amount === null || amount <= 0 || amount > MAX) return bad;
  if (reason.length < 1 || reason.length > 200) return { ok: false, code: "group_reason" };
  return { ok: true, value: { companyId, amountMinor: amount, reason, key } };
}

export type CreditApplyForm = { groupId: string; amountMinor: number; key: string };
export function parseCreditApplyForm(raw: Raw): Parsed<CreditApplyForm> {
  const groupId = text(raw.groupId);
  const key = text(raw.key);
  const amount = parseAmountToMinor(text(raw.amount));
  if (!UUID.test(groupId) || !KEY.test(key) || amount === null || amount <= 0 || amount > MAX) return bad;
  return { ok: true, value: { groupId, amountMinor: amount, key } };
}

/** { company id: balance in minor units } from company_credit_balances; anything unusable is left out, so a failed read shows no balance. */
export function parseCreditBalances(data: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!data || typeof data !== "object" || Array.isArray(data)) return out;
  for (const [id, v] of Object.entries(data as Record<string, unknown>)) {
    const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : NaN;
    if (UUID.test(id) && Number.isFinite(n)) out[id] = n;
  }
  return out;
}

export type CreditEntry = {
  kind: "deposit" | "apply" | "reverse_apply" | "withdraw";
  amountMinor: number;
  method: string | null;
  reference: string | null;
  note: string | null;
  groupName: string | null;
  createdAt: string;
};
export const CREDIT_KIND_LABEL: Record<CreditEntry["kind"], string> = {
  deposit: "Money received",
  apply: "Used to pay a group",
  reverse_apply: "Returned (payment reversed)",
  withdraw: "Paid back or written off",
};
export function parseCreditLedger(data: unknown): CreditEntry[] {
  if (!Array.isArray(data)) return [];
  const out: CreditEntry[] = [];
  for (const x of data) {
    if (!x || typeof x !== "object") continue;
    const d = x as Record<string, unknown>;
    const kind = d.kind;
    const amount =
      typeof d.amount_minor === "number"
        ? d.amount_minor
        : typeof d.amount_minor === "string" && /^-?\d+$/.test(d.amount_minor)
          ? Number(d.amount_minor)
          : NaN;
    if (
      (kind !== "deposit" && kind !== "apply" && kind !== "reverse_apply" && kind !== "withdraw") ||
      !Number.isFinite(amount) ||
      typeof d.created_at !== "string"
    )
      continue;
    const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
    out.push({
      kind,
      amountMinor: amount,
      method: s(d.method),
      reference: s(d.reference),
      note: s(d.note),
      groupName: s(d.group_name),
      createdAt: d.created_at,
    });
  }
  return out;
}
