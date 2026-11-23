// Real-browser check of the staff service worker (public/sw.js). Needs no database: a small stand-in server plays the app,
// serving the real sw.js and offline.html, and can be told to answer, hang or drop the connection.
//
//   CHROME_BIN       path to a Chrome or Chromium binary (required)
//   BROWSER_DEPS     a directory whose node_modules holds puppeteer-core (default: the repo)
//   CHROME_ARGS      extra flags, space separated (for example "--no-sandbox" when running as root)
//
// Run: CHROME_BIN=/usr/bin/google-chrome node e2e/offline.mjs
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const puppeteer = (() => {
  const from = [process.env.BROWSER_DEPS, process.cwd()].filter(Boolean);
  try {
    return require(require.resolve("puppeteer-core", { paths: from }));
  } catch {
    console.error("offline: puppeteer-core not found (set BROWSER_DEPS to a directory whose node_modules has it)");
    process.exit(2);
  }
})();
if (!process.env.CHROME_BIN) {
  console.error("offline: CHROME_BIN is not set");
  process.exit(2);
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures++;
}

// ---- the stand-in app ---------------------------------------------------------------------------------------------------
const sw = readFileSync(path.join(root, "public/sw.js"));
const offlinePage = readFileSync(path.join(root, "public/offline.html"));
let mode = "up"; // up | down (connection dropped) | slow (answers after 8 seconds) | error (answers 500)
let n = 0;
const page = (title) =>
  `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p id="stamp">live ${++n}</p>` +
  `<script src="/_next/static/a.js"></script></body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (mode === "down") return req.socket.destroy();
  if (mode === "error" && url.pathname.startsWith("/app/")) {
    res.writeHead(500, { "content-type": "text/html" });
    return res.end("<h1>Server error</h1>");
  }
  const send = () => {
    if (url.pathname === "/sw.js") {
      res.writeHead(200, { "content-type": "text/javascript", "service-worker-allowed": "/app/", "cache-control": "no-store" });
      return res.end(sw);
    }
    if (url.pathname === "/offline.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(offlinePage);
    }
    if (url.pathname === "/_next/static/a.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end("window.__ASSET_LOADED = true;");
    }
    if (url.pathname === "/api/ping") {
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === "/login") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page("Sign in"));
    }
    if (url.pathname === "/app/signed-out-rooms" || url.pathname === "/app/rooms") {
      // Pretend the session ended: the real app redirects a signed-out visitor to /login.
      if (url.searchParams.get("signed") === "out") {
        res.writeHead(307, { location: "/login" });
        return res.end();
      }
    }
    const titles = {
      "/app/front-desk": "Front desk",
      "/app/rooms": "Rooms",
      "/app/payments": "Payments",
      "/app/settings/hotel": "Hotel settings",
    };
    if (titles[url.pathname]) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(page(titles[url.pathname]));
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  };
  if (mode === "slow" && url.pathname.startsWith("/app/")) setTimeout(send, 8000);
  else send();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- the browser --------------------------------------------------------------------------------------------------------
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_BIN,
  headless: "shell",
  args: ["--disable-gpu", "--disable-dev-shm-usage", ...(process.env.CHROME_ARGS ?? "").split(" ").filter(Boolean)],
});
const tab = await browser.newPage();

async function go(p, wait = "load") {
  const started = Date.now();
  const res = await tab.goto(base + p, { waitUntil: wait, timeout: 30000 }).catch((e) => ({ failed: String(e) }));
  return { res, ms: Date.now() - started };
}
const text = () => tab.evaluate(() => document.body.innerText);
const savedAt = () => tab.evaluate(() => window.__HMS_CACHED_AT ?? null);

try {
  // 1. Register the way the app does, then visit twice: the first visit is before the worker controls the page.
  await go("/app/front-desk");
  const registered = await tab.evaluate(async () => {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/app/" });
    await navigator.serviceWorker.ready;
    return reg.scope;
  });
  check("worker registers with scope /app/", registered.endsWith("/app/"), registered);
  await tab.evaluate(() =>
    navigator.serviceWorker.ready.then((reg) =>
      reg.active.postMessage({ type: "warm", paths: ["/app/rooms", "/app/payments", "/app/front-desk"] }),
    ),
  );
  await go("/app/front-desk"); // goes through the worker now: saved, and the script is kept
  await new Promise((r) => setTimeout(r, 1500));

  const caches = await tab.evaluate(async () => {
    const names = await caches.keys();
    const pages = names.find((x) => x.startsWith("hms-pages-"));
    const keys = pages ? (await (await caches.open(pages)).keys()).map((r) => new URL(r.url).pathname) : [];
    return { names, keys };
  });
  check(
    "front desk and rooms are saved",
    caches.keys.includes("/app/front-desk") && caches.keys.includes("/app/rooms"),
    JSON.stringify(caches),
  );
  check("payments is never saved, even when asked", !caches.keys.includes("/app/payments"), JSON.stringify(caches.keys));

  // 2. Online: the live page wins and carries no saved-copy marker.
  const live = await go("/app/front-desk");
  check(
    "online: live page, no saved-copy marker",
    live.res.status() === 200 && (await savedAt()) === null && /live \d+/.test(await text()),
  );

  // 3. Connection dropped: the saved copy opens, marked, and the page script still runs from the cache.
  mode = "down";
  const off = await go("/app/front-desk");
  check(
    "offline: saved front desk opens",
    off.res && off.res.status() === 200 && (await text()).includes("Front desk"),
    JSON.stringify(off.res?.failed ?? ""),
  );
  check("offline: page carries the saved-at marker", typeof (await savedAt()) === "string" && !Number.isNaN(Date.parse(await savedAt())));
  check("offline: kept script still runs", await tab.evaluate(() => window.__ASSET_LOADED === true));

  // 4. Offline and not saved: the offline page, listing what is saved.
  const miss = await go("/app/settings/hotel");
  check("offline: unsaved page shows the offline page (503)", miss.res.status() === 503 && (await text()).includes("You are offline"));
  await new Promise((r) => setTimeout(r, 500));
  const listed = await tab.evaluate(() =>
    document.getElementById("saved")?.hidden === false ? document.getElementById("list").innerText : "",
  );
  check("offline page lists the saved pages", listed.includes("Front desk") && listed.includes("Rooms"), listed);

  // 5. A page that was only a redirect to sign-in is never saved.
  mode = "up";
  await go("/app/rooms?signed=out");
  mode = "down";
  const redirected = await go("/app/rooms?signed=out");
  check("a redirect to sign-in is not saved", redirected.res.status() === 503, String(redirected.res.status()));

  // 6. Slow connection: after about 5 seconds the saved copy is shown instead of waiting for the server.
  mode = "slow";
  const slow = await go("/app/front-desk");
  check(
    "slow: saved copy shown in about 5s, not 8s",
    slow.ms > 4000 && slow.ms < 7500 && typeof (await savedAt()) === "string",
    `${slow.ms}ms`,
  );

  // 7. The server is up but failing (its database is down): the saved copy, not the error page.
  mode = "error";
  const failing = await go("/app/front-desk");
  check("server error: saved copy shown instead of the 500", failing.res.status() === 200 && typeof (await savedAt()) === "string");
  const failingMiss = await go("/app/settings/hotel");
  check("server error: an unsaved page still shows the server's own answer", failingMiss.res.status() === 500);

  // 8. Back online: live again.
  mode = "up";
  await new Promise((r) => setTimeout(r, 4000)); // let the slow request from step 6 finish and refresh the copy
  const back = await go("/app/front-desk");
  check("back online: live page again", (await savedAt()) === null && back.res.status() === 200);
} finally {
  await browser.close();
  server.closeAllConnections?.();
  server.close();
}

console.log(failures === 0 ? "ALL OFFLINE CHECKS PASSED" : `${failures} OFFLINE CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
