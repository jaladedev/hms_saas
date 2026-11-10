"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { back, ok, staffClient } from "./action-helpers";
import { classifyPhotoError, MAX_CAPTION, PHOTO_BUCKET, photoPath, validatePhoto } from "./room-photos";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Room type photos. The picture's row is written first, as the signed-in person, so the table's own row-level
 * security and the five-photo limit decide whether they may add one. Only then is the file stored, with the service
 * key, at the path the row names; if storing fails the row is removed again. Removal works the other way round.
 */

const PAGE = "/app/settings/rooms";
const uuid = z.guid();
const refresh = () => {
  revalidatePath(PAGE);
  revalidatePath("/");
};

export async function addRoomPhoto(formData: FormData) {
  const roomTypeId = uuid.safeParse(formData.get("roomTypeId"));
  if (!roomTypeId.success) return back(PAGE, { err: "setup_invalid" });
  const file = formData.get("photo");
  const check = validatePhoto(file instanceof File ? file : null, formData.get("caption"));
  if (!check.ok) return back(PAGE, { err: check.code });

  const supabase = await staffClient();
  const { data: type } = await supabase.from("room_types").select("tenant_id, property_id").eq("id", roomTypeId.data).maybeSingle();
  if (!type) return back(PAGE, { err: "setup_forbidden" });

  const { count } = await supabase
    .from("room_type_photos")
    .select("id", { count: "exact", head: true })
    .eq("room_type_id", roomTypeId.data);
  const path = photoPath(type.tenant_id, type.property_id, roomTypeId.data, randomUUID(), check.ext);
  const { data: row, error } = await supabase
    .from("room_type_photos")
    .insert({
      tenant_id: type.tenant_id,
      property_id: type.property_id,
      room_type_id: roomTypeId.data,
      storage_path: path,
      content_type: check.contentType,
      size_bytes: (file as File).size,
      caption: check.caption,
      sort_order: count ?? 0,
    })
    .select("id")
    .single();
  if (error || !row) return back(PAGE, { err: classifyPhotoError(error ?? {}) });

  const service = createServiceClient();
  const { error: upErr } = await service.storage
    .from(PHOTO_BUCKET)
    .upload(path, await (file as File).arrayBuffer(), { contentType: check.contentType });
  if (upErr) {
    await supabase.from("room_type_photos").delete().eq("id", row.id);
    return back(PAGE, { err: "photo_upload" });
  }
  refresh();
  return ok(PAGE, "photo_added");
}

export async function removeRoomPhoto(formData: FormData) {
  const id = uuid.safeParse(formData.get("photoId"));
  if (!id.success) return back(PAGE, { err: "setup_invalid" });
  const supabase = await staffClient();
  const { data, error } = await supabase.from("room_type_photos").delete().eq("id", id.data).select("storage_path");
  if (error) return back(PAGE, { err: classifyPhotoError(error) });
  // Under row-level security a refused delete matches nothing rather than failing.
  if (!data || data.length === 0) return back(PAGE, { err: "setup_forbidden" });
  // The deleted row has queued its path for the maintenance job (migration 088); when the file goes now, clear it from the queue.
  // If this fails the job removes the file and clears the path later, so the person is not told about it.
  const service = createServiceClient();
  const paths = data.map((r) => r.storage_path);
  const { error: rmErr } = await service.storage.from(PHOTO_BUCKET).remove(paths);
  if (!rmErr) await service.rpc("finish_photo_cleanup", { p_paths: paths });
  refresh();
  return ok(PAGE, "photo_removed");
}

export async function moveRoomPhoto(formData: FormData) {
  const id = uuid.safeParse(formData.get("photoId"));
  const dir = formData.get("direction");
  if (!id.success || (dir !== "up" && dir !== "down")) return back(PAGE, { err: "setup_invalid" });
  const supabase = await staffClient();
  const { error } = await supabase.rpc("move_room_type_photo", { p_photo: id.data, p_direction: dir });
  if (error) return back(PAGE, { err: /NOT_FOUND/.test(error.message) ? "setup_forbidden" : classifyPhotoError(error) });
  refresh();
  return ok(PAGE, "photo_moved");
}

export async function setRoomPhotoCaption(formData: FormData) {
  const id = uuid.safeParse(formData.get("photoId"));
  if (!id.success) return back(PAGE, { err: "setup_invalid" });
  const raw = formData.get("caption");
  const caption = typeof raw === "string" ? raw.trim() : "";
  if (caption.length > MAX_CAPTION) return back(PAGE, { err: "setup_invalid" });
  const supabase = await staffClient();
  const { data, error } = await supabase
    .from("room_type_photos")
    .update({ caption: caption === "" ? null : caption })
    .eq("id", id.data)
    .select("id");
  if (error) return back(PAGE, { err: classifyPhotoError(error) });
  if (!data || data.length === 0) return back(PAGE, { err: "setup_forbidden" });
  refresh();
  return ok(PAGE, "photo_caption_saved");
}
