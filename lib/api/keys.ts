import { createHash } from "node:crypto";

/** The key shape made by api_key_create (migration 158): hms_ + 8 hex prefix + _ + 48 hex secret. */
export const API_KEY_PATTERN = /^hms_[0-9a-f]{8}_[0-9a-f]{48}$/;

/** The key from an `Authorization: Bearer <key>` header, or null when it is missing or not shaped like one of ours. */
export function bearerKey(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer ([^\s]+)$/i.exec(header.trim());
  return m && API_KEY_PATTERN.test(m[1]!) ? m[1]! : null;
}

/** sha256 hex of the whole key: what the database stores and looks up. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export const API_SCOPES = ["availability.read", "bookings.read", "guests.read"] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const API_SCOPE_LABEL: Record<ApiScope, string> = {
  "availability.read": "Read availability and prices",
  "bookings.read": "Read bookings",
  "guests.read": "Include guest name and email in bookings",
};
export const WEBHOOK_EVENTS = [
  "booking.created",
  "booking.confirmed",
  "booking.cancelled",
  "booking.checked_in",
  "booking.checked_out",
  "booking.no_show",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** What the database says about a key: see api_key_authenticate. */
export type AuthResult =
  | { ok: true; keyId: string; propertyId: string; scopes: string[] }
  | { ok: false; reason: "invalid" | "off" | "rate_limited"; retryAfter?: number };

export function parseAuth(raw: unknown): AuthResult {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (r.ok === true && typeof r.key_id === "string" && typeof r.property_id === "string") {
    return {
      ok: true,
      keyId: r.key_id,
      propertyId: r.property_id,
      scopes: Array.isArray(r.scopes) ? r.scopes.filter((s): s is string => typeof s === "string") : [],
    };
  }
  if (r.reason === "off" || r.reason === "rate_limited")
    return { ok: false, reason: r.reason, retryAfter: typeof r.retry_after === "number" ? r.retry_after : undefined };
  return { ok: false, reason: "invalid" };
}
