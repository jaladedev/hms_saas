// Browser smoke test: every page, in a real headless Chrome, at a desktop and a phone width.
// Runs after flow.mjs against the same app, PostgREST and Postgres (see run.sh), so the pages hold real data.
//
// It is optional. It needs Chrome and puppeteer-core, which are not dependencies of the repo:
//   CHROME_BIN       path to a Chrome or Chromium binary (run.sh skips this file when it is unset)
//   BROWSER_DEPS     a directory whose node_modules holds puppeteer-core (default: the repo)
//   CHROME_ARGS      extra flags, space separated (for example "--no-sandbox" when running as root)
//   SHOTS_DIR        where screenshots go (default /tmp/e2e-shots)
//
// For each page it checks: the status, no uncaught script error, no console error, no failed request, no sideways
// scrolling (a page wider than the screen), an h1, and no error page. It does NOT judge looks: the screenshots are
// for a person to open. It also does not click anything: the clicks are flow.mjs's job, over HTTP.
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";

const SITE = process.env.SITE_URL ?? "http://127.0.0.1:3100";
const REST = process.env.POSTGREST_URL ?? "http://127.0.0.1:3001";
const HOST = "book.hotel-a.test";
const JWT_SECRET = process.env.PGRST_JWT_SECRET;
const SHOTS = process.env.SHOTS_DIR ?? "/tmp/e2e-shots";
mkdirSync(SHOTS, { recursive: true });

