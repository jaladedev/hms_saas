import { drainNow } from "@/lib/email/server";
import { drainPhotoCleanup } from "@/lib/photo-cleanup";
import { isAuthorizedCron, runMaintenance } from "@/lib/maintenance";
import { PHOTO_BUCKET } from "@/lib/staff/room-photos";
import { createServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Housekeeping, meant to be called every few minutes by a scheduler with `Authorization: Bearer $CRON_SECRET`:
 * expires online reservations nobody paid for, sends due emails (the backstop for the quick send after each
 * booking), purges old rate-limit and email rows, and removes stored room photo files whose picture was deleted.
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
    async staleRefunds() {
      const { data, error } = await db.rpc("stale_processing_refunds", { p_older_than_minutes: 120 });
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown[];
    },
    async sweepNotifications() {
      const { data, error } = await db.rpc("notifications_sweep");
      if (error) throw new Error(error.message);
      return data;
    },
    log: (level, message, context) => console[level](`[maintenance] ${message}`, context ?? {}),
    cleanPhotoFiles: () => drainPhotoCleanup({
      async claim(limit) {
        const { data, error } = await db.rpc("claim_photo_cleanup", { p_limit: limit });
        if (error) throw new Error(error.message);
        return (data ?? []) as string[];
      },
      async remove(paths) {
        const { error } = await db.storage.from(PHOTO_BUCKET).remove(paths);
        return { error: error ? error.message : null };
      },
      async finish(paths) {
        const { data, error } = await db.rpc("finish_photo_cleanup", { p_paths: paths });
        if (error) throw new Error(error.message);
        return (data ?? 0) as number;
      },
    }),
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
