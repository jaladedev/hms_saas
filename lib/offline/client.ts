"use client";

import { PAGE_CACHE_PREFIX, WARM_PATHS, shouldWarm } from "./saved-pages";

const WARM_KEY = "hms-offline-warmed-at";

/** Registers the staff service worker (production only: in development it would fight hot reloading). */
export async function registerOffline(): Promise<void> {
  if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/app/" });
  } catch {
    // No worker means no saved pages, not a broken app.
  }
}

/** Asks the worker to save fresh copies of the front desk pages, at most every WARM_EVERY_MS. */
export async function warmSavedPages(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  let last: number | null = null;
  try {
    const raw = localStorage.getItem(WARM_KEY);
    last = raw === null ? null : Number(raw);
  } catch {
    // Storage blocked: warm every time rather than never.
  }
  if (!shouldWarm(last, Date.now())) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    reg.active?.postMessage({ type: "warm", paths: [...WARM_PATHS] });
    localStorage.setItem(WARM_KEY, String(Date.now()));
  } catch {
    // Same: a missed warm-up only means an older saved copy.
  }
}

/**
 * Deletes every saved page from this computer. Called on sign-out and when the sign-in page opens, so the next person at a
 * shared laptop never sees the previous person's guests. Scripts and styles are kept: they hold no hotel data.
 */
export async function clearOfflineData(): Promise<void> {
  try {
    if ("caches" in window) {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith(PAGE_CACHE_PREFIX)).map((n) => caches.delete(n)));
    }
    localStorage.removeItem(WARM_KEY);
  } catch {
    // Nothing more can be done from here.
  }
}
