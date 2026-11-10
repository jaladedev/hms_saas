"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, fail, ok, staffClient } from "./action-helpers";
import { classifyTaskError, TASK_PRIORITIES, TASK_TYPES, zonedToIso } from "./housekeeping-tasks";
import type { OkCode } from "./refunds";

/**
 * Staff actions on housekeeping tasks (migration 023). Each runs as the signed-in person, so the database decides
 * who may do what; these functions carry the request and turn the answer into a redirect with a short code.
 */

const PAGE = "/app/housekeeping";
const uuid = z.guid();

function finish(error: { message: string } | null, code: OkCode): never {
  if (error) {
    const own = classifyTaskError(error.message);
    return own ? back(PAGE, { err: own }) : fail(PAGE, error.message);
  }
  // The room board shows the same cleaning status, so refresh both.
  revalidatePath(PAGE);
  revalidatePath("/app/rooms");
  return ok(PAGE, code);
}

export async function createTask(formData: FormData) {
  const parsed = z
    .object({
      roomId: uuid,
      taskType: z.enum(TASK_TYPES),
      priority: z.enum(TASK_PRIORITIES),
      notes: z.string().max(500).default(""),
      due: z.string().max(16).default(""),
    })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(PAGE, { err: "bad_request" });
  const supabase = await staffClient();

  // The form's time is the hotel's wall-clock time, so it is read in the room's property timezone.
  let dueAt: string | null = null;
  if (parsed.data.due) {
    const { data: rm } = await supabase.from("rooms").select("property_id").eq("id", parsed.data.roomId).maybeSingle();
    const { data: pr } = rm ? await supabase.from("properties").select("timezone").eq("id", rm.property_id).maybeSingle() : { data: null };
    dueAt = zonedToIso(parsed.data.due, pr?.timezone ?? "UTC");
    if (!dueAt) return back(PAGE, { err: "task_invalid" });
  }
  const { error } = await supabase.rpc("create_housekeeping_task", {
    p_room_id: parsed.data.roomId,
    p_task_type: parsed.data.taskType,
    p_priority: parsed.data.priority,
    p_notes: parsed.data.notes.trim() || null,
    p_due_at: dueAt,
  });
  return finish(error, "task_created");
}

export async function claimTask(formData: FormData) {
  const parsed = z.object({ taskId: uuid }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(PAGE, { err: "bad_request" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("claim_housekeeping_task", { p_task_id: parsed.data.taskId });
  return finish(error, "task_claimed");
}

export async function startTask(formData: FormData) {
  const parsed = z.object({ taskId: uuid }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(PAGE, { err: "bad_request" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("start_housekeeping_task", { p_task_id: parsed.data.taskId });
  return finish(error, "task_started");
}

export async function completeTask(formData: FormData) {
  const parsed = z.object({ taskId: uuid, note: z.string().max(500).default("") }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(PAGE, { err: "task_invalid" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("complete_housekeeping_task", {
    p_task_id: parsed.data.taskId,
    p_note: parsed.data.note.trim() || null,
  });
  return finish(error, "task_completed");
}

/** An empty `userId` takes the task back (unassigns it). */
export async function assignTask(formData: FormData) {
  const parsed = z.object({ taskId: uuid, userId: z.union([uuid, z.literal("")]) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(PAGE, { err: "bad_request" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("assign_housekeeping_task", {
    p_task_id: parsed.data.taskId,
    p_user_id: parsed.data.userId || null,
  });
  return finish(error, parsed.data.userId ? "task_assigned" : "task_unassigned");
}

export async function cancelTask(formData: FormData) {
  const parsed = z.object({ taskId: uuid, reason: z.string().max(200) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return back(PAGE, { err: "task_reason" });
  const reason = parsed.data.reason.trim();
  if (!reason) return back(PAGE, { err: "task_reason" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("cancel_housekeeping_task", { p_task_id: parsed.data.taskId, p_reason: reason });
  return finish(error, "task_cancelled");
}
