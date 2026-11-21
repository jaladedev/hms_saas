import { CHANNEL_KEY_PATTERN } from "@/lib/channels/inbound";

/** Channel manager screens (migration 171): wording, reading what the database returns, checking forms. The database checks everything again. */
export const CHANNELS = ["booking_com", "expedia", "airbnb", "other"] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_LABEL: Record<Channel, string> = {
  booking_com: "Booking.com",
  expedia: "Expedia",
  airbnb: "Airbnb",
  other: "Other channel",
};
export const COLLECTS_LABEL = { channel: "The channel collects payment", hotel: "The hotel collects payment" } as const;
export type Collects = keyof typeof COLLECTS_LABEL;
export const BOOKING_STATUS_LABEL = {
  received: "Received",
  imported: "Imported",
  failed: "Could not import",
  cancelled: "Cancelled",
  attention: "Needs a person",
  resolved: "Handled by hand",
} as const;
export type BookingStatus = keyof typeof BOOKING_STATUS_LABEL;

export type ChannelErrorCode = "ch_forbidden" | "ch_off" | "ch_invalid" | "ch_too_many" | "ch_room_type" | "ch_state" | "ch_failed";
export const CHANNEL_ERROR_MESSAGES: Record<ChannelErrorCode, string> = {
  ch_forbidden: "You do not have permission to do that here. Channels are managed by the owner or general manager.",
  ch_off: "The channel manager is switched off for your hotel group. Nothing is imported until it is back on. Contact the platform.",
  ch_invalid: "Check the details and try again.",
  ch_too_many: "That is the most connections this hotel can hold (5). Revoke one first.",
  ch_room_type: "Choose one of this hotel's active room types.",
  ch_state: "That has already moved on, so that step is not possible. A revoked connection cannot come back; make a new one.",
  ch_failed: "That did not work. Reload the page and try again.",
};
export const CHANNEL_OK_MESSAGES = {
  ch_status: "Connection updated.",
  ch_map: "Room code saved.",
  ch_unmap: "Room code removed.",
  ch_retry_imported: "Imported.",
  ch_retry_failed: "Tried again; it still cannot be imported. The reason is shown on the booking.",
  ch_resolved: "Marked as handled.",
  ch_paid: "Payment recorded. The booking now shows what the channel paid.",
} as const;
export type ChannelOkCode = keyof typeof CHANNEL_OK_MESSAGES;

export function classifyChannelError(message: string): ChannelErrorCode {
  if (/NOT_FOUND/.test(message)) return "ch_forbidden";
  if (/channels off/.test(message)) return "ch_off";
  if (/POLICY_VIOLATION: too many/.test(message)) return "ch_too_many";
  if (/POLICY_VIOLATION: room type/.test(message)) return "ch_room_type";
  if (/INVALID_STATE/.test(message)) return "ch_state";
  if (/POLICY_VIOLATION/.test(message)) return "ch_invalid";
  return "ch_failed";
}

/** The reason an import failed, in words. The database keeps a short code. */
export function failureWords(code: string | null): string {
  if (!code) return "";
  if (/unmapped room/.test(code)) return "A room code from the channel is not mapped to a room type.";
  if (/ROOM_UNAVAILABLE/.test(code)) return "No room of that type is free for those dates.";
  if (/CAPACITY_EXCEEDED/.test(code)) return "The party is bigger than that room type allows.";
  if (/no rooms|dates/.test(code)) return "The booking is missing rooms or dates.";
  if (/arrival in the past/.test(code)) return "The arrival date has already passed.";
  if (/^database/.test(code)) return "A room was taken at the same moment. Try again.";
  return "The booking could not be created. Check the details and try again.";
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec).filter((x): x is Rec => x !== null) : []);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : 0);

export type Connection = {
  id: string;
  channel: Channel;
  label: string;
  collects: Collects;
  status: "active" | "paused" | "revoked";
  prefix: string;
  lastInboundAt: string | null;
  lastFeedAt: string | null;
};
export function parseConnections(raw: unknown): Connection[] {
  return arr(raw).map((r) => ({
    id: str(r.id),
    channel: (CHANNELS as readonly string[]).includes(str(r.channel)) ? (str(r.channel) as Channel) : "other",
    label: str(r.label),
    collects: r.collects === "hotel" ? "hotel" : "channel",
    status: r.status === "paused" || r.status === "revoked" ? r.status : "active",
    prefix: str(r.prefix),
    lastInboundAt: strOrNull(r.last_inbound_at),
    lastFeedAt: strOrNull(r.last_feed_at),
  }));
}
export type MapRow = { connectionId: string; externalRoomId: string; roomTypeId: string };
export const parseMap = (raw: unknown): MapRow[] =>
  arr(raw).map((r) => ({ connectionId: str(r.connection_id), externalRoomId: str(r.external_room_id), roomTypeId: str(r.room_type_id) }));

