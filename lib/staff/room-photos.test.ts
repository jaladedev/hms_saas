import { describe, expect, it } from "vitest";
import {
  classifyPhotoError,
  formatBytes,
  logoPath,
  MAX_PHOTO_BYTES,
  photoPath,
  photoUrl,
  pickedPhotoProblem,
  validatePhoto,
} from "./room-photos";
import { isActive } from "@/components/ui/nav-link";

describe("validatePhoto", () => {
  it("accepts jpeg, png and webp up to 2 MB", () => {
    for (const [type, ext] of [
      ["image/jpeg", "jpg"],
      ["image/png", "png"],
      ["image/webp", "webp"],
    ] as const) {
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
  it("builds the logo path the database expects", () => {
    expect(logoPath("t", "p", "i", "png")).toBe("t/p/logo/i.png");
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

describe("pickedPhotoProblem", () => {
  it("passes a good picture and agrees with validatePhoto", () => {
    const f = { type: "image/png", size: 1000 };
    expect(pickedPhotoProblem(f)).toBeNull();
    expect(validatePhoto(f, "").ok).toBe(true);
  });
  it("names the problem for a wrong type, an empty file and a big one", () => {
    expect(pickedPhotoProblem({ type: "application/pdf", size: 10 })).toMatch(/not a JPEG/);
    expect(pickedPhotoProblem({ type: "image/png", size: 0 })).toMatch(/empty/);
    expect(pickedPhotoProblem({ type: "image/png", size: MAX_PHOTO_BYTES + 1 })).toMatch(/limit is 2\.0 MB/);
  });
  it("formats sizes", () => {
    expect(formatBytes(820 * 1024)).toBe("820 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(10)).toBe("1 KB");
  });
});

describe("isActive (navbar current page)", () => {
  it("matches the page and its children, unless exact", () => {
    expect(isActive("/app/payments/all", "/app/payments/all")).toBe(true);
    expect(isActive("/app/guests/123", "/app/guests")).toBe(true);
    expect(isActive("/app/payments/all", "/app/payments", true)).toBe(false);
    expect(isActive("/app/payments", "/app/payments", true)).toBe(true);
  });
  it("does not light a link for a look-alike path or a #hash link", () => {
    expect(isActive("/app/guestsbook", "/app/guests")).toBe(false);
    expect(isActive("/", "/#rooms")).toBe(false);
  });
});
