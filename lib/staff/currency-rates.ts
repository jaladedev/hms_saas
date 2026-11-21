import { isSupportedCurrency, SUPPORTED_CURRENCIES, type SupportedCurrency } from "@/lib/currency";

/**
 * Exchange rates entered by hand (migration 163): the words, the form check and reading the rows. Pure, so it is tested without a server.
 * No money function reads a rate; they are for comparing hotels that trade in different currencies.
 */
export type FxErrorCode = "fx_forbidden" | "fx_off" | "fx_currency" | "fx_rate" | "fx_date" | "fx_invalid" | "fx_failed";
export const FX_ERROR_MESSAGES: Record<FxErrorCode, string> = {
  fx_forbidden: "You do not have permission to do that. Exchange rates are kept by the owner or general manager.",
  fx_off: "Multi-currency is switched off for your hotel group. Rates already entered are kept. Contact the platform.",
  fx_currency: "Choose two different supported currencies.",
  fx_rate: "Enter a rate above zero with at most 8 decimal places.",
  fx_date: "Choose a date that is not in the future.",
  fx_invalid: "Check the details and try again.",
  fx_failed: "That did not work. Reload the page and try again.",
};
export const FX_OK_MESSAGES = { fx_saved: "Rate saved." } as const;
export type FxOkCode = keyof typeof FX_OK_MESSAGES;

export function classifyFxError(message: string): FxErrorCode {
  if (/NOT_FOUND/.test(message)) return "fx_forbidden";
  if (/multi_currency off/.test(message)) return "fx_off";
  if (/POLICY_VIOLATION: currency/.test(message)) return "fx_currency";
  if (/POLICY_VIOLATION: rate/.test(message)) return "fx_rate";
  if (/POLICY_VIOLATION: date/.test(message)) return "fx_date";
  if (/POLICY_VIOLATION/.test(message)) return "fx_invalid";
  return "fx_failed";
}

export type FxRate = { id: string; from: SupportedCurrency; to: SupportedCurrency; date: string; rate: string; note: string | null };
export function parseRates(raw: unknown): FxRate[] {
  if (!Array.isArray(raw)) return [];
  const out: FxRate[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const x = r as Record<string, unknown>;
    const from = typeof x.from_currency === "string" ? x.from_currency.trim() : "";
    const to = typeof x.to_currency === "string" ? x.to_currency.trim() : "";
    if (!isSupportedCurrency(from) || !isSupportedCurrency(to)) continue;
    out.push({
      id: String(x.id ?? ""),
      from,
      to,
      date: String(x.rate_date ?? ""),
      rate: String(x.rate ?? "")
        .replace(/(\.\d*?)0+$/, "$1")
        .replace(/\.$/, ""),
      note: typeof x.note === "string" && x.note !== "" ? x.note : null,
    });
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function parseRateForm(
  raw: Record<string, unknown>,
):
  | { ok: true; value: { propertyId: string; from: SupportedCurrency; to: SupportedCurrency; date: string; rate: string; note: string } }
  | { ok: false; code: FxErrorCode } {
  const propertyId = text(raw.propertyId);
  const from = text(raw.from).toUpperCase();
  const to = text(raw.to).toUpperCase();
  const date = text(raw.date);
  const rate = text(raw.rate).replace(/,/g, "");
  const note = text(raw.note);
  if (!UUID.test(propertyId) || note.length > 200) return { ok: false, code: "fx_invalid" };
  if (!isSupportedCurrency(from) || !isSupportedCurrency(to) || from === to) return { ok: false, code: "fx_currency" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return { ok: false, code: "fx_date" };
  if (!/^\d{1,9}(\.\d{1,8})?$/.test(rate) || Number(rate) <= 0) return { ok: false, code: "fx_rate" };
  return { ok: true, value: { propertyId, from, to, date, rate, note } };
}

export { SUPPORTED_CURRENCIES };
