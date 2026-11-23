/** Shared by the staff pages and public/sw.js (which cannot import this file, so lib/offline/sw.test.ts checks the two agree). */
export const PAGE_CACHE_PREFIX = "hms-pages-";
export const PAGE_CACHE = "hms-pages-v1";
export const CACHED_AT_HEADER = "x-hms-cached-at";
export const MAX_PAGE_AGE_MS = 24 * 60 * 60 * 1000;

/** The pages front desk needs most; fetched in the background so they are saved before the connection drops. */
export const WARM_PATHS = ["/app/front-desk", "/app/rooms", "/app/rooms/calendar", "/app/housekeeping"] as const;
/** Pages are refreshed at most this often by the background fetch (a visit to a page refreshes it anyway). */
export const WARM_EVERY_MS = 10 * 60 * 1000;

export function shouldWarm(lastWarmMs: number | null, nowMs: number): boolean {
  return lastWarmMs === null || !Number.isFinite(lastWarmMs) || nowMs - lastWarmMs >= WARM_EVERY_MS || nowMs < lastWarmMs;
}

/** "10:42", or "Mon 10:42" when the copy is from another day. */
export function savedAtLabel(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "earlier";
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

export type BannerState = "none" | "offline-saved" | "offline-live" | "slow-saved";

/**
 * What the banner should say. A saved copy is on screen when the service worker injected its marker; offline means the
 * connection check failed. Online with a live page needs no banner.
 */
export function bannerState(offline: boolean, savedAt: string | null): BannerState {
  if (offline) return savedAt ? "offline-saved" : "offline-live";
  return savedAt ? "slow-saved" : "none";
}
