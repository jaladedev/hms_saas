import { formatBytes } from "./room-photos";

/**
 * Before and after photos on a housekeeping task (migration 181): the rules for the file, and the storage path the database check
 * expects. Pure helpers, so they can be tested without a browser or storage. The database enforces the same limits.
 */

export const TASK_PHOTO_BUCKET = "housekeeping-photos";
export const MAX_PHOTOS_PER_KIND = 3;
export const MAX_TASK_PHOTO_BYTES = 5 * 1024 * 1024;
/** How long a link to a picture stays valid. It is made when the page is shown, for someone who may see the task. */
export const TASK_PHOTO_LINK_SECONDS = 300;
/** For the file box: what the browser offers to pick. The server still decides. */
export const TASK_PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";

export const PHOTO_KINDS = ["before", "after"] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];
export const PHOTO_KIND_LABEL: Record<PhotoKind, string> = { before: "Before", after: "After" };
export const isPhotoKind = (v: unknown): v is PhotoKind => typeof v === "string" && (PHOTO_KINDS as readonly string[]).includes(v);

const TYPES: Record<string, "jpg" | "png" | "webp"> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export type TaskPhotoCheck = { ok: true; contentType: string; ext: "jpg" | "png" | "webp" } | { ok: false; code: "hkphoto_file" };

/** Checks the chosen file's type and size. The type is the one the browser reports; storage checks it again against the bucket's list. */
export function validateTaskPhoto(file: { type: string; size: number } | null | undefined): TaskPhotoCheck {
  if (!file || file.size <= 0 || file.size > MAX_TASK_PHOTO_BYTES) return { ok: false, code: "hkphoto_file" };
  const ext = TYPES[file.type];
  return ext ? { ok: true, contentType: file.type, ext } : { ok: false, code: "hkphoto_file" };
}

/** The storage path the database check expects: tenant / property / task / kind / unique id . extension. */
export function taskPhotoPath(tenantId: string, propertyId: string, taskId: string, kind: PhotoKind, id: string, ext: string): string {
  return `${tenantId}/${propertyId}/${taskId}/${kind}/${id}.${ext}`;
}

/** Turns a database refusal on a task picture into one of our codes. Raw database text never reaches the page. */
export function classifyTaskPhotoError(err: {
  code?: string;
  message?: string;
}): "hkphoto_limit" | "hkphoto_forbidden" | "hkphoto_file" | "unknown" {
  const msg = err.message ?? "";
  if (/task photos limit/i.test(msg)) return "hkphoto_limit";
  if (/photo property/i.test(msg) || err.code === "42501" || /row-level security/i.test(msg)) return "hkphoto_forbidden";
  if (err.code === "23514" || err.code === "23505") return "hkphoto_file";
  return "unknown";
}

/** "Before 2, 340 KB": what to call a picture in a list. */
export function taskPhotoLabel(kind: PhotoKind, position: number, sizeBytes: number): string {
  return `${PHOTO_KIND_LABEL[kind]} ${position}, ${formatBytes(sizeBytes)}`;
}
