import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed link for a guest's own venue booking ("v") or ticket order ("t"): base64url(JSON {k, r, e}) "." base64url(HMAC-SHA256).
 * It has its own purpose prefix, so a room booking link can never open an event page or the other way round. The link is the
 * guest's only key to the page (no account), so it is long, unguessable and expires.
 */
const PURPOSE = "hms.event.v1:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type EventTokenKind = "v" | "t";

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(PURPOSE + payload)
    .digest("base64url");
}

export function createEventToken(kind: EventTokenKind, id: string, secret: string, ttlSeconds: number, nowMs: number = Date.now()): string {
  if (!UUID.test(id)) throw new Error("id must be a UUID");
  if (secret.length < 32) throw new Error("token secret must be at least 32 characters");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error("ttlSeconds must be a positive integer");
  const payload = Buffer.from(JSON.stringify({ k: kind, r: id, e: Math.floor(nowMs / 1000) + ttlSeconds })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** The id for a genuine, unexpired token of the kind asked for, otherwise null. */
export function readEventToken(token: string, kind: EventTokenKind, secret: string, nowMs: number = Date.now()): string | null {
  if (typeof token !== "string" || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts as [string, string];
  const expected = Buffer.from(sign(payload, secret), "utf8");
  const given = Buffer.from(signature, "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof data !== "object" || data === null) return null;
    const { k, r, e } = data as { k?: unknown; r?: unknown; e?: unknown };
    if (k !== kind || typeof r !== "string" || !UUID.test(r) || typeof e !== "number" || !Number.isFinite(e) || e * 1000 <= nowMs)
      return null;
    return r.toLowerCase();
  } catch {
    return null;
  }
}