const require = createRequire(import.meta.url);
const puppeteer = (() => {
  const from = [process.env.BROWSER_DEPS, process.cwd()].filter(Boolean);
  try { return require(require.resolve("puppeteer-core", { paths: from })); }
  catch { console.error("browser: puppeteer-core not found (set BROWSER_DEPS to a directory whose node_modules has it)"); process.exit(2); }
})();

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures++;
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(claims) {
  const head = b64({ alg: "HS256", typ: "JWT" }), body = b64({ iss: "e2e", exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
  return `${head}.${body}.${createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url")}`;
}
/** The cookie the app reads for a signed-in person: same shape as flow.mjs. */
function sessionCookie(sub, email) {
  const access_token = token({ role: "authenticated", aud: "authenticated", sub, email });
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const value = { access_token, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "e2e-refresh", user: { id: sub, aud: "authenticated", role: "authenticated", email } };
  return { name: "sb-127-auth-token", value: `base64-${Buffer.from(JSON.stringify(value)).toString("base64url")}`, url: SITE };
}
const OWNER = sessionCookie("00000000-0000-0000-0000-00000000aa01", "ada.owner@hotel-a.test");
const PLATFORM_ADMIN = sessionCookie("00000000-0000-0000-0000-00000000f060", "admin@platform.test");
const PLATFORM_SUPPORT = sessionCookie("00000000-0000-0000-0000-00000000f061", "support@platform.test");

// Real records for the pages that have an id in the address. flow.mjs never creates a maintenance request or an invoice
// for extras, so those are made here, as the owner and through the same database functions the screens call. Each has a
// fixed idempotency key, so running this twice makes one of each.
const PROPERTY = "00000000-0000-0000-0000-0000000000a2";
const OWNER_ID = "00000000-0000-0000-0000-00000000aa01";
const service = token({ role: "service_role" });
const owner = token({ role: "authenticated", aud: "authenticated", sub: OWNER_ID });
const rest = (path, bearer, init = {}) => fetch(`${REST}${path}`, { ...init, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...(init.headers ?? {}) } });
async function firstRow(table, query) {
  const res = await rest(`/${table}?select=*&${query}&limit=1`, service);
  return res.ok ? ((await res.json())[0] ?? null) : null;
}
async function seed(fn, args) {
  const res = await rest(`/rpc/${fn}`, owner, { method: "POST", body: JSON.stringify(args) });
  if (!res.ok) check(`seed: ${fn}`, false, `${res.status} ${(await res.text()).slice(0, 160)}`);
  return res.ok;
}

const inHouse = await firstRow("reservations", "reservation_status=eq.checked_in&order=id.asc");
check("a guest is in the house to open the reservation pages on", !!inHouse, "no checked_in reservation after flow.mjs");
if (inHouse) {
  await seed("post_folio_charge", { p_reservation_id: inHouse.id, p_category: "minibar", p_description: "Browser check: water and snacks", p_quantity: 2, p_unit_amount_minor: 250000, p_idempotency_key: "browser-charge-1" });
  await seed("issue_folio_invoice", { p_reservation_id: inHouse.id, p_idempotency_key: "browser-invoice-1" });
}
await seed("report_maintenance_request", { p_property_id: PROPERTY, p_room_id: null, p_location: "Lobby", p_title: "Browser check: lobby light flickers", p_description: "Made by e2e/browser.mjs", p_priority: "normal", p_due_at: null, p_assigned_to: null, p_idempotency_key: "browser-repair-1" });

const guest = await firstRow("guests", "order=id.asc");
const repair = await firstRow("maintenance_requests", "title=like.Browser*");
const invoice = inHouse ? await firstRow("folio_invoices", `reservation_id=eq.${inHouse.id}&order=id.asc`) : null;
check("a guest, a repair and an invoice exist for their pages", !!guest && !!repair && !!invoice, `guest ${!!guest} repair ${!!repair} invoice ${!!invoice}`);
const reservationId = inHouse?.id ?? null, guestId = guest?.id ?? null, maintenanceId = repair?.id ?? null;

const staffPages = [
  "/app", "/app/front-desk", "/app/front-desk/calendar", "/app/reservations", "/app/reservations/new", "/app/rooms", "/app/rooms/calendar",
  "/app/housekeeping", "/app/maintenance", "/app/guests", "/app/refunds", "/app/reconciliation", "/app/emails",
  "/app/reports", "/app/reports/occupancy", "/app/reports/channels",
  "/app/settings", "/app/settings/rooms", "/app/settings/rates", "/app/settings/tax", "/app/settings/policies", "/app/settings/history", "/app/staff",
  ...(reservationId ? [`/app/reservations/${reservationId}`, `/app/reservations/${reservationId}/settlement`] : []),
  ...(guestId ? [`/app/guests/${guestId}`] : []),
  ...(maintenanceId ? [`/app/maintenance/${maintenanceId}`] : []),
  ...(invoice ? [`/app/reservations/${invoice.reservation_id}/folio-invoice/${invoice.id}`] : []),
];
// The platform area, as a platform admin (and the read-only list as support). It never shows a hotel's reservations or guests.
const tenant = await firstRow("tenants", "order=id.asc");
check("a hotel group exists for the platform pages", !!tenant);
const platformPages = ["/platform", "/platform/new", ...(tenant ? [`/platform/${tenant.id}`] : [])];

// The guest's own links, made by flow.mjs: the page that quotes a room, the booking page, and the cancel page.
const shared = (() => { try { return JSON.parse(readFileSync(process.env.E2E_SHARE_FILE ?? "/tmp/e2e-share.json", "utf8")); } catch { return null; } })();
check("flow.mjs shared the guest booking links", !!shared?.reservePath && !!shared?.bookingPath, "no share file (E2E_SHARE_FILE)");
const guestPages = ["/", "/booking/find", "/login", "/forgot-password", ...(shared ? [shared.reservePath, shared.bookingPath, `${shared.bookingPath}/cancel`] : [])];

const viewports = [
  { name: "desktop", width: 1280, height: 800, isMobile: false },
  { name: "phone", width: 390, height: 844, isMobile: true },
];

// Controls on a phone that are shorter than a finger-sized 44px (the WCAG 2.5.5 target; 2.5.8 asks for 24px at least).
// Links inside a sentence are exempt from the guideline, so they are marked and counted apart. This only reports.
const tapTargets = [];
const smallTargets = (page) => page.evaluate(() => [...document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, summary")]
  .filter((el) => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && !el.classList.contains("sr-only") && r.height < 44;
  })
  .map((el) => {
    const r = el.getBoundingClientRect();
    return { tag: el.tagName.toLowerCase() + (el.type && el.tagName !== "BUTTON" ? `[${el.type}]` : ""), text: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 28), h: Math.round(r.height), w: Math.round(r.width), inline: el.tagName === "A" && !!el.closest("p, li, dd, td, th, label") };
  }));
function reportTargets() {
  const groups = new Map();
  for (const t of tapTargets) {
    const key = `${t.inline ? "in a sentence" : "stand-alone "} ${t.tag} "${t.text}" ${t.h}px`;
    const g = groups.get(key) ?? { n: 0, pages: new Set() };
    g.n++; g.pages.add(t.page); groups.set(key, g);
  }
  const rows = [...groups].sort((a, b) => b[1].n - a[1].n);
  console.log(`tap targets under 44px on a phone: ${tapTargets.length} (${tapTargets.filter((t) => !t.inline).length} stand-alone)`);
  for (const [key, g] of rows.slice(0, 45)) console.log(`  ${String(g.n).padStart(3)}x on ${String(g.pages.size).padStart(2)} page(s)  ${key}`);
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_BIN,
  headless: "shell",
  args: ["--disable-gpu", "--disable-dev-shm-usage", ...(process.env.CHROME_ARGS ?? "").split(" ").filter(Boolean)],
});

