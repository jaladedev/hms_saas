import { channelBearerKey, inboundErrorStatus, parseFeedQuery } from "@/lib/channels/inbound";
import { hashApiKey } from "@/lib/api/keys";
import { checkChannelLimit } from "@/lib/channels/limits";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

/**
 * What the hotel can sell, for a channel manager that pulls (migration 175): `GET /api/channels/feed?from=2026-12-01&to=2026-12-15` with the
 * connection's own key. For each room code mapped on the connection and each night, the rooms free and the hotel's nightly rate. Read only.
 * A key that is wrong, paused, revoked or for a hotel whose plan lost the channel manager always gets the same 401.
 */
export async function GET(request: Request) {
  const key = channelBearerKey(request.headers.get("authorization"));
  if (!key) return json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
  const db = createServiceClient();
  const auth = await db.rpc("channel_feed_auth", { p_hash: hashApiKey(key) });
  const a = auth.data && typeof auth.data === "object" ? (auth.data as Record<string, unknown>) : {};
  if (auth.error) return json(500, { error: "server_error" });
  if (a.ok !== true || typeof a.connection_id !== "string") return json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
  const limit = await checkChannelLimit("channelFeed", a.connection_id).catch(() => null);
  if (!limit) return json(500, { error: "server_error" });
  if (!limit.allowed) return json(429, { error: "rate_limited" }, { "retry-after": String(limit.retryAfterSeconds) });
  const q = parseFeedQuery(new URL(request.url).searchParams);
  if (!q.ok) return json(400, { error: "invalid_request", message: "from and to must be dates, to after from, at most 90 nights" });
  const { data, error } = await db.rpc("channel_feed", { p_connection: a.connection_id, p_from: q.from, p_to: q.to });
  if (error) {
    if (/POLICY_VIOLATION: dates/.test(error.message))
      return json(400, { error: "invalid_request", message: "from must not be in the past" });
    const e = inboundErrorStatus(error.message);
    return json(e.status, { error: e.error });
  }
  return json(200, data);
}
