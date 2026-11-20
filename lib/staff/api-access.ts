import { API_SCOPES, WEBHOOK_EVENTS } from "@/lib/api/keys";

/** API keys and webhook endpoints (migration 158): checking what a form sends and the words the screens use. The database checks everything again. */

export type ApiErrorCode = "api_forbidden" | "api_off" | "api_invalid" | "api_too_many" | "api_failed";
export const API_ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  api_forbidden: "You do not have permission to do that here. API keys and webhooks are managed by the owner or general manager.",
  api_off: "API access is switched off for your hotel group. Existing keys stop working until it is back on. Contact the platform.",
  api_invalid: "Check the details and try again. A webhook address must start with https:// and name the events you want.",
  api_too_many: "That is the most this hotel can hold (10 live keys, 5 webhook addresses). Revoke or switch one off first.",
  api_failed: "That did not work. Reload the page and try again.",
};
export const API_OK_MESSAGES = { api_revoked: "Key revoked. It stops working immediately.", api_saved: "Saved." } as const;
export type ApiOkCode = keyof typeof API_OK_MESSAGES;

export function classifyApiError(message: string): ApiErrorCode {
  if (/NOT_FOUND/.test(message)) return "api_forbidden";
  if (/api off/.test(message)) return "api_off";
  if (/POLICY_VIOLATION: too many/.test(message)) return "api_too_many";
  if (/POLICY_VIOLATION/.test(message)) return "api_invalid";
  return "api_failed";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Form = { get(name: string): FormDataEntryValue | null; getAll(name: string): FormDataEntryValue[] };
type Parsed<T> = { ok: true; value: T } | { ok: false; code: ApiErrorCode };
const text = (v: FormDataEntryValue | null): string => (typeof v === "string" ? v.trim() : "");
const bad = (): { ok: false; code: ApiErrorCode } => ({ ok: false, code: "api_invalid" });
const pick = <T extends string>(values: FormDataEntryValue[], allowed: readonly T[]): T[] | null => {
  const out = [...new Set(values.map((v) => (typeof v === "string" ? v : "")))];
  return out.length > 0 && out.every((v): v is T => (allowed as readonly string[]).includes(v)) ? out : null;
};

export function parseKeyForm(f: Form): Parsed<{ propertyId: string; name: string; scopes: string[]; limit: number }> {
  const propertyId = text(f.get("propertyId"));
  const name = text(f.get("name"));
  const scopes = pick(f.getAll("scope"), API_SCOPES);
  const limitText = text(f.get("limit")) || "60";
  const limit = /^\d{1,3}$/.test(limitText) ? Number(limitText) : 0;
  if (!UUID.test(propertyId) || name.length < 1 || name.length > 60 || !scopes || limit < 1 || limit > 600) return bad();
  if (scopes.includes("guests.read") && !scopes.includes("bookings.read")) return bad();
  return { ok: true, value: { propertyId, name, scopes, limit } };
}

export function parseEndpointForm(
  f: Form,
): Parsed<{ propertyId: string; endpointId: string | null; url: string; events: string[]; active: boolean }> {
  const propertyId = text(f.get("propertyId"));
  const endpointId = text(f.get("endpointId")) || null;
  const url = text(f.get("url"));
  const events = pick(f.getAll("event"), WEBHOOK_EVENTS);
  if (
    !UUID.test(propertyId) ||
    (endpointId && !UUID.test(endpointId)) ||
    !/^https:\/\/[^\s"<>/?#]+(\/[^\s"<>]*)?$/.test(url) ||
    url.length > 200 ||
    !events
  )
    return bad();
  const active = f.get("active");
  return { ok: true, value: { propertyId, endpointId, url, events, active: active === "on" || active === "true" } };
}

export function parseRevokeForm(f: Form): Parsed<{ keyId: string }> {
  const keyId = text(f.get("keyId"));
  return UUID.test(keyId) ? { ok: true, value: { keyId } } : bad();
}

/** What a create form tells the page: the secret appears here once and nowhere else. */
export type CreateState = { error: string | null; secret: { label: string; value: string } | null };
export const emptyCreateState: CreateState = { error: null, secret: null };
