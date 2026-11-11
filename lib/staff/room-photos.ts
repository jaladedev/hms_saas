/**
 * Room type photos: the rules for a picture a hotel adds to a room type, and the address guests load it from.
 * Pure helpers, so they can be tested without a browser or storage. The database enforces the same limits.
 */

export const PHOTO_BUCKET = "room-photos";
export const MAX_PHOTOS = 5;
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export const MAX_CAPTION = 100;

const TYPES: Record<string, "jpg" | "png" | "webp"> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export type PhotoCheck =
  | { ok: true; contentType: string; ext: "jpg" | "png" | "webp"; caption: string | null }
  | { ok: false; code: "photo_file" };

/** Checks the chosen file's type and size and tidies the caption (empty becomes none, too long is refused). */
export function validatePhoto(
  file: { type: string; size: number } | null | undefined,
  rawCaption: unknown,
): PhotoCheck | { ok: false; code: "setup_invalid" } {
  if (!file || file.size <= 0 || file.size > MAX_PHOTO_BYTES) return { ok: false, code: "photo_file" };
  const ext = TYPES[file.type];
  if (!ext) return { ok: false, code: "photo_file" };
  const caption = typeof rawCaption === "string" ? rawCaption.trim() : "";
  if (caption.length > MAX_CAPTION) return { ok: false, code: "setup_invalid" };
  return { ok: true, contentType: file.type, ext, caption: caption === "" ? null : caption };
}

/** "1.4 MB", "820 KB": a file size for people. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * What to tell someone who has just chosen a picture, before anything is sent: null when it is fine, otherwise the reason.
 * The same rules `validatePhoto` applies on the server, so the browser warns early and the server still decides.
 */
export function pickedPhotoProblem(file: { type: string; size: number }): string | null {
  if (!TYPES[file.type]) return "That file is not a JPEG, PNG or WebP picture.";
  if (file.size <= 0) return "That file is empty.";
  if (file.size > MAX_PHOTO_BYTES) return `That picture is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_PHOTO_BYTES)}.`;
  return null;
}

/** The storage path the database check expects: tenant / property / room type / unique id . extension. */
export function photoPath(tenantId: string, propertyId: string, roomTypeId: string, id: string, ext: string): string {
  return `${tenantId}/${propertyId}/${roomTypeId}/${id}.${ext}`;
}

/** The storage path the database expects for a hotel logo: tenant / property / logo / unique id . extension. */
export function logoPath(tenantId: string, propertyId: string, id: string, ext: string): string {
  return `${tenantId}/${propertyId}/logo/${id}.${ext}`;
}

/** The public address of a stored picture. */
export function photoUrl(supabaseUrl: string, path: string): string {
  const base = supabaseUrl.replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${PHOTO_BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Turns a database refusal on the photos table into one of our short codes. */
export function classifyPhotoError(err: {
  code?: string;
  message?: string;
}): "photo_limit" | "setup_forbidden" | "setup_invalid" | "unknown" {
  const msg = err.message ?? "";
  if (/photos limit/i.test(msg)) return "photo_limit";
  if (err.code === "42501" || /row-level security/i.test(msg)) return "setup_forbidden";
  if (err.code === "23514" || err.code === "23505") return "setup_invalid";
  return "unknown";
}
