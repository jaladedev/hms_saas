/*
 * Staff service worker (scope /app/). It does three things and nothing else:
 *
 *  1. Keeps a saved copy of the pages front desk needs when the connection drops (arrivals, rooms, room calendar,
 *     housekeeping, a booking). Network first: a live page always wins. When the network is down, or has not answered
 *     in SLOW_NETWORK_MS, the saved copy is shown with a marker (window.__HMS_CACHED_AT) so the page can say so.
 *  2. Keeps the built scripts and styles (/_next/static, hashed and immutable) so a saved page can still run.
 *  3. Shows /offline.html when a /app page has no saved copy.
 *
 * It never handles anything that writes (server actions are POSTs), never touches the guest site, and saved pages
 * are deleted by the page on sign-out (lib/offline/client.ts). Bump VERSION when this file's behaviour changes.
 */
"use strict";

const VERSION = "v1";
const PAGE_CACHE = "hms-pages-" + VERSION;
const STATIC_CACHE = "hms-static-" + VERSION;
const SHELL_CACHE = "hms-shell-" + VERSION;
const OFFLINE_URL = "/offline.html";
const CACHED_AT_HEADER = "x-hms-cached-at";
const MAX_PAGE_AGE_MS = 24 * 60 * 60 * 1000;
const SLOW_NETWORK_MS = 5000;
const MAX_PAGES = 60;
const MAX_STATIC = 400;

const SAVABLE_EXACT = new Set([
  "/app",
  "/app/front-desk",
  "/app/front-desk/calendar",
  "/app/rooms",
  "/app/rooms/calendar",
  "/app/housekeeping",
  "/app/reservations",
]);
// A booking page and its printable documents. Money screens, reports, settings and guest records are never saved.
const SAVABLE_PATTERN = /^\/app\/reservations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/documents)?$/;

function isSavablePage(pathname) {
  return SAVABLE_EXACT.has(pathname) || SAVABLE_PATTERN.test(pathname);
}

function isStaticAsset(pathname) {
  return pathname.indexOf("/_next/static/") === 0;
}

/** The cache key for a page: path and query, so a calendar for one month is never shown for another. */
function pageKey(url) {
  return url.origin + url.pathname + url.search;
}

function isFresh(cachedAtIso, nowMs) {
  const t = Date.parse(cachedAtIso || "");
  return Number.isFinite(t) && nowMs - t >= 0 && nowMs - t <= MAX_PAGE_AGE_MS;
}

/** Only a plain 200 HTML page from this site is worth saving: not a redirect (to the sign-in page), not an error. */
function isStorableResponse(res) {
  if (!res || res.status !== 200 || res.redirected || res.type !== "basic") return false;
  const type = res.headers.get("content-type") || "";
  return type.indexOf("text/html") !== -1;
}

