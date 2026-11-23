import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { CACHED_AT_HEADER, MAX_PAGE_AGE_MS, PAGE_CACHE } from "./saved-pages";

type Sw = {
  PAGE_CACHE: string;
  CACHED_AT_HEADER: string;
  MAX_PAGE_AGE_MS: number;
  isSavablePage(p: string): boolean;
  isStaticAsset(p: string): boolean;
  pageKey(u: URL): string;
  isFresh(iso: string | null, now: number): boolean;
  isStorableResponse(r: unknown): boolean;
  injectCachedAt(html: string, iso: string): string;
};

/** Loads public/sw.js the way a worker would see it, with just enough of the worker API for its top level to run. */
function loadWorker(): { exports: Sw; listeners: string[] } {
  const source = fs.readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");
  const listeners: string[] = [];
  const fakeModule = { exports: {} as Sw };
  const self = { addEventListener: (name: string) => listeners.push(name), location: { origin: "https://hms.test" } };
  vm.runInNewContext(source, { self, module: fakeModule, URL, Response, Headers, Request, caches: {}, setTimeout, console });
  return { exports: fakeModule.exports, listeners };
}

const sw = loadWorker();
const id = "0b9c1c0e-5d2a-4f7e-9a53-2f8b1a6c7d10";

describe("service worker: which pages are saved", () => {
  it("saves the front desk pages and a booking, nothing with money or guest records", () => {
    for (const p of ["/app", "/app/front-desk", "/app/front-desk/calendar", "/app/rooms", "/app/rooms/calendar", "/app/housekeeping"]) {
      expect(sw.exports.isSavablePage(p), p).toBe(true);
    }
    expect(sw.exports.isSavablePage(`/app/reservations/${id}`)).toBe(true);
    expect(sw.exports.isSavablePage(`/app/reservations/${id}/documents`)).toBe(true);
    for (const p of [
      "/app/payments",
      "/app/refunds",
      "/app/reports",
      "/app/guests",
      "/app/settings/hotel",
      "/app/emails",
      `/app/reservations/${id}/settlement`,
      "/app/reservations/not-an-id",
      "/login",
      "/",
      "/booking/abc",
    ]) {
      expect(sw.exports.isSavablePage(p), p).toBe(false);
    }
  });

  it("keeps the query in the key, so one month of a calendar is never shown for another", () => {
    const a = sw.exports.pageKey(new URL("https://hms.test/app/rooms/calendar?from=2026-11-01"));
    const b = sw.exports.pageKey(new URL("https://hms.test/app/rooms/calendar?from=2026-12-01"));
    expect(a).not.toBe(b);
  });

  it("serves built assets from the cache and nothing else", () => {
    expect(sw.exports.isStaticAsset("/_next/static/chunks/app.js")).toBe(true);
    expect(sw.exports.isStaticAsset("/_next/image")).toBe(false);
    expect(sw.exports.isStaticAsset("/app/front-desk")).toBe(false);
  });
});

describe("service worker: saved copy rules", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  it("expires a copy after a day, and rejects a missing, broken or future stamp", () => {
    expect(sw.exports.isFresh("2026-11-23T11:00:00Z", now)).toBe(true);
    expect(sw.exports.isFresh("2026-11-22T12:00:00Z", now)).toBe(true);
    expect(sw.exports.isFresh("2026-11-22T11:59:00Z", now)).toBe(false);
    expect(sw.exports.isFresh(null, now)).toBe(false);
    expect(sw.exports.isFresh("nonsense", now)).toBe(false);
    expect(sw.exports.isFresh("2026-11-24T12:00:00Z", now)).toBe(false);
  });

  it("saves only a plain 200 HTML page: never an error, a redirect to sign-in, or a response from elsewhere", () => {
    const html = (init: Partial<{ status: number; redirected: boolean; type: string; ct: string }> = {}) => ({
      status: init.status ?? 200,
      redirected: init.redirected ?? false,
      type: init.type ?? "basic",
      headers: new Headers({ "content-type": init.ct ?? "text/html; charset=utf-8" }),
    });
    expect(sw.exports.isStorableResponse(html())).toBe(true);
    expect(sw.exports.isStorableResponse(html({ status: 500 }))).toBe(false);
    expect(sw.exports.isStorableResponse(html({ redirected: true }))).toBe(false);
    expect(sw.exports.isStorableResponse(html({ type: "opaqueredirect" }))).toBe(false);
    expect(sw.exports.isStorableResponse(html({ type: "cors" }))).toBe(false);
    expect(sw.exports.isStorableResponse(html({ ct: "application/json" }))).toBe(false);
    expect(sw.exports.isStorableResponse(null)).toBe(false);
  });

  it("puts the saved-at marker just before the end of the body", () => {
    const out = sw.exports.injectCachedAt("<html><body><p>Hi</p></body></html>", "2026-11-23T10:42:00.000Z");
    expect(out).toBe('<html><body><p>Hi</p><script>window.__HMS_CACHED_AT="2026-11-23T10:42:00.000Z";</script></body></html>');
    expect(sw.exports.injectCachedAt("<p>no body tag</p>", "2026-11-23T10:42:00.000Z")).toContain("__HMS_CACHED_AT");
  });

  it("shares its constants with the page code", () => {
    expect(sw.exports.PAGE_CACHE).toBe(PAGE_CACHE);
    expect(sw.exports.CACHED_AT_HEADER).toBe(CACHED_AT_HEADER);
    expect(sw.exports.MAX_PAGE_AGE_MS).toBe(MAX_PAGE_AGE_MS);
  });

  it("handles install, activate, fetch and message, and registers nothing that writes", () => {
    expect(sw.listeners.sort()).toEqual(["activate", "fetch", "install", "message"]);
    const source = fs.readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");
    expect(source).not.toMatch(/method\s*[:=]=*\s*["'](POST|PUT|PATCH|DELETE)/i);
  });
});
