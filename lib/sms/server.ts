import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { createSmsProvider } from "@/lib/sms/provider";
import { drainSms, type ClaimedSms, type SmsDrainResult } from "@/lib/sms/outbox";

/**
 * Claims due texts and sends them. Returns {skipped} when no provider is configured, leaving the outbox untouched so texts wait
 * instead of being lost. Safe to call from several places at once: claims are exclusive.
 */
export async function drainSmsNow(limit: number): Promise<SmsDrainResult | { skipped: string }> {
  const provider = createSmsProvider();
  if (!provider) return { skipped: "texting not configured" };
  const db = createServiceClient();
  return drainSms(
    {
      async claim(n) {
        const { data, error } = await db.rpc("claim_sms", { p_limit: n });
        if (error) throw new Error(error.message);
        return (data ?? []) as unknown as ClaimedSms[];
      },
      async mark(id, r) {
        const { error } = await db.rpc("mark_sms_result", {
          p_id: id,
          p_ok: r.ok,
          p_error: r.error ?? null,
          p_provider_id: r.providerId ?? null,
          p_permanent: r.permanent ?? false,
        });
        if (error) throw new Error(error.message);
      },
      provider,
      linkScheme: process.env.EMAIL_LINK_SCHEME === "http" ? "http" : "https",
      log: (level, message, context) => console[level === "info" ? "log" : level](`[sms] ${message}`, context ?? {}),
    },
    limit,
  );
}