/** Adds the marker the page reads to tell the person they are looking at a saved copy. */
function injectCachedAt(html, cachedAtIso) {
  const tag = "<script>window.__HMS_CACHED_AT=" + JSON.stringify(cachedAtIso) + ";</script>";
  const at = html.lastIndexOf("</body>");
  return at === -1 ? html + tag : html.slice(0, at) + tag + html.slice(at);
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

async function trim(cache, max) {
  const keys = await cache.keys();
  const extra = keys.length - max;
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
}

async function storePage(key, res) {
  const body = await res.arrayBuffer();
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set(CACHED_AT_HEADER, new Date().toISOString());
  const cache = await caches.open(PAGE_CACHE);
  await cache.put(key, new Response(body, { status: 200, statusText: "OK", headers: headers }));
  await trim(cache, MAX_PAGES);
}

/** Asks the server for a page and, when the answer is storable, saves a copy. Rejects when the network is down. */
async function fetchAndStore(request, key) {
  const res = await fetch(request);
  if (isStorableResponse(res)) {
    try {
      await storePage(key, res.clone());
    } catch {
      // A full disk or a blocked cache must never stop the live page from showing.
    }
  }
  return res;
}

async function readSavedPage(key) {
  const cache = await caches.open(PAGE_CACHE);
  const hit = await cache.match(key, { ignoreVary: true });
  if (!hit) return null;
  const savedAt = hit.headers.get(CACHED_AT_HEADER);
  if (!isFresh(savedAt, Date.now())) {
    await cache.delete(key);
    return null;
  }
  return { response: hit, savedAt: savedAt };
}

async function savedCopyResponse(saved) {
  const html = injectCachedAt(await saved.response.text(), saved.savedAt);
  const headers = new Headers(saved.response.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.delete("content-length");
  return new Response(html, { status: 200, statusText: "OK", headers: headers });
}

async function offlineResponse() {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(OFFLINE_URL);
  const body = hit ? await hit.text() : "<h1>You are offline</h1><p>Check the connection and try again.</p>";
  return new Response(body, { status: 503, statusText: "Offline", headers: { "content-type": "text/html; charset=utf-8" } });
}

async function handlePage(event, request, url) {
  const key = pageKey(url);
  const network = fetchAndStore(request, key);
  network.catch(function () {});
  const saved = await readSavedPage(key);
  if (!saved) {
    try {
      return await network;
    } catch {
      return offlineResponse();
    }
  }
  const slow = sleep(SLOW_NETWORK_MS).then(function () {
    return "slow";
  });
  try {
    const first = await Promise.race([network, slow]);
    // A server error (the app is up but its database is not, or a gateway is down) is no better than no answer.
    if (first !== "slow" && first.status < 500) return first;
  } catch {
    // Network down: fall through to the saved copy.
  }
  // Let the slow request finish in the background so the next visit has a fresh copy.
  event.waitUntil(network.catch(function () {}));
  return savedCopyResponse(saved);
}

async function handleOtherNavigation(request) {
  try {
    return await fetch(request);
  } catch {
    return offlineResponse();
  }
}

async function handleStatic(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === "basic") {
    cache.put(request, res.clone()).then(function () {
      return trim(cache, MAX_STATIC);
    });
  }
  return res;
}

/** The page asks for fresh copies of the pages front desk needs, while the connection is good. */
async function warm(paths) {
  for (let i = 0; i < paths.length; i++) {
    const url = new URL(paths[i], self.location.origin);
    if (!isSavablePage(url.pathname)) continue;
    try {
      await fetchAndStore(new Request(url.href, { credentials: "same-origin", headers: { Accept: "text/html" } }), pageKey(url));
    } catch {
      return; // The connection dropped: stop, the next visit tries again.
    }
  }
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(function (cache) {
        return cache.add(OFFLINE_URL);
      })
      .then(function () {
        return self.skipWaiting();
      }),
  );
});

self.addEventListener("activate", function (event) {
  const keep = [PAGE_CACHE, STATIC_CACHE, SHELL_CACHE];
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        return Promise.all(
          names
            .filter(function (n) {
              return n.indexOf("hms-") === 0 && keep.indexOf(n) === -1;
            })
            .map(function (n) {
              return caches.delete(n);
            }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

self.addEventListener("fetch", function (event) {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate" && isSavablePage(url.pathname)) {
    event.respondWith(handlePage(event, request, url));
  } else if (request.mode === "navigate" && url.pathname.indexOf("/app") === 0) {
    event.respondWith(handleOtherNavigation(request));
  } else if (isStaticAsset(url.pathname)) {
    event.respondWith(handleStatic(request));
  }
});

self.addEventListener("message", function (event) {
  const data = event.data;
  if (data && data.type === "warm" && Array.isArray(data.paths)) {
    event.waitUntil(
      warm(
        data.paths
          .filter(function (p) {
            return typeof p === "string";
          })
          .slice(0, 10),
      ),
    );
  }
});

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PAGE_CACHE: PAGE_CACHE,
    CACHED_AT_HEADER: CACHED_AT_HEADER,
    MAX_PAGE_AGE_MS: MAX_PAGE_AGE_MS,
    isSavablePage: isSavablePage,
    isStaticAsset: isStaticAsset,
    pageKey: pageKey,
    isFresh: isFresh,
    isStorableResponse: isStorableResponse,
    injectCachedAt: injectCachedAt,
  };
}
