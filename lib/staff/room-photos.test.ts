import { describe, expect, it } from "vitest";
import { classifyPhotoError, MAX_PHOTO_BYTES, photoPath, photoUrl, validatePhoto } from "./room-photos";

describe("validatePhoto", () => {
  it("accepts jpeg, png and webp up to 2 MB", () => {
    for (const [type, ext] of [["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"]] as const) {
      expect(validatePhoto({ type, size: MAX_PHOTO_BYTES }, "")).toEqual({ ok: true, contentType: type, ext, caption: null });
    }
  });
  it("refuses other types, empty and oversized files, and a missing file", () => {
    expect(validatePhoto({ type: "image/gif", size: 10 }, "")).toEqual({ ok: false, code: "photo_file" });
    expect(validatePhoto({ type: "image/png", size: 0 }, "")).toEqual({ ok: false, code: "photo_file" });
    expect(validatePhoto({ type: "image/png", size: MAX_PHOTO_BYTES + 1 }, "")).toEqual({ ok: false, code: "photo_file" });
    expect(validatePhoto(null, "")).toEqual({ ok: false, code: "photo_file" });
  });
  it("trims the caption, drops an empty one and refuses one over 100 characters", () => {
    expect(validatePhoto({ type: "image/png", size: 5 }, "  View  ")).toMatchObject({ ok: true, caption: "View" });
    expect(validatePhoto({ type: "image/png", size: 5 }, "   ")).toMatchObject({ ok: true, caption: null });
    expect(validatePhoto({ type: "image/png", size: 5 }, "x".repeat(101))).toEqual({ ok: false, code: "setup_invalid" });
  });
});

describe("photoPath and photoUrl", () => {
  it("builds the path the database expects", () => {
    expect(photoPath("t", "p", "r", "i", "jpg")).toBe("t/p/r/i.jpg");
  });
  it("builds a public address and ignores a trailing slash", () => {
    expect(photoUrl("https://x.supabase.co/", "a/b.jpg")).toBe("https://x.supabase.co/storage/v1/object/public/room-photos/a/b.jpg");
  });
});

describe("classifyPhotoError", () => {
  it("recognises the limit, permission and check failures", () => {
    expect(classifyPhotoError({ code: "P0001", message: "POLICY_VIOLATION: photos limit" })).toBe("photo_limit");
    expect(classifyPhotoError({ code: "42501", message: "x" })).toBe("setup_forbidden");
    expect(classifyPhotoError({ code: "23514", message: "x" })).toBe("setup_invalid");
    expect(classifyPhotoError({ code: "XX", message: "x" })).toBe("unknown");
  });
});
