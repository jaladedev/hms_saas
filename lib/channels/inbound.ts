/**
 * The inbound channel endpoint (migration 171): the key shape, reading the request body and the answers. Pure, so it is tested without a server.
 * A channel manager posts JSON to /api/channels/inbound with `Authorization: Bearer chn_...`:
 *   { "event": "booking" | "modify" | "cancel", "booking_id": "<the channel's own id>", ...fields of a booking }
 */
export const CHANNEL_KEY_PATTERN = /^chn_[0-9a-f]{8}_[0-9a-f]{48}$/;
export const MAX_BODY_BYTES = 20_000;
export const CHANNEL_EVENTS = ["booking", "modify", "cancel"] as const;
export type ChannelEvent = (typeof CHANNEL_EVENTS)[number];

export function channelBearerKey(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer ([^\s]+)$/i.exec(header.trim());
  return m && CHANNEL_KEY_PATTERN.test(m[1]!) ? m[1]! : null;
}

export type InboundParsed =
  | { ok: true; event: ChannelEvent; bookingId: string; payload: Record<string, unknown> }
  | { ok: false; message: string };

/** Reads the body text. Only the shape is checked here; every field is checked again by the database. */
export function parseInbound(bodyText: string): InboundParsed {
  if (bodyText.length === 0 || new TextEncoder().encode(bodyText).length > MAX_BODY_BYTES) return { ok: false, message: "body size" };
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return { ok: false, message: "body is not JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "body is not an object" };
  const o = raw as Record<string, unknown>;
  const event = typeof o.event === "string" ? o.event : "";
  const bookingId = typeof o.booking_id === "string" ? o.booking_id.trim() : "";
  if (!(CHANNEL_EVENTS as readonly string[]).includes(event)) return { ok: false, message: "event" };
  if (bookingId.length < 1 || bookingId.length > 80) return { ok: false, message: "booking_id" };
  const { event: _e, booking_id: _b, ...payload } = o;
  void _e;
  void _b;
  return { ok: true, event: event as ChannelEvent, bookingId, payload };
}

/** Maps a database refusal to an HTTP answer. Raw database text is never returned. */
export function inboundErrorStatus(message: string): { status: number; error: string } {
  if (/NOT_FOUND/.test(message)) return { status: 401, error: "unauthorized" };
  if (/POLICY_VIOLATION: (payload|event|id)/.test(message)) return { status: 400, error: "invalid_request" };
  return { status: 500, error: "server_error" };
}
