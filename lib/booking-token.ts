import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless guest booking token: base64url(JSON {r: reservation id, e: expiry seconds}) "." base64url(HMAC-SHA256).
 * It lets a guest open their own booking or payment page from an emailed link without an account.
 * The secret never leaves the server; the HMAC covers a purpose prefix so the same secret
 * cannot be replayed for a different kind of token. Tokens cannot be revoked, so keep the TTL short
 * and re-issue from a verified lookup (booking reference plus email) when one expires.
 */
const PURPOSE = "hms.booking.v1:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(PURPOSE + payload).digest("base64url");
}

export function createBookingToken(reservationId: string, secret: string, ttlSeconds: number, nowMs: number = Date.now()): string {
  if (!UUID.test(reservationId)) throw new Error("reservationId must be a UUID");
  if (secret.length < 32) throw new Error("booking token secret must be at least 32 characters");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error("ttlSeconds must be a positive integer");
  const payload = Buffer.from(JSON.stringify({ r: reservationId, e: Math.floor(nowMs / 1000) + ttlSeconds })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** Returns the reservation id for a valid, unexpired token, otherwise null. Never throws on bad input. */
export function verifyBookingToken(token: string, secret: string, nowMs: number = Date.now()): string | null {
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
    const { r, e } = data as { r?: unknown; e?: unknown };
    if (typeof r !== "string" || !UUID.test(r) || typeof e !== "number" || !Number.isFinite(e)) return null;
    if (e * 1000 <= nowMs) return null;
    return r.toLowerCase();
  } catch {
    return null;
  }
}
