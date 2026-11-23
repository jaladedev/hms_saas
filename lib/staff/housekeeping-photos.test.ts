import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { errorMessage, OK_MESSAGES } from "./refunds";
import {
  classifyTaskPhotoError,
  isPhotoKind,
  MAX_PHOTOS_PER_KIND,
  MAX_TASK_PHOTO_BYTES,
  PHOTO_KINDS,
  TASK_PHOTO_ACCEPT,
  TASK_PHOTO_BUCKET,
  TASK_PHOTO_LINK_SECONDS,
  taskPhotoLabel,
  taskPhotoPath,
  validateTaskPhoto,
} from "./housekeeping-photos";

const T = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";
const K = "33333333-3333-4333-8333-333333333333";
const F = "44444444-4444-4444-8444-444444444444";
const migration = readFileSync("supabase/migrations/20261026000181_housekeeping_photos.sql", "utf8");

describe("validateTaskPhoto", () => {
  it("accepts JPEG, PNG and WebP up to the limit, and names the extension", () => {
    expect(validateTaskPhoto({ type: "image/jpeg", size: 1 })).toEqual({ ok: true, contentType: "image/jpeg", ext: "jpg" });
    expect(validateTaskPhoto({ type: "image/png", size: 1000 })).toMatchObject({ ok: true, ext: "png" });
    expect(validateTaskPhoto({ type: "image/webp", size: MAX_TASK_PHOTO_BYTES })).toMatchObject({ ok: true, ext: "webp" });
  });
  it("refuses an empty file, one over 5 MB, no file, and any other type (a PDF is a receipt, not a task picture)", () => {
    for (const f of [
      { type: "image/jpeg", size: 0 },
      { type: "image/jpeg", size: MAX_TASK_PHOTO_BYTES + 1 },
      null,
      undefined,
      { type: "image/gif", size: 10 },
      { type: "application/pdf", size: 10 },
      { type: "image/svg+xml", size: 10 },
      { type: "image/heic", size: 10 },
      { type: "", size: 10 },
    ]) {
      expect(validateTaskPhoto(f), JSON.stringify(f)).toEqual({ ok: false, code: "hkphoto_file" });
    }
  });
  it("matches what the file box offers and what the bucket and table allow", () => {
    expect(TASK_PHOTO_ACCEPT.split(",").sort()).toEqual(["image/jpeg", "image/png", "image/webp"]);
    for (const t of TASK_PHOTO_ACCEPT.split(",")) expect(migration).toContain(`'${t}'`);
    expect(migration).toContain(String(MAX_TASK_PHOTO_BYTES));
    expect(migration).toMatch(new RegExp(`>= ${MAX_PHOTOS_PER_KIND} then`));
    expect(MAX_PHOTOS_PER_KIND).toBe(3);
    for (const k of PHOTO_KINDS) expect(migration).toContain(`'${k}'`);
  });
});

describe("kinds and paths", () => {
  it("knows exactly before and after", () => {
    expect(isPhotoKind("before")).toBe(true);
    expect(isPhotoKind("after")).toBe(true);
    for (const v of ["during", "", "BEFORE", null, undefined, 1, ["before"]]) expect(isPhotoKind(v)).toBe(false);
  });
  it("is tenant / property / task / kind / id . extension, the shape the table checks", () => {
    expect(taskPhotoPath(T, P, K, "before", F, "jpg")).toBe(`${T}/${P}/${K}/before/${F}.jpg`);
    expect(migration).toContain("(jpg|png|webp)");
    expect(migration).toContain("|| '/' || kind || '/");
  });
});

describe("classifyTaskPhotoError", () => {
  it("words each database refusal as a code and never passes text through", () => {
    expect(classifyTaskPhotoError({ message: "POLICY_VIOLATION: task photos limit" })).toBe("hkphoto_limit");
    expect(classifyTaskPhotoError({ message: "POLICY_VIOLATION: photo property" })).toBe("hkphoto_forbidden");
    expect(classifyTaskPhotoError({ code: "42501", message: "x" })).toBe("hkphoto_forbidden");
    expect(classifyTaskPhotoError({ message: 'new row violates row-level security policy for table "housekeeping_task_photos"' })).toBe(
      "hkphoto_forbidden",
    );
    expect(classifyTaskPhotoError({ code: "23514", message: "check" })).toBe("hkphoto_file");
    expect(classifyTaskPhotoError({ code: "23505", message: "dup" })).toBe("hkphoto_file");
    expect(classifyTaskPhotoError({ message: "boom" })).toBe("unknown");
    expect(classifyTaskPhotoError({})).toBe("unknown");
  });
});

