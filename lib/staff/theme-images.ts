/**
 * The favicon and the hero image for the hotel's look (migration 182): the rules for the file, and the storage path the database
 * check expects. Pure helpers, so they can be tested without a browser or storage. The files live in the public room-photos bucket
 * beside the logo; the database ties each path to the hotel's own folder.
 */

export const THEME_IMAGE_KINDS = ["favicon", "hero"] as const;
export type ThemeImageKind = (typeof THEME_IMAGE_KINDS)[number];

export const MAX_FAVICON_BYTES = 512 * 1024;
export const MAX_HERO_BYTES = 2 * 1024 * 1024;

const TYPES: Record<string, "jpg" | "png" | "webp"> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export function isThemeImageKind(v: unknown): v is ThemeImageKind {
  return v === "favicon" || v === "hero";
}

export const THEME_IMAGE_LABEL: Record<ThemeImageKind, string> = { favicon: "Favicon", hero: "Hero image" };
export const THEME_IMAGE_LIMIT_TEXT: Record<ThemeImageKind, string> = { favicon: "512 KB", hero: "2 MB" };

export type ThemeImageCheck =
  | { ok: true; contentType: string; ext: "jpg" | "png" | "webp" }
  | { ok: false; code: "theme_image_file" };

/** Checks the chosen file's type and size for its kind. The type is the one the browser reports; storage checks it again. */
export function validateThemeImage(kind: ThemeImageKind, file: { type: string; size: number } | null | undefined): ThemeImageCheck {
  const max = kind === "favicon" ? MAX_FAVICON_BYTES : MAX_HERO_BYTES;
  if (!file || file.size <= 0 || file.size > max) return { ok: false, code: "theme_image_file" };
  const ext = TYPES[file.type];
  return ext ? { ok: true, contentType: file.type, ext } : { ok: false, code: "theme_image_file" };
}

/** The storage path the database check expects: tenant / property / favicon or hero / unique id . extension. */
export function themeImagePath(kind: ThemeImageKind, tenantId: string, propertyId: string, id: string, ext: string): string {
  return `${tenantId}/${propertyId}/${kind}/${id}.${ext}`;
}

/** The look fields a draft carries, as the draft table stores them. */
export type ThemeLook = {
  theme: string | null;
  theme_primary: string | null;
  theme_font_display: string | null;
  theme_font_body: string | null;
  theme_radius: string | null;
  favicon_path: string | null;
  hero_path: string | null;
};

export type ThemeDraftRow = ThemeLook & { property_id: string; updated_at: string };

/** Which look fields differ between the live look and the draft, as words for the "what will change" line. Empty when the draft is the same. */
export function draftChanges(live: ThemeLook, draft: ThemeLook): string[] {
  const out: string[] = [];
  if ((live.theme ?? null) !== (draft.theme ?? null)) out.push("theme");
  if ((live.theme_primary ?? null) !== (draft.theme_primary ?? null)) out.push("main colour");
  if ((live.theme_font_display ?? null) !== (draft.theme_font_display ?? null)) out.push("heading font");
  if ((live.theme_font_body ?? null) !== (draft.theme_font_body ?? null)) out.push("body font");
  if ((live.theme_radius ?? null) !== (draft.theme_radius ?? null)) out.push("corners");
  if ((live.favicon_path ?? null) !== (draft.favicon_path ?? null)) out.push("favicon");
  if ((live.hero_path ?? null) !== (draft.hero_path ?? null)) out.push("hero image");
  return out;
}

/** "theme and main colour", "theme, main colour and favicon": a list of changes in words. */
export function joinChanges(changes: string[]): string {
  if (changes.length <= 1) return changes[0] ?? "";
  return `${changes.slice(0, -1).join(", ")} and ${changes[changes.length - 1]}`;
}

/** Turns a database refusal on the draft into one of our codes. Raw database text never reaches the page. */
export function classifyThemeDraftError(err: { code?: string; message?: string }): "theme_no_draft" | "setup_forbidden" | "theme_image_file" | "setup_invalid" | "unknown" {
  const msg = err.message ?? "";
  if (/INVALID_STATE: no draft/i.test(msg)) return "theme_no_draft";
  if (/NOT_FOUND/.test(msg) || err.code === "42501" || /row-level security/i.test(msg)) return "setup_forbidden";
  if (/image kind/i.test(msg) || err.code === "23514") return "theme_image_file";
  if (/INVALID_(THEME|COLOR|FONT|RADIUS)/.test(msg)) return "setup_invalid";
  return "unknown";
}
