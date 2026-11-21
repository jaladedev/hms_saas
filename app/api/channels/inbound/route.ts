import { channelBearerKey, inboundErrorStatus, MAX_BODY_BYTES, parseInbound } from "@/lib/channels/inbound";
import { hashApiKey } from "@/lib/api/keys";
import { checkChannelLimit } from "@/lib/channels/limits";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

/**
 * A channel manager sends a booking, a change or a cancellation (migration 171). The key picks the hotel and the channel; a key that is wrong,
 * paused, revoked, or for a hotel whose plan lost the channel manager always gets the same 401. A booking id seen before changes nothing.
 * A booking that cannot be imported (no room, an unmapped room code) is still answered 200 with status "failed": it is kept and shown on the
 * hotel's reconciliation screen to retry, so the channel does not need to resend it.
 */
export async function POST(request: Request) {
  const key = channelBearerKey(request.headers.get("authorization"));
  if (!key) return json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return json(413, { error: "too_large" });
  const db = createServiceClient();
  const auth = await db.rpc("channel_authenticate", { p_hash: hashApiKey(key) });
  const a = auth.data && typeof auth.data === "object" ? (auth.data as Record<string, unknown>) : {};
  if (auth.error) return json(500, { error: "server_error" });
  if (a.ok !== true || typeof a.connection_id !== "string") return json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
  const limit = await checkChannelLimit("channelInbound", a.connection_id).catch(() => null);
  if (!limit) return json(500, { error: "server_error" });
  if (!limit.allowed) return json(429, { error: "rate_limited" }, { "retry-after": String(limit.retryAfterSeconds) });
  const parsed = parseInbound(await request.text());
  if (!parsed.ok) return json(400, { error: "invalid_request", message: parsed.message });
  const { data, error } = await db.rpc("channel_receive", {
    p_connection: a.connection_id,
    p_event: parsed.event,
    p_external: parsed.bookingId,
    p_payload: parsed.payload as never,
  });
  if (error) {
    const e = inboundErrorStatus(error.message);
    return json(e.status, { error: e.error });
  }
  const r = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  return json(200, { status: String(r.status ?? ""), duplicate: r.duplicate === true });
}
