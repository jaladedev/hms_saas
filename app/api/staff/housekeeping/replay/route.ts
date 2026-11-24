import { revalidatePath } from "next/cache";
import { classifyReplayError, replayBodySchema, type ReplayItem, type ReplayResult } from "@/lib/offline/replay";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store" };

/**
 * Sends housekeeping changes that were made offline (claim, start, complete), in the order they were made. Each runs as the
 * signed-in person through the same database functions as the buttons on the page, so the database decides what is allowed.
 * Those functions are safe to repeat, so a request whose answer was lost can simply be sent again. Each change carries the time it
 * was made (`madeAt`), which the database records for start and complete (migration 185); an item without one is recorded at the
 * time it arrives.
 */
type Db = Awaited<ReturnType<typeof createClient>>;

/** Runs one waiting change through the same database function as the button it replaces. */
async function run(supabase: Db, item: ReplayItem) {
  const note = item.note?.trim() || null;
  switch (item.action) {
    // Housekeeping carries the time the change was made; the database keeps it inside its bounds (migration 185).
    case "claim":
      return supabase.rpc("claim_housekeeping_task", { p_task_id: item.taskId, p_at: item.madeAt ?? null });
    case "start":
      return supabase.rpc("start_housekeeping_task", { p_task_id: item.taskId, p_at: item.madeAt ?? null });
    case "complete":
      return supabase.rpc("complete_housekeeping_task", { p_task_id: item.taskId, p_note: note, p_at: item.madeAt ?? null });
    // Repairs record the time the change arrives: those functions have no made-at argument yet.
    case "maint_claim":
      return supabase.rpc("claim_maintenance_request", { p_request_id: item.taskId });
    case "maint_start":
      return supabase.rpc("start_maintenance_request", { p_request_id: item.taskId });
    case "maint_resolve":
      return supabase.rpc("resolve_maintenance_request", { p_request_id: item.taskId, p_note: note });
  }
}

export async function POST(request: Request) {
  // A cross-site form cannot send JSON, and the session cookie is not sent cross-site anyway.
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    return Response.json({ error: "bad_request" }, { status: 415, headers });
  }
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return Response.json({ error: "signed_out" }, { status: 401, headers });

  const parsed = replayBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400, headers });

  const results: ReplayResult[] = [];
  for (const item of parsed.data.items) {
    if (item.userId !== auth.user.id) {
      results.push({ id: item.id, status: "rejected", reason: "other_user" });
      continue;
    }
    const { error } = await run(supabase, item);
    results.push(error ? { id: item.id, ...classifyReplayError(item.action, error.message) } : { id: item.id, status: "done" });
  }

  if (results.some((r) => r.status === "done")) {
    revalidatePath("/app/housekeeping");
    revalidatePath("/app/maintenance");
    revalidatePath("/app/rooms");
  }
  return Response.json({ results }, { headers });
}
