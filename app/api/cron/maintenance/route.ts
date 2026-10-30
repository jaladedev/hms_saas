import { drainNow } from "@/lib/email/server";
import { isAuthorizedCron, runMaintenance } from "@/lib/maintenance";
import { createServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Housekeeping, meant to be called every few minutes by a scheduler with `Authorization: Bearer $CRON_SECRET`:
 * expires online reservations nobody paid for, sends due emails (the backstop for the quick send after each
 * booking), and purges old rate-limit and email rows.
 */
async function handle(request: Request) {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = createServiceClient();
  const result = await runMaintenance({
    async expireLapsedHolds(limit) {
      const { data, error } = await db.rpc("expire_lapsed_holds", { p_limit: limit });
      if (error) throw new Error(error.message);
      return data as number;
    },
    drainEmails: drainNow,
    async purgeOldData() {
      const { data, error } = await db.rpc("purge_old_operational_data");
      if (error) throw new Error(error.message);
      return data;
    },
  });
  return Response.json(result);
}

export const GET = handle;
export const POST = handle;