describe("labels and messages", () => {
  it("says which picture and how big", () => {
    expect(taskPhotoLabel("before", 1, 340 * 1024)).toBe("Before 1, 340 KB");
    expect(taskPhotoLabel("after", 3, 1.5 * 1024 * 1024)).toBe("After 3, 1.5 MB");
  });
  it("has words for every outcome and never shows database text", () => {
    expect(OK_MESSAGES.hkphoto_added).toMatch(/added/);
    expect(OK_MESSAGES.hkphoto_removed).toMatch(/removed/);
    for (const code of ["hkphoto_file", "hkphoto_limit", "hkphoto_forbidden", "hkphoto_storage"]) {
      const text = errorMessage(code, null, String);
      expect(text.length, code).toBeGreaterThan(15);
      expect(text, code).not.toMatch(/constraint|row-level|undefined|policy/i);
    }
  });
});

// The rules that keep a private file private and a task untouched are in the actions and the page; these read their source.
describe("photo actions and page wiring", () => {
  const actions = readFileSync("lib/staff/housekeeping-photo-actions.ts", "utf8");
  const add = actions.slice(
    actions.indexOf("export async function addTaskPhoto"),
    actions.indexOf("export async function removeTaskPhoto"),
  );
  const remove = actions.slice(actions.indexOf("export async function removeTaskPhoto"));
  const page = readFileSync("app/(staff)/app/housekeeping-task/[id]/page.tsx", "utf8");

  it("adding checks the form first, writes the row as the person, then stores the file, and withdraws the row if storing fails", () => {
    expect(add).toContain("isPhotoKind(kind)");
    expect(add.indexOf(".insert(")).toBeGreaterThan(add.indexOf("validateTaskPhoto("));
    expect(add.indexOf("storage")).toBeGreaterThan(add.indexOf(".insert("));
    expect(add).toMatch(/upErr\) \{\s*await supabase\.from\("housekeeping_task_photos"\)\.delete\(\)\.eq\("id", row\.id\)/);
  });

  it("removing checks the person may remove BEFORE the file goes, and the file goes before the row", () => {
    const perm = remove.indexOf('"hk_photo_allowed"');
    const file = remove.indexOf(".remove([row.storage_path])");
    const del = remove.indexOf('.from("housekeeping_task_photos").delete()');
    expect(perm).toBeGreaterThan(-1);
    expect(file).toBeGreaterThan(perm);
    expect(del).toBeGreaterThan(file);
    expect(remove).toContain("p_adding: false");
  });

  it("never changes a task: no write to tasks, rooms or their functions anywhere in the photo code", () => {
    for (const src of [actions, readFileSync("lib/staff/housekeeping-photos.ts", "utf8")]) {
      expect(src).not.toMatch(/from\("(housekeeping_tasks|rooms)"\)\s*\.(insert|update|delete|upsert)/);
      expect(src).not.toMatch(/\.rpc\("(start|complete|claim|assign|cancel|create)_housekeeping_task/);
    }
  });

  it("shows a picture only by a short-lived signed link, from a private bucket", () => {
    expect(TASK_PHOTO_BUCKET).toBe("housekeeping-photos");
    expect(TASK_PHOTO_LINK_SECONDS).toBeLessThanOrEqual(600);
    expect(page).toContain("createSignedUrls(");
    expect(page).not.toContain("getPublicUrl");
    expect(migration).toMatch(/values \('housekeeping-photos', 'housekeeping-photos', false,/);
  });

  it("keeps the task page outside the housekeeping folder, whose loading boundary cannot hold a page that answers not-found", () => {
    expect(actions).toContain("/app/housekeeping-task/${taskId}");
    expect(readFileSync("app/(staff)/app/housekeeping/page.tsx", "utf8")).toContain("/app/housekeeping-task/${t.id}");
    expect(page).toContain("notFound()");
  });

  it("opens a picture in a new tab without handing over the opener or the address", () => {
    expect(page).toMatch(/target="_blank" rel="noopener noreferrer"/);
  });

  it("offers adding and removing from the database's own answer, and adding only below the limit", () => {
    expect(page).toContain('"hk_photo_allowed", { p_task: task.id, p_adding: true }');
    expect(page).toContain('"hk_photo_allowed", { p_task: task.id, p_adding: false }');
    expect(page).toMatch(/canAdd && mine\.length < MAX_PHOTOS_PER_KIND/);
    expect(page).toMatch(/\{canRemove && \(\s*<form action=\{removeTaskPhoto\}/);
  });
});