async function visit(path, { guest, viewport, as = OWNER, kind = guest ? "guest" : "staff" }) {
  // A fresh browser context for every page, so a login cookie set for a staff page is never sent on to a guest page.
  const context = await (browser.createBrowserContext ?? browser.createIncognitoBrowserContext).call(browser);
  const page = await context.newPage();
  await page.setViewport({ width: viewport.width, height: viewport.height, isMobile: viewport.isMobile, hasTouch: viewport.isMobile, deviceScaleFactor: 1 });
  if (guest) await page.setExtraHTTPHeaders({ "x-forwarded-host": HOST, "x-forwarded-proto": "http" });
  else await page.setCookie(as);

  const problems = [];
  page.on("pageerror", (e) => problems.push(`script error: ${String(e.message ?? e).slice(0, 160)}`));
  // Only the app's own origin counts. Other hosts (Google Fonts, for one) are not reachable from a test machine with no
  // internet, and a page must still work when they are not, so a failure to reach them says nothing about the app.
  const ours = (url) => url.startsWith(SITE);
  page.on("console", (m) => { if (m.type() === "error" && (!m.location()?.url || ours(m.location().url))) problems.push(`console error: ${m.text().slice(0, 160)}`); });
  // ERR_ABORTED is the browser cancelling a request it no longer needs (Next.js link prefetches still in flight when the
  // page is closed), not a failure. A real one reads ERR_CONNECTION_REFUSED, ERR_FAILED and so on.
  page.on("requestfailed", (r) => { if (ours(r.url()) && !r.url().includes("favicon") && r.failure()?.errorText !== "net::ERR_ABORTED") problems.push(`request failed: ${r.url().replace(SITE, "")} ${r.failure()?.errorText ?? ""}`); });
  page.on("response", (r) => { if (ours(r.url()) && r.status() >= 400 && !r.url().includes("favicon")) problems.push(`HTTP ${r.status()} ${r.url().replace(SITE, "")}`); });

  let status = 0;
  try {
    const res = await page.goto(`${SITE}${path}`, { waitUntil: "networkidle2", timeout: 45000 });
    status = res?.status() ?? 0;
  } catch (e) { problems.push(`did not load: ${String(e.message).slice(0, 120)}`); }

  // The width to compare with is the screen's, passed in. window.innerWidth is no use on a phone: Chrome widens it to fit
  // whatever is too wide and zooms out, so a page 417px wide on a 390px screen would look fine.
  const facts = await page.evaluate((vw) => ({
    h1: document.querySelectorAll("h1").length,
    over: document.documentElement.scrollWidth - vw,
    // Elements that stick out past the screen and that no scrolling box holds. An absolutely positioned element is held by a
    // scrolling ancestor only when that ancestor also contains the element's positioning parent; otherwise it escapes it.
    wide: [...document.querySelectorAll("body *")].filter((el) => {
      if (el.getBoundingClientRect().right <= vw + 1) return false;
      const position = getComputedStyle(el).position;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        if (getComputedStyle(a).overflowX === "visible") continue;
        if (position !== "absolute" && position !== "fixed") return false;
        if (a.contains(el.offsetParent)) return false;
      }
      return true;
    }).slice(0, 3).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`),
    errorPage: /Application error|This page couldn.t load|Internal Server Error/i.test(document.body?.innerText ?? ""),
  }), viewport.width).catch(() => ({ h1: 0, over: 0, wide: [], errorPage: true }));
  const landed = new URL(page.url()).pathname;
  const small = viewport.isMobile ? await smallTargets(page) : [];
  tapTargets.push(...small.map((t) => ({ ...t, page: path.replace(/\?.*$/, "") })));

  // The page's name without its query, record ids or the guest's private token: for the label and the file name.
  const shortPath = path.replace(/\?.*$/, "").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id").replace(/\/booking\/[\w-]+\.[\w-]+/, "/booking/:token");
  const file = `${SHOTS}/${kind}-${shortPath.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "home"}-${viewport.name}.png`;
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  await context.close();

  const label = `${kind} ${shortPath} (${viewport.name})`;
  check(`${label} loads cleanly`, status === 200 && problems.length === 0 && !facts.errorPage, `status ${status} ${problems.slice(0, 3).join(" | ")}`);
  check(`${label} stays on the page asked for`, landed === new URL(path, SITE).pathname, `landed on ${landed}`);
  if (viewport.isMobile) {
    // A link in a sentence is exempt from the 44px guideline, and a checkbox is 24px with its label as the rest of the target.
    const tooSmall = small.filter((t) => !t.inline && /^(button|select|input|summary)/.test(t.tag) && !/^input\[(checkbox|radio)\]/.test(t.tag));
    check(`${label} buttons, fields and toggles are finger-sized`, tooSmall.length === 0, tooSmall.slice(0, 3).map((t) => `${t.tag} "${t.text}" ${t.h}px`).join(", "));
  }
  check(`${label} has a heading`, facts.h1 >= 1, `h1 count ${facts.h1}`);
  check(`${label} does not scroll sideways`, facts.over <= 1, `${facts.over}px too wide, e.g. ${facts.wide.join(", ")}`);
}

for (const viewport of viewports) {
  for (const path of staffPages) await visit(path, { guest: false, viewport });
  for (const path of platformPages) await visit(path, { guest: false, viewport, as: PLATFORM_ADMIN, kind: "platform" });
  await visit("/platform", { guest: false, viewport, as: PLATFORM_SUPPORT, kind: "platform-support" });
  for (const path of guestPages) await visit(path, { guest: true, viewport });
}
// The staff menu: a sidebar on a laptop, a Menu button on a phone that opens and closes the same links.
async function menuChecks(viewport) {
  const context = await (browser.createBrowserContext ?? browser.createIncognitoBrowserContext).call(browser);
  const page = await context.newPage();
  await page.setViewport({ width: viewport.width, height: viewport.height, isMobile: viewport.isMobile, hasTouch: viewport.isMobile, deviceScaleFactor: 1 });
  await page.setCookie(OWNER);
  await page.goto(`${SITE}/app`, { waitUntil: "networkidle2", timeout: 45000 });
  const LINK = '#staff-menu a[href="/app/reservations"]', BUTTON = 'button[aria-controls="staff-menu"]';
  const shown = (sel) => page.$eval(sel, (el) => el.offsetParent !== null && getComputedStyle(el).visibility !== "hidden").catch(() => false);
  const expanded = () => page.$eval(BUTTON, (el) => el.getAttribute("aria-expanded")).catch(() => null);
  const name = `staff menu (${viewport.name})`;
  if (!viewport.isMobile) {
    check(`${name}: links are in the sidebar and there is no Menu button`, (await shown(LINK)) && !(await shown(BUTTON)));
  } else {
    check(`${name}: starts closed, with a Menu button and no links showing`, (await shown(BUTTON)) && !(await shown(LINK)) && (await expanded()) === "false");
    await page.click(BUTTON);
    check(`${name}: the button opens it`, (await shown(LINK)) && (await expanded()) === "true");
    await page.screenshot({ path: `${SHOTS}/staff-menu-open-${viewport.name}.png` }).catch(() => {});
    tapTargets.push(...(await smallTargets(page)).map((t) => ({ ...t, page: "(menu open)" })));
    await Promise.all([page.waitForFunction(() => location.pathname === "/app/reservations", { timeout: 20000 }).catch(() => {}), page.click(LINK)]);
    check(`${name}: a link goes to its page`, new URL(page.url()).pathname === "/app/reservations", `landed on ${new URL(page.url()).pathname}`);
    check(`${name}: and the menu is closed again on the new page`, (await expanded()) === "false" && !(await shown(LINK)), `expanded ${await expanded()}`);
  }
  await context.close();
}
for (const viewport of viewports) await menuChecks(viewport);

// The shared button styles are also put on links (New reservation is one), and a button rule cannot reach a link.
async function linkButtonCheck(viewport) {
  const context = await (browser.createBrowserContext ?? browser.createIncognitoBrowserContext).call(browser);
  const page = await context.newPage();
  await page.setViewport({ width: viewport.width, height: viewport.height, isMobile: viewport.isMobile, hasTouch: viewport.isMobile, deviceScaleFactor: 1 });
  await page.setCookie(OWNER);
  await page.goto(`${SITE}/app/reservations`, { waitUntil: "networkidle2", timeout: 45000 });
  const h = await page.$eval('a[href="/app/reservations/new"]', (el) => Math.round(el.getBoundingClientRect().height)).catch(() => 0);
  check(`button-styled link (${viewport.name}) is ${viewport.isMobile ? "finger-sized" : "compact, as before"}`, viewport.isMobile ? h >= 44 : h > 0 && h <= 36, `height ${h}px`);
  await context.close();
}
for (const viewport of viewports) await linkButtonCheck(viewport);

await browser.close();
if (process.env.REPORT_TARGETS) reportTargets();
console.log(`screenshots: ${SHOTS}`);
if (failures) { console.log(`BROWSER FAILED: ${failures} check(s)`); process.exit(1); }
console.log("BROWSER PASSED");
