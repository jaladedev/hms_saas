import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { enforceRateLimits, type RateRuleName } from "@/lib/rate-limit";

/** Counts one call of a channel connection against its rule. A database failure throws, so the endpoint fails closed. */
export async function checkChannelLimit(rule: Extract<RateRuleName, "channelInbound" | "channelFeed">, connectionId: string) {
  const db = createServiceClient();
  return enforceRateLimits(
    async (key, limit, windowSeconds) => {
      const { data, error } = await db.rpc("consume_rate_limit", { p_key: key, p_limit: limit, p_window_seconds: windowSeconds });
      if (error) throw new Error(error.message);
      return data as { allowed: boolean; retry_after_seconds: number };
    },
    [{ rule, subject: connectionId }],
  );
}