export type ChannelBooking = {
  id: string;
  connectionId: string;
  externalId: string;
  status: BookingStatus;
  guest: string | null;
  arrival: string | null;
  departure: string | null;
  channelTotalMinor: number | null;
  reservationId: string | null;
  error: string | null;
  note: string | null;
  attempts: number;
  createdAt: string;
};
export function parseBookings(raw: unknown): ChannelBooking[] {
  return arr(raw).map((r) => ({
    id: str(r.id),
    connectionId: str(r.connection_id),
    externalId: str(r.external_id),
    status: str(r.status) in BOOKING_STATUS_LABEL ? (str(r.status) as BookingStatus) : "received",
    guest: strOrNull(r.guest_label),
    arrival: strOrNull(r.arrival_date),
    departure: strOrNull(r.departure_date),
    channelTotalMinor: r.channel_total_minor == null ? null : num(r.channel_total_minor),
    reservationId: strOrNull(r.reservation_id),
    error: strOrNull(r.error),
    note: strOrNull(r.note),
    attempts: num(r.attempts),
    createdAt: str(r.created_at),
  }));
}

export type ChannelReport = {
  counts: Partial<Record<BookingStatus, number>>;
  priceDifferences: {
    id: string;
    externalId: string;
    reference: string;
    channelTotalMinor: number;
    ourTotalMinor: number;
    currency: string;
  }[];
  cancelledHere: { id: string; externalId: string; reference: string }[];
  awaitingPayment: { id: string; externalId: string; reference: string; owedMinor: number; currency: string }[];
};
export function parseChannelReport(raw: unknown): ChannelReport | null {
  const r = rec(raw);
  if (!r) return null;
  const counts: ChannelReport["counts"] = {};
  for (const [k, v] of Object.entries(rec(r.counts) ?? {})) if (k in BOOKING_STATUS_LABEL) counts[k as BookingStatus] = num(v);
  return {
    counts,
    priceDifferences: arr(r.price_differences).map((p) => ({
      id: str(p.id),
      externalId: str(p.external_id),
      reference: str(p.reference),
      channelTotalMinor: num(p.channel_total_minor),
      ourTotalMinor: num(p.our_total_minor),
      currency: str(p.currency) || "NGN",
    })),
    cancelledHere: arr(r.cancelled_here).map((p) => ({ id: str(p.id), externalId: str(p.external_id), reference: str(p.reference) })),
    awaitingPayment: arr(r.awaiting_payment).map((p) => ({
      id: str(p.id),
      externalId: str(p.external_id),
      reference: str(p.reference),
      owedMinor: num(p.owed_minor),
      currency: str(p.currency) || "NGN",
    })),
  };
}

// ---- forms ---------------------------------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
type Parsed<T> = { ok: true; value: T } | { ok: false; code: ChannelErrorCode };
const bad = { ok: false, code: "ch_invalid" } as const;

export type CreateState = { error: string | null; secret: { label: string; value: string } | null };
export const emptyCreateState: CreateState = { error: null, secret: null };

export function parseConnectionForm(
  f: Record<string, unknown>,
): Parsed<{ propertyId: string; channel: Channel; label: string; collects: Collects }> {
  const propertyId = text(f.propertyId);
  const channel = text(f.channel);
  const label = text(f.label);
  const collects = text(f.collects);
  if (
    !UUID.test(propertyId) ||
    !(CHANNELS as readonly string[]).includes(channel) ||
    label.length < 1 ||
    label.length > 60 ||
    (collects !== "channel" && collects !== "hotel")
  )
    return bad;
  return { ok: true, value: { propertyId, channel: channel as Channel, label, collects } };
}
export function parseStatusForm(f: Record<string, unknown>): Parsed<{ connectionId: string; status: "active" | "paused" | "revoked" }> {
  const connectionId = text(f.connectionId);
  const status = text(f.status);
  if (!UUID.test(connectionId) || !["active", "paused", "revoked"].includes(status)) return bad;
  return { ok: true, value: { connectionId, status: status as "active" | "paused" | "revoked" } };
}
export function parseMapForm(f: Record<string, unknown>): Parsed<{ connectionId: string; code: string; roomTypeId: string }> {
  const connectionId = text(f.connectionId);
  const code = text(f.code);
  const roomTypeId = text(f.roomTypeId);
  if (!UUID.test(connectionId) || !UUID.test(roomTypeId) || code.length < 1 || code.length > 80) return bad;
  return { ok: true, value: { connectionId, code, roomTypeId } };
}
export function parseUnmapForm(f: Record<string, unknown>): Parsed<{ connectionId: string; code: string }> {
  const connectionId = text(f.connectionId);
  const code = text(f.code);
  return UUID.test(connectionId) && code.length >= 1 && code.length <= 80 ? { ok: true, value: { connectionId, code } } : bad;
}
export function parseBookingIdForm(f: Record<string, unknown>): Parsed<string> {
  const id = text(f.bookingId);
  return UUID.test(id) ? { ok: true, value: id } : bad;
}
export function parseResolveForm(f: Record<string, unknown>): Parsed<{ bookingId: string; note: string }> {
  const bookingId = text(f.bookingId);
  const note = text(f.note);
  return UUID.test(bookingId) && note.length >= 3 && note.length <= 200 ? { ok: true, value: { bookingId, note } } : bad;
}

export const isChannelKey = (k: string) => CHANNEL_KEY_PATTERN.test(k);
