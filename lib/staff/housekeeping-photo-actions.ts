"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, ok, staffClient } from "./action-helpers";
import { classifyTaskPhotoError, isPhotoKind, TASK_PHOTO_BUCKET, taskPhotoPath, validateTaskPhoto } from "./housekeeping-photos";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Before and after pictures on a housekeeping task (migration 181). Adding: the row is written first, as the signed-in person, so
 * the table's own policies (housekeeping.update, the task's assignment rule, not cancelled) and limits (3 per kind, the task's own
 * property) decide; only then is the file stored with the service key at the path the row names, and if storing fails the row is
 * withdrawn. Removing works the other way round, after the person's right has been checked: the file goes first, so a failure
 * leaves the row and an error, never a file nobody can find. Neither touches the task.
 */

const uuid = z.guid();
const LIST = "/app/housekeeping";
// Not under /app/housekeeping: that folder has a loading boundary, and a page below one cannot answer not-found (lib/loading-boundaries.test.ts).
const pageOf = (taskId: string) => `/app/housekeeping-task/${taskId}`;

export async function addTaskPhoto(formData: FormData) {
  const taskId = uuid.safeParse(formData.get("taskId"));
  const kind = formData.get("kind");
  if (!taskId.success || !isPhotoKind(kind)) return back(LIST, { err: "bad_request" });
  const PAGE = pageOf(taskId.data);
  const file = formData.get("photo");
  const check = validateTaskPhoto(file instanceof File ? file : null);
  if (!check.ok) return back(PAGE, { err: check.code });

  const supabase = await staffClient();
  // Row-level security hides a task from anyone who may not see housekeeping, so "not found" covers both cases.
  const { data: task } = await supabase.from("housekeeping_tasks").select("id, tenant_id, property_id").eq("id", taskId.data).maybeSingle();
  if (!task) return back(LIST, { err: "not_found" });

  const path = taskPhotoPath(task.tenant_id, task.property_id, task.id, kind, randomUUID(), check.ext);
  const { data: row, error } = await supabase
    .from("housekeeping_task_photos")
    .insert({
      tenant_id: task.tenant_id,
      property_id: task.property_id,
      task_id: task.id,
      kind,
      storage_path: path,
      content_type: check.contentType,
      size_bytes: (file as File).size,
    })
    .select("id")
    .single();
  if (error || !row) return back(PAGE, { err: classifyTaskPhotoError(error ?? {}) });

  const service = createServiceClient();
  const { error: upErr } = await service.storage
    .from(TASK_PHOTO_BUCKET)
    .upload(path, await (file as File).arrayBuffer(), { contentType: check.contentType });
  if (upErr) {
    await supabase.from("housekeeping_task_photos").delete().eq("id", row.id);
    return back(PAGE, { err: "hkphoto_storage" });
  }
  revalidatePath(PAGE);
  return ok(PAGE, "hkphoto_added");
}

export async function removeTaskPhoto(formData: FormData) {
  const id = uuid.safeParse(formData.get("photoId"));
  if (!id.success) return back(LIST, { err: "bad_request" });
  const supabase = await staffClient();
  const { data: row } = await supabase.from("housekeeping_task_photos").select("id, task_id, storage_path").eq("id", id.data).maybeSingle();
  if (!row) return back(LIST, { err: "not_found" });
  const PAGE = pageOf(row.task_id);

  // Checked BEFORE the file is touched: a person who may see a picture but not remove it must not lose the file to a refused delete.
  const { data: allowed } = await supabase.rpc("hk_photo_allowed", { p_task: row.task_id, p_adding: false });
  if (allowed !== true) return back(PAGE, { err: "hkphoto_forbidden" });

  const service = createServiceClient();
  const { error: rmErr } = await service.storage.from(TASK_PHOTO_BUCKET).remove([row.storage_path]);
  if (rmErr) return back(PAGE, { err: "hkphoto_storage" });

  const { data: gone, error } = await supabase.from("housekeeping_task_photos").delete().eq("id", row.id).select("id");
  if (error) return back(PAGE, { err: classifyTaskPhotoError(error) });
  if (!gone || gone.length === 0) return back(PAGE, { err: "hkphoto_forbidden" });
  revalidatePath(PAGE);
  return ok(PAGE, "hkphoto_removed");
}
