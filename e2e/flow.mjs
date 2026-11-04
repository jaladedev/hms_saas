// End-to-end guest flow against the real app, real PostgREST, real Postgres and a fake Paystack.
import { createHmac } from "node:crypto";

const SITE = process.env.SITE_URL ?? "http://127.0.0.1:3100";
const FAKE = process.env.FAKE_PAYSTACK_URL ?? "http://127.0.0.1:4010";
const REST = process.env.POSTGREST_URL ?? "http://127.0.0.1:3001";
const HOST = "book.hotel-a.test";
const RESEND = process.env.FAKE_RESEND_URL ?? "http://127.0.0.1:4011";
const CRON_SECRET = process.env.CRON_SECRET;
const SECRET = process.env.PAYSTACK_SECRET_E2E;
const ACCOUNT_ID = process.env.ACCOUNT_ID;
const JWT_SECRET = process.env.PGRST_JWT_SECRET;

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failures++;
}

// Page text, not page markup. React puts comment nodes between adjacent text and expressions in the served HTML, so a
// plain html.includes("Publish version 1") can miss text that is really there, and, worse, a negative check such as
// !html.includes("Pay now") can pass because the text is split. Text checks go through these; only attributes, classes
// and links are matched against raw markup.
// What a person reads on a page: scripts (which carry the page's data as text) and tags removed, entities decoded.
const pageText = (html) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ")
  .replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const words = (s) => s.replace(/\s+/g, " ").trim();
const sees = (text, ...needles) => needles.every((n) => text.includes(words(n)));
const doesNotSee = (text, ...needles) => needles.every((n) => !text.includes(words(n)));
const quoted = (s) => `“${s}”`;

const site = (path, init = {}) =>
  fetch(`${SITE}${path}`, { redirect: "manual", ...init, headers: { "x-forwarded-host": HOST, "x-forwarded-proto": "http", ...(init.headers ?? {}) } });

function hiddenInputs(html, scope) {
  const part = scope ? html.slice(html.indexOf(scope)) : html;
  const out = [];
  for (const m of part.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const name = /name="([^"]*)"/.exec(m[0])?.[1];
    const value = /value="([^"]*)"/.exec(m[0])?.[1] ?? "";
    if (name) out.push([name, value.replace(/&amp;/g, "&")]);
  }
  return out;
}
const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#x27;/g, "'");

function jwt(role, secret = JWT_SECRET, sub) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b({ alg: "HS256", typ: "JWT" }), body = b({ role, iss: "e2e", exp: Math.floor(Date.now() / 1000) + 3600, ...(sub ? { sub } : {}) });
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}
const rpc = (fn, args, token) => fetch(`${REST}/rpc/${fn}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(args) });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function emails() { return (await fetch(`${RESEND}/_sent`)).json(); }
async function waitForEmail(match, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const found = (await emails()).find(match);
    if (found) return found;
    await sleep(300);
  }
  return null;
}
const linkIn = (email) => /(http:\/\/book\.hotel-a\.test)(\/booking\/[\w.-]+)/.exec(email.text)?.[2];

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const arrival = day(40), departure = day(42);

// 1. Search page lists room types with a price
let res = await site(`/?arrival=${arrival}&departure=${departure}&adults=2&children=0`);
let html = await res.text();
check("search page renders room types from the database", res.status === 200 && sees(pageText(html), "Standard", "Solo Suite", "50,000.00"), `status ${res.status}`);
check("search page names the hotel in the header and the intro, with its check-in and check-out times",
  sees(pageText(html), "Hotel A Ibadan", "Check in from 14:00", "Check out by 12:00"), pageText(html).slice(0, 300));
const reserveHref = decode(/href="(\/reserve\?[^"]*type=[^"]*)"/.exec(html)?.[1] ?? "");
check("search page links to the reserve page", reserveHref.startsWith("/reserve?"), html.slice(0, 300));

// 2. A host the system does not know gets a polite message, not data
res = await fetch(`${SITE}/?arrival=${arrival}&departure=${departure}`, { headers: { "x-forwarded-host": "nobody.example" }, redirect: "manual" });
html = await res.text();
check("unknown host shows the not-configured message", sees(pageText(html), "not available on this site yet"));
check("unknown host gets the plain header and no hotel details", sees(pageText(html), "Book your stay") && doesNotSee(pageText(html), "Hotel A Ibadan", "Check in from"));

// 3. Reserve page, then submit the real server-action form
res = await site(reserveHref);
html = await res.text();
check("reserve page renders the quote and form", res.status === 200 && sees(pageText(html), "Hold my room", "Your reservation"), `status ${res.status}`);
let form = new FormData();
for (const [k, v] of hiddenInputs(html, "<form")) form.append(k, v);
form.set("quantity", "1"); form.set("full_name", "Ada Obi"); form.set("email", "ada.e2e@example.com"); form.set("phone", "+2348000000000");
res = await site(reserveHref, { method: "POST", body: form });
const bookingPath = res.headers.get("location") ?? "";
check("reserve action creates a hold and redirects to the booking page", res.status === 303 && /^\/booking\/[\w-]+\.[\w-]+$/.test(bookingPath), `status ${res.status} location ${bookingPath}`);

// 4. Booking page shows a live hold and a pay button
res = await site(bookingPath);
html = await res.text();
check("booking page shows reference, hold and pay button", res.status === 200 && /BK-[A-Z0-9-]+/.test(html) && sees(pageText(html), "Pay now", "Still to pay"));
const reference = /BK-[A-Z0-9-]+/.exec(html)?.[0];

// 5. Tampered tokens are not found
res = await site(bookingPath.slice(0, -3) + "AAA");
check("a tampered booking token is a 404", res.status === 404, `status ${res.status}`);

// 6. Pay: the server action creates an attempt and opens the (fake) checkout
form = new FormData();
for (const [k, v] of hiddenInputs(html, "<form")) form.append(k, v);
res = await site(bookingPath, { method: "POST", body: form });
const checkoutUrl = res.headers.get("location") ?? "";
check("pay action redirects to the provider checkout", res.status === 303 && checkoutUrl.startsWith(`${FAKE}/checkout/`), `status ${res.status} location ${checkoutUrl}`);
const attemptRef = decodeURIComponent(checkoutUrl.split("/checkout/")[1] ?? "");
const state = await (await fetch(`${FAKE}/_state/${encodeURIComponent(attemptRef)}`)).json();
check("provider received our reference, kobo amount, email and callback URL",
  state.init?.reference === attemptRef && state.init?.amount === 5000000 && state.init?.currency === "NGN"
  && state.init?.email === "ada.e2e@example.com" && state.init?.callback_url === `http://${HOST}${bookingPath}?paid=1`, JSON.stringify(state.init));

// 7. Returning from checkout before the webhook shows a waiting message
res = await site(`${bookingPath}?paid=1`);
html = await res.text();
check("callback page says payment is being confirmed", sees(pageText(html), "confirming your payment") && html.includes('http-equiv="refresh"'));

// 8. Webhook: bad signature rejected, good one confirms, replay is harmless
const body = JSON.stringify({ event: "charge.success", data: { id: state.id, reference: attemptRef, amount: 1, currency: "USD" } });
const sign = (b, secret = SECRET) => createHmac("sha512", secret).update(b).digest("hex");
const hook = (b, sig) => fetch(`${SITE}/api/webhooks/paystack/${ACCOUNT_ID}`, { method: "POST", headers: { "content-type": "application/json", "x-paystack-signature": sig }, body: b });
res = await hook(body, sign(body, "sk_test_wrong_secret_value"));
check("webhook with a wrong signature is 401", res.status === 401, `status ${res.status}`);
res = await hook(body, sign(body));
let out = await res.json();
check("signed webhook confirms the booking from the VERIFIED amount", res.status === 200 && out.result === "confirmed", JSON.stringify(out));
res = await hook(body, sign(body));
out = await res.json();
check("replayed webhook is a harmless duplicate", res.status === 200 && out.duplicate === true, JSON.stringify(out));
res = await fetch(`${SITE}/api/webhooks/paystack/00000000-0000-0000-0000-00000000dead`, { method: "POST", body, headers: { "x-paystack-signature": sign(body) } });
check("webhook for an unknown account is 404", res.status === 404, `status ${res.status}`);

// The paid amount must be exactly one payment, not doubled by the replay
const reservationId = JSON.parse(Buffer.from(bookingPath.split("/").pop().split(".")[0], "base64url").toString()).r;
res = await rpc("guest_booking_status", { p_reservation_id: reservationId }, jwt("service_role"));
const status = await res.json();
check("after the replay the booking holds exactly one payment", status.paid_minor === 5000000 && status.outstanding_minor === 0 && status.status === "confirmed", JSON.stringify(status));

// 9. Booking page now confirmed and fully paid
res = await site(bookingPath);
html = await res.text();
check("booking page shows confirmed and paid", sees(pageText(html), "Your booking is confirmed") && doesNotSee(pageText(html), "Pay now"), "");

// 9b. Emails: held (sent right after the reserve action) and confirmed (after the webhook), with working links
const heldMail = await waitForEmail((m) => m.to[0] === "ada.e2e@example.com" && m.subject.includes("Complete your booking") && m.subject.includes(reference));
check("hold email was sent to the guest with the booking reference", heldMail !== null, JSON.stringify((await emails()).map((m) => m.subject)));
const heldPath = heldMail ? linkIn(heldMail) : undefined;
check("the emailed link opens the booking", !!heldPath && pageText(await (await site(heldPath)).text()).includes(reference), String(heldPath));
check("email html escapes and carries the button link", !!heldMail && heldMail.html.includes(`href="http://book.hotel-a.test${heldPath}"`));
const confirmedMail = await waitForEmail((m) => m.to[0] === "ada.e2e@example.com" && m.subject.startsWith("Booking confirmed") && m.subject.includes(reference));
check("confirmation email was sent after the webhook", confirmedMail !== null);
check("no email was sent twice", new Set((await emails()).map((m) => m.idem)).size === (await emails()).length);

// 9c. Maintenance route: protected, and it runs its steps
res = await fetch(`${SITE}/api/cron/maintenance`);
check("maintenance route refuses a missing secret", res.status === 401, `status ${res.status}`);
res = await fetch(`${SITE}/api/cron/maintenance`, { headers: { authorization: "Bearer wrong" } });
check("maintenance route refuses a wrong secret", res.status === 401, `status ${res.status}`);
res = await fetch(`${SITE}/api/cron/maintenance`, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
out = await res.json();
check("maintenance route runs hold expiry, emails and purge", res.status === 200 && out.expiredHolds?.ok && out.emails?.ok && out.purge?.ok, JSON.stringify(out));

// 9d. Link re-issue: same answer whether or not anything matched, email only on a match
res = await site("/booking/find");
html = await res.text();
const findFields = hiddenInputs(html, "<form");
const submitFind = async (referenceText, email, ip) => {
  const f = new FormData();
  for (const [k, v] of findFields) f.append(k, v);
  f.set("reference", referenceText); f.set("email", email);
  const r = await site("/booking/find", { method: "POST", body: f, headers: ip ? { "x-forwarded-for": ip } : {} });
  return r.headers.get("location") ?? "";
};
const before = (await emails()).length;
let loc = await submitFind(reference.toLowerCase(), "  ADA.E2E@example.com ");
check("matching link request redirects to the generic confirmation", loc === "/booking/find?sent=1", loc);
const linkMail = await waitForEmail((m) => m.subject.startsWith("Your booking link for") && m.to[0] === "ada.e2e@example.com");
check("matching link request emails a fresh working link", !!linkMail && !!linkIn(linkMail) && pageText(await (await site(linkIn(linkMail))).text()).includes(reference));
loc = await submitFind(reference, "someone.else@example.com");
check("a wrong email gets the same generic answer", loc === "/booking/find?sent=1", loc);
await sleep(1500); await (await fetch(`${SITE}/api/cron/maintenance`, { headers: { authorization: `Bearer ${CRON_SECRET}` } })).text();
check("a wrong email sends nothing", (await emails()).filter((m) => m.to[0] === "someone.else@example.com").length === 0 && (await emails()).length === before + 1);

// 9e. Rate limits (distinct client addresses so the earlier steps are unaffected)
const linkIp = "203.0.113.50";
const outcomes = [];
for (let i = 0; i < 6; i++) outcomes.push(await submitFind(reference, `probe${i}@example.com`, linkIp));
check("link requests are limited per address (5 allowed, then refused)",
  outcomes.slice(0, 5).every((l) => l === "/booking/find?sent=1") && outcomes[5] === "/booking/find?error=rate_limited", JSON.stringify(outcomes));
html = await (await site("/booking/find?error=rate_limited")).text();
check("the limit message is friendly", sees(pageText(html), "Too many attempts"));

res = await site(reserveHref);
html = await res.text();
const reserveFields = hiddenInputs(html, "<form");
const holdOutcomes = [];
for (let i = 0; i < 11; i++) {
  const f = new FormData();
  for (const [k, v] of reserveFields) f.append(k, v);
  f.set("quantity", "1"); f.set("full_name", "Rate Tester"); f.set("email", `rate${i}@example.com`); f.set("key", `rate-key-${i}-${Date.now()}`);
  const r = await site(reserveHref, { method: "POST", body: f, headers: { "x-forwarded-for": "198.51.100.77" } });
  holdOutcomes.push(r.headers.get("location") ?? "");
}
check("holds are limited per address: ten attempts counted, the eleventh refused",
  holdOutcomes.slice(0, 10).every((l) => !l.includes("error=rate_limited")) && holdOutcomes[10].includes("error=rate_limited"), JSON.stringify(holdOutcomes.map((l) => l.split("error=")[1] ?? "ok")));
res = await site(`/?arrival=${arrival}&departure=${departure}&adults=2&children=0`, { headers: { "x-forwarded-for": "192.0.2.200" } });
html = await res.text();
check("other addresses are not affected by that limit", res.status === 200 && sees(pageText(html), "Find a room") && doesNotSee(pageText(html), "Too many attempts"));
res = await site(`/?arrival=${arrival}&departure=${departure}&adults=2&children=0`, { headers: { "x-forwarded-for": "198.51.100.77" } });
check("the limited address still browses (search has its own, larger limit)", res.status === 200 && doesNotSee(pageText(await res.text()), "Too many attempts"));

// 9f. Cancellation, settlement and a refund, driven by two staff identities over PostgREST,
//     finished by Paystack's real refund webhook shape (amount as a string, refund_reference)
const OWNER = jwt("authenticated", JWT_SECRET, "00000000-0000-0000-0000-00000000aa01");
const ACCOUNTANT = jwt("authenticated", JWT_SECRET, "00000000-0000-0000-0000-00000000aa05");
const call = async (fn, args, token) => { const r = await rpc(fn, args, token); return { status: r.status, body: await r.json().catch(() => null) }; };
const maint = () => fetch(`${SITE}/api/cron/maintenance`, { headers: { authorization: `Bearer ${CRON_SECRET}` } }).then((r) => r.json());

let c = await call("cancel_reservation", { p_reservation_id: reservationId, p_reason: "guest asked to cancel", p_idempotency_key: "e2e-cancel-1" }, OWNER);
check("owner cancels the paid booking", c.status === 200 && c.body?.status === "cancelled", JSON.stringify(c));
res = await fetch(`${REST}/refunds?reservation_id=eq.${reservationId}&select=id,refund_status,amount_minor,requested_by`, { headers: { authorization: `Bearer ${ACCOUNTANT}` } });
const refunds = await res.json();
check("cancellation requested a refund for everything paid, in the canceller's name", refunds.length === 1 && refunds[0].refund_status === "requested" && refunds[0].amount_minor === 5000000 && refunds[0].requested_by === "00000000-0000-0000-0000-00000000aa01", JSON.stringify(refunds));
const refundId = refunds[0]?.id;
c = await call("approve_refund", { p_refund_id: refundId, p_approve: true, p_note: null, p_idempotency_key: "e2e-approve-1" }, OWNER);
check("the canceller cannot approve their own refund", c.status >= 400 && JSON.stringify(c.body).includes("SELF_APPROVAL"), JSON.stringify(c));
c = await call("approve_refund", { p_refund_id: refundId, p_approve: true, p_note: null, p_idempotency_key: "e2e-approve-2" }, ACCOUNTANT);
check("a second person approves it", c.status === 200 && c.body?.status === "approved", JSON.stringify(c));
c = await call("start_refund_payout", { p_refund_id: refundId }, OWNER);
check("payout may be started once (call_allowed)", c.status === 200 && c.body?.call_allowed === true && c.body?.payment_provider_reference === attemptRef && c.body?.amount_minor === 5000000, JSON.stringify(c));
c = await call("start_refund_payout", { p_refund_id: refundId }, OWNER);
check("a second payout start is refused (call_allowed false)", c.status === 200 && c.body?.call_allowed === false, JSON.stringify(c));
c = await call("start_refund_payout", { p_refund_id: refundId }, jwt("authenticated", JWT_SECRET, "00000000-0000-0000-0000-00000000dead"));
check("someone without refund rights cannot start a payout", c.status >= 400, JSON.stringify(c));

const refundHook = (data, event = "refund.processed") => {
  const b = JSON.stringify({ event, data });
  return fetch(`${SITE}/api/webhooks/paystack/${ACCOUNT_ID}`, { method: "POST", headers: { "content-type": "application/json", "x-paystack-signature": sign(b) }, body: b });
};
const refundData = { status: "processed", transaction_reference: attemptRef, refund_reference: "rf_e2e_1", amount: "5000000", currency: "NGN" };
res = await refundHook({ ...refundData, amount: "4999999" });
out = await res.json();
check("a refund event for the wrong amount matches nothing", res.status === 200 && out.result === "ignored_no_match", JSON.stringify(out));
res = await refundHook(refundData);
out = await res.json();
check("Paystack's refund.processed (string amount) completes the refund", res.status === 200 && out.result === "succeeded", JSON.stringify(out));
res = await refundHook(refundData);
out = await res.json();
check("a repeated refund event is harmless", res.status === 200 && (out.duplicate === true || out.result === "ignored_no_match"), JSON.stringify(out));
res = await rpc("guest_booking_status", { p_reservation_id: reservationId }, jwt("service_role"));
const after = await res.json();
check("the books are settled: cancelled, nothing held", after.status === "cancelled" && after.paid_minor === 0, JSON.stringify(after));
res = await fetch(`${REST}/rpc/reservation_settlement`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ACCOUNTANT}` }, body: JSON.stringify({ p_reservation_id: reservationId }) });
const settlement = await res.json();
check("reservation_settlement reports it settled", settlement.settled === true && settlement.refunded_minor === 5000000, JSON.stringify(settlement));
await maint();
const cancelMail = await waitForEmail((m) => m.to[0] === "ada.e2e@example.com" && m.subject.includes("has been cancelled"));
const refundMail = await waitForEmail((m) => m.to[0] === "ada.e2e@example.com" && m.subject.startsWith("Refund processed"));
check("the guest got a cancellation email and a refund email", !!cancelMail && !!refundMail && refundMail.text.includes("50,000.00"), JSON.stringify((await emails()).map((m) => m.subject)));
const stale = await maint();
check("maintenance reports no refunds stuck in processing", stale.staleRefunds?.ok === true && stale.staleRefunds.result.count === 0, JSON.stringify(stale.staleRefunds));

// 10. PostgREST access control with real signed JWTs
const args = { p_host: HOST, p_arrival: arrival, p_departure: departure, p_adults: 2, p_children: 0 };
res = await rpc("search_availability", args, jwt("service_role"));
check("service_role JWT can call service-only functions", res.status === 200, `status ${res.status} ${await res.text()}`);
for (const role of ["anon", "authenticated"]) {
  res = await rpc("search_availability", args, jwt(role));
  check(`${role} JWT is refused`, res.status === 401 || res.status === 403, `status ${res.status}`);
}
res = await rpc("search_availability", args, jwt("service_role", "x".repeat(40)));
check("service_role JWT signed with another secret is refused", res.status === 401, `status ${res.status}`);
res = await rpc("confirm_payment", { p_provider: "paystack", p_event_id: "e", p_event_type: "t", p_reference: attemptRef, p_status: "success", p_amount_minor: 1, p_currency: "NGN", p_channel: "card" }, jwt("authenticated"));
check("authenticated JWT cannot call confirm_payment", res.status === 401 || res.status === 403, `status ${res.status}`);

// 11. Staff screens over HTTP: tax rules and setup history, signed in with a session cookie.
// The fake auth server (proxy.mjs) accepts a token signed with the PostgREST secret, so these are the real pages,
// real server actions, real row-level security and the real audit triggers. Rules start in 2090 so they tax nothing.
const OWNER_ID = "00000000-0000-0000-0000-00000000aa01", ACCOUNTANT_ID = "00000000-0000-0000-0000-00000000aa05";
function session(sub, email) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b({ alg: "HS256", typ: "JWT" }), exp = Math.floor(Date.now() / 1000) + 3600;
  const body = b({ role: "authenticated", aud: "authenticated", iss: "e2e", sub, email, exp });
  const access_token = `${head}.${body}.${createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url")}`;
  const value = { access_token, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "e2e-refresh", user: { id: sub, aud: "authenticated", role: "authenticated", email } };
  return `sb-127-auth-token=base64-${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}
const OWNER_COOKIE = session(OWNER_ID, "ada.owner@hotel-a.test"), ACCOUNTANT_COOKIE = session(ACCOUNTANT_ID, "accounts@hotel-a.test");
const staff = (path, cookie, init = {}) => fetch(`${SITE}${path}`, { redirect: "manual", ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) } });

/** The form (hidden inputs, which carry the server action id) whose markup contains `marker`. */
function formWith(html, marker) {
  for (const m of html.matchAll(/<form[\s\S]*?<\/form>/g)) if (m[0].includes(marker)) return m[0];
  return null;
}
function formData(block, fields) {
  const data = new FormData();
  for (const [k, v] of hiddenInputs(block)) data.append(k, v);
  for (const [k, v] of Object.entries(fields)) if (v !== null) data.set(k, v);
  return data;
}
const outcome = (res) => new URL(res.headers.get("location") ?? "/", SITE).searchParams;
const PROPERTY_A = "00000000-0000-0000-0000-0000000000a2";
const taxRows = async (name) => (await fetch(`${REST}/tax_rules?name=eq.${encodeURIComponent(name)}&select=id,basis,rate_value,sequence,compounds,effective_from,effective_to,status,applies_to_charges`, { headers: { authorization: `Bearer ${jwt("service_role")}` } })).json();

res = await staff("/app/settings/tax", null);
check("the tax page sends a signed-out visitor to sign in", res.status === 307 && (res.headers.get("location") ?? "").includes("/login"), `status ${res.status} ${res.headers.get("location")}`);

res = await staff("/app/settings/tax", OWNER_COOKIE);
let taxHtml = await res.text();
check("the owner sees the tax rules page with the add form", res.status === 200 && sees(pageText(taxHtml), "Tax rules", "Add a tax rule"), `status ${res.status}`);
const addBlock = formWith(taxHtml, 'name="propertyId"');
check("the add form carries a server action and the property", Boolean(addBlock) && /\$ACTION_ID_/.test(addBlock) && addBlock.includes(PROPERTY_A), addBlock?.slice(0, 200));

const newRule = { propertyId: PROPERTY_A, name: "E2E VAT", basis: "percent", rate: "7.5", sequence: "", effectiveFrom: "2090-01-01", effectiveTo: "", compounds: null };
const addTax = (fields, cookie = OWNER_COOKIE) => staff("/app/settings/tax", cookie, { method: "POST", body: formData(addBlock, { ...newRule, ...fields }) });

res = await addTax({});
check("adding a percent rule redirects with the success code", res.status === 303 && outcome(res).get("ok") === "tax_rule_created", `status ${res.status} ${res.headers.get("location")}`);
let rows = await taxRows("E2E VAT");
check("the rule is stored: 7.5 percent, switched on, extras untaxed, ordered after the others",
  rows.length === 1 && rows[0].basis === "percent" && Number(rows[0].rate_value) === 7.5 && rows[0].status === "active" && rows[0].applies_to_charges === false && rows[0].effective_from === "2090-01-01" && rows[0].effective_to === null && rows[0].sequence >= 1, JSON.stringify(rows));
const vatId = rows[0]?.id;

res = await addTax({ name: "e2e vat", effectiveFrom: "2090-06-01" });
check("a second switched-on rule with the same name over the same dates is refused (double tax)", res.status === 303 && outcome(res).get("err") === "tax_duplicate", `status ${res.status} ${res.headers.get("location")}`);
res = await addTax({ name: "Bad rate", rate: "abc" });
check("a rate that is not a number is refused as invalid", outcome(res).get("err") === "tax_invalid", res.headers.get("location") ?? "");
res = await addTax({ name: "Bad rate", rate: "150" });
check("a percentage above 100 is refused as invalid", outcome(res).get("err") === "tax_invalid", res.headers.get("location") ?? "");
res = await addTax({ name: "Backwards", effectiveFrom: "2090-05-01", effectiveTo: "2090-04-01" });
check("a last day before the first day is refused as invalid", outcome(res).get("err") === "tax_invalid", res.headers.get("location") ?? "");
check("none of the refused rules was stored", (await taxRows("Bad rate")).length === 0 && (await taxRows("Backwards")).length === 0);

res = await addTax({ name: "E2E Levy", basis: "fixed_per_night", rate: "1,000", compounds: "on" });
check("a fixed amount rule is added", outcome(res).get("ok") === "tax_rule_created", res.headers.get("location") ?? "");
rows = await taxRows("E2E Levy");
check("the fixed amount is stored in kobo and 'on top of' is ignored for it", rows.length === 1 && rows[0].basis === "fixed_per_night" && Number(rows[0].rate_value) === 100000 && rows[0].compounds === false, JSON.stringify(rows));
const levyId = rows[0]?.id;

res = await addTax({ name: "Owner Only" }, ACCOUNTANT_COOKIE);
check("a login without property.configure cannot add a rule: the database refuses it", res.status === 303 && outcome(res).get("err") === "tax_forbidden", `status ${res.status} ${res.headers.get("location")}`);
check("and nothing was stored", (await taxRows("Owner Only")).length === 0);

res = await staff("/app/settings/tax", OWNER_COOKIE);
taxHtml = await res.text();
check("the new rules are listed, with the rate in the right unit",
  sees(pageText(taxHtml), "E2E VAT", "7.5%", "E2E Levy", "1,000.00 a night", "Starts later"));

// Edit: change the rate and switch the rule off; the extras mark must not move
const editBlock = [...taxHtml.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0]).find((b) => b.includes(`name="ruleId" value="${vatId}"`) && b.includes('name="status"'));
check("the edit form for the rule is on the page", Boolean(editBlock) && /\$ACTION_ID_/.test(editBlock));
const vatNow = (await taxRows("E2E VAT"))[0];
const editFields = { ruleId: vatId, name: "E2E VAT", rate: "10", sequence: String(vatNow.sequence), effectiveFrom: "2090-01-01", effectiveTo: "", status: "inactive", compounds: null };
res = await staff("/app/settings/tax", OWNER_COOKIE, { method: "POST", body: formData(editBlock, editFields) });
check("saving an edit redirects with the success code", res.status === 303 && outcome(res).get("ok") === "tax_rule_updated", `status ${res.status} ${res.headers.get("location")}`);
rows = await taxRows("E2E VAT");
check("the rate changed, the rule is switched off, and the extras mark was not touched", rows.length === 1 && Number(rows[0].rate_value) === 10 && rows[0].status === "inactive" && rows[0].applies_to_charges === false, JSON.stringify(rows));
res = await staff("/app/settings/tax", OWNER_COOKIE, { method: "POST", body: formData(editBlock, { ...editFields, rate: "0" }) });
check("an edit to a zero rate is refused", outcome(res).get("err") === "tax_invalid", res.headers.get("location") ?? "");
res = await staff("/app/settings/tax", ACCOUNTANT_COOKIE, { method: "POST", body: formData(editBlock, { ...editFields, rate: "20" }) });
check("a login without property.configure cannot edit: zero rows changed is a refusal, not a success", res.status === 303 && ["tax_forbidden", "tax_not_found"].includes(outcome(res).get("err")), `status ${res.status} ${res.headers.get("location")}`);
check("and the rate is still 10", Number((await taxRows("E2E VAT"))[0].rate_value) === 10);

// The switch for extras: a percent rule can be marked, a fixed rule is refused by the database's own constraint
res = await staff("/app/settings/tax", OWNER_COOKIE);
taxHtml = await res.text();
const toggleBlock = formWith(taxHtml, 'name="apply"');
check("a percent rule offers the extras switch", Boolean(toggleBlock) && /\$ACTION_ID_/.test(toggleBlock));
res = await staff("/app/settings/tax", OWNER_COOKIE, { method: "POST", body: formData(toggleBlock, { ruleId: vatId, apply: "on" }) });
check("the extras switch turns on", outcome(res).get("ok") === "tax_extras_on" && (await taxRows("E2E VAT"))[0].applies_to_charges === true, res.headers.get("location") ?? "");
res = await staff("/app/settings/tax", OWNER_COOKIE, { method: "POST", body: formData(toggleBlock, { ruleId: levyId, apply: "on" }) });
check("the extras switch on a fixed rule is refused by the database", outcome(res).get("err") === "tax_not_percent" && (await taxRows("E2E Levy"))[0].applies_to_charges === false, res.headers.get("location") ?? "");

// Suspend and reinstate the accountant through the real function, as the owner: the rows have no property
const ACCOUNTANT_MEMBERSHIP = "00000000-0000-0000-0000-0000000aaa05";
res = await rpc("set_staff_status", { p_membership: ACCOUNTANT_MEMBERSHIP, p_status: "suspended" }, jwt("authenticated", JWT_SECRET, OWNER_ID));
check("the owner can suspend a staff member", res.status === 200, `status ${res.status} ${await res.text()}`);
res = await rpc("set_staff_status", { p_membership: ACCOUNTANT_MEMBERSHIP, p_status: "active" }, jwt("authenticated", JWT_SECRET, OWNER_ID));
check("and reinstate them", res.status === 200, `status ${res.status} ${await res.text()}`);

// Setup history: the audit rows those changes wrote, read as the signed-in person
res = await staff("/app/settings/history", null);
check("the history page sends a signed-out visitor to sign in", res.status === 307, `status ${res.status}`);
res = await staff("/app/settings/history", OWNER_COOKIE);
let histHtml = await res.text();
check("the owner sees the setup history", res.status === 200 && sees(pageText(histHtml), "Setup history"), `status ${res.status}`);
check("it lists the added rule by name, with who did it (audit_actor_names over PostgREST)", sees(pageText(histHtml), "Added the tax rule", "E2E VAT", "Ada Owner"), histHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 400));
check("it shows the edit as old and new values, in the rule's own unit", sees(pageText(histHtml), "Rate: 7.5% \u2192 10%", "Status: Active \u2192 Switched off"), histHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 600));
check("it shows the fixed amount as naira a night", sees(pageText(histHtml), "1,000.00 a night"));
const plain = pageText;
res = await staff("/app/settings/history?what=staff", OWNER_COOKIE);
histHtml = await res.text();
check("staff access changes are listed, by person and with from and to (migration 030)",
  res.status === 200 && plain(histHtml).includes("accounts@hotel-a.test's access from active to suspended") && plain(histHtml).includes("accounts@hotel-a.test's access from suspended to active"), plain(histHtml).slice(0, 500));
res = await staff(`/app/settings/history?what=staff&property=${PROPERTY_A}`, OWNER_COOKIE);
histHtml = await res.text();
check("choosing one property leaves hotel-wide staff changes out", res.status === 200 && !plain(histHtml).includes("access from active to suspended"));
res = await staff("/app/settings/history?what=tax", OWNER_COOKIE);
histHtml = await res.text();
check("the tax filter keeps tax rule rows", sees(pageText(histHtml), "E2E VAT"));
res = await staff("/app/settings/history?what=rooms", OWNER_COOKIE);
histHtml = await res.text();
check("the rooms filter leaves them out", res.status === 200 && doesNotSee(pageText(histHtml), "E2E VAT"));
res = await staff("/app/settings/history?what=nonsense&page=-3&property=bad", OWNER_COOKIE);
check("bad filters fall back to the defaults instead of failing", res.status === 200);
res = await staff("/app/settings/history", ACCOUNTANT_COOKIE);
histHtml = await res.text();
check("a login without audit.view sees an explanation and no rows", res.status === 200 && sees(pageText(histHtml), "Only people who may view the audit trail") && doesNotSee(pageText(histHtml), "E2E VAT") && !plain(histHtml).includes("access from"), `status ${res.status}`);

// 12. More staff cases, building on section 11 (its rules "E2E VAT" and "E2E Levy", its edits, and its staff status changes
// are all still there). Covers: what the screens show for each rule state; the edit forms' starting values; compounding
// and order; refusals that must change nothing; a second hotel group that must see and change none of the first's setup
// (rules, history, staff changes); paging through the history; and the audit trail being append-only.
const OWNER_B_ID = "00000000-0000-0000-0000-00000000aa0b", PROPERTY_B = "00000000-0000-0000-0000-0000000000b2", TENANT_A = "00000000-0000-0000-0000-0000000000a1";
const OWNER_B_COOKIE = session(OWNER_B_ID, "bola.owner@hotel-b.test");
const OWNER_JWT = jwt("authenticated", JWT_SECRET, OWNER_ID), ACCOUNTANT_JWT = jwt("authenticated", JWT_SECRET, ACCOUNTANT_ID), OWNER_B_JWT = jwt("authenticated", JWT_SECRET, OWNER_B_ID);
const api = (token, path, init = {}) => fetch(`${REST}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
const SERVICE_JWT = jwt("service_role");

/** formatDate in lib/guest-site/format.ts, so expected words come from the same ICU data as the page's. */
function fmtDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}
const attrOf = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? m[1].replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&") : undefined; };
const isSet = (tag, name) => new RegExp(`\\s${name}(?=[\\s=>/])`).test(tag);
/** What a browser would send for a form if the person pressed the button without typing: inputs, ticked boxes, chosen options. */
function fieldsOf(block = "") {
  const out = new Map();
  for (const m of block.matchAll(/<input\b[^>]*>/g)) {
    const name = attrOf(m[0], "name");
    if (!name) continue;
    const type = (attrOf(m[0], "type") ?? "text").toLowerCase();
    if (type === "checkbox") { if (isSet(m[0], "checked")) out.set(name, attrOf(m[0], "value") ?? "on"); continue; }
    if (type === "submit" || type === "button") continue;
    out.set(name, attrOf(m[0], "value") ?? "");
  }
  for (const m of block.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = attrOf(m[1], "name");
    const options = [...m[2].matchAll(/<option\b([^>]*)>/g)].map((o) => o[1]);
    const chosen = options.find((o) => isSet(` ${o}`, "selected")) ?? options[0];
    if (name) out.set(name, chosen === undefined ? "" : attrOf(chosen, "value") ?? "");
  }
  return out;
}
const formBlocks = (html) => [...html.matchAll(/<form[\s\S]*?<\/form>/g)].map((m) => m[0]);
const ruleBlock = (html, ruleId, marker) => formBlocks(html).find((b) => b.includes(`name="ruleId" value="${ruleId}"`) && b.includes(marker));
const historyRows = (html) => { const ol = /<ol\b[^>]*>([\s\S]*?)<\/ol>/.exec(html); return ol ? ol[1].split('<li class="py-4">').slice(1).map(pageText) : []; };
const everyRule = async () => (await (await api(SERVICE_JWT, `/tax_rules?property_id=eq.${PROPERTY_A}&select=id,name,basis,rate_value,sequence,compounds,effective_from,effective_to,status,applies_to_charges&order=name.asc`)).json());
const taxAuditIds = async (property = PROPERTY_A) => (await (await api(SERVICE_JWT, `/audit_logs?property_id=eq.${property}&action=in.(tax_rule.created,tax_rule.updated,tax_rule.deleted)&select=id&limit=5000`)).json()).map((r) => r.id);
const getPage = async (path, cookie) => { const r = await staff(path, cookie); const html = await r.text(); return { status: r.status, html, text: pageText(html) }; };
const send = (path, cookie, block, fields) => staff(path, cookie, { method: "POST", body: formData(block, fields) });

// -- 12.1 what the tax screen shows for each state, and what the edit forms start with
let t = await getPage("/app/settings/tax", OWNER_COOKIE);
check("a switched-off rule is labelled, and the page explains that its extras mark does nothing while it is off",
  sees(t.text, "E2E VAT 10% Switched off", "Switched on for extras, but it does not tax anything while it is switched off.", "Extras are not taxed.", "No percentage rule in force is switched on for extras."), t.text.slice(0, 500));
check("a rule that starts later is labelled, dated from its first day, and a fixed rule reads as naira a night",
  sees(t.text, "E2E Levy", "1,000.00 a night", "Starts later", `From ${fmtDate("2090-01-01")}`, "Added to each night of a stay. Cannot be applied to extras."), t.text.slice(0, 500));
const vatEdit = ruleBlock(t.html, vatId, 'name="status"'), levyEdit = ruleBlock(t.html, levyId, 'name="status"');
const vatFields = vatEdit ? fieldsOf(vatEdit) : new Map(), levyFields = levyEdit ? fieldsOf(levyEdit) : new Map();
check("the edit form starts with the stored values: name, rate as typed, dates, order, status",
  vatFields.get("name") === "E2E VAT" && vatFields.get("rate") === "10" && vatFields.get("effectiveFrom") === "2090-01-01" && vatFields.get("effectiveTo") === "" && vatFields.get("status") === "inactive"
  && vatFields.get("sequence") === String((await taxRows("E2E VAT"))[0].sequence) && !vatFields.has("compounds"), JSON.stringify([...vatFields]));
check("a fixed rule's edit form shows naira (not kobo) and has no 'on top of' box", levyFields.get("rate") === "1000.00" && !levyFields.has("compounds"), JSON.stringify([...levyFields]));
check("no edit form offers to change the kind of tax", !vatFields.has("basis") && !levyFields.has("basis"));

// -- 12.2 saving without changing anything succeeds and writes nothing
let auditBefore = (await taxAuditIds()).length;
res = await send("/app/settings/tax", OWNER_COOKIE, vatEdit, Object.fromEntries(vatFields));
check("saving the form exactly as it was is accepted", res.status === 303 && outcome(res).get("ok") === "tax_rule_updated", `${res.status} ${res.headers.get("location")}`);
check("and writes no audit row", (await taxAuditIds()).length === auditBefore);

// -- 12.3 compounding, and where a new rule goes in the order
const rulesBeforeAdd = await everyRule();
const addBlockNow = formWith((await getPage("/app/settings/tax", OWNER_COOKIE)).html, 'name="propertyId"');
const baseNew = { propertyId: PROPERTY_A, basis: "percent", rate: "2.5", sequence: "", effectiveFrom: "2090-02-01", effectiveTo: "", compounds: "on" };
res = await send("/app/settings/tax", OWNER_COOKIE, addBlockNow, { ...baseNew, name: "E2E Compound" });
check("a percentage rule applied on top of earlier rules is added", outcome(res).get("ok") === "tax_rule_created", res.headers.get("location") ?? "");
const compound = (await taxRows("E2E Compound"))[0];
check("it is stored as compounding and goes after every existing rule", compound?.compounds === true && Number(compound.rate_value) === 2.5 && compound.sequence === Math.max(...rulesBeforeAdd.map((r) => r.sequence)) + 1, JSON.stringify(compound));
res = await send("/app/settings/tax", OWNER_COOKIE, addBlockNow, { ...baseNew, name: "E2E Last", compounds: null, effectiveFrom: "2090-03-01", effectiveTo: "2090-12-31", sequence: "999" });
check("a rule with an end date and an explicit order is added", outcome(res).get("ok") === "tax_rule_created", res.headers.get("location") ?? "");
const last = (await taxRows("E2E Last"))[0];
check("order 999 and the end date are stored", last?.sequence === 999 && last.effective_to === "2090-12-31" && last.compounds === false, JSON.stringify(last));
t = await getPage("/app/settings/tax", OWNER_COOKIE);
check("the page says when a rule is stacked on earlier ones, and shows a rule's date range",
  sees(t.text, `From ${fmtDate("2090-02-01")}, applied on top of the rules before it`, `${fmtDate("2090-03-01")} to ${fmtDate("2090-12-31")}`), t.text.slice(0, 600));
const at = ["E2E VAT", "E2E Levy", "E2E Compound", "E2E Last"].map((n) => t.text.indexOf(`${n} `));
check("rules are listed in the order they are applied", at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1])), JSON.stringify(at));
check("its edit form has the 'on top of' box ticked", fieldsOf(ruleBlock(t.html, compound.id, 'name="status"')).get("compounds") === "on");

// -- 12.4 refusals change nothing
const rulesSnapshot = JSON.stringify(await everyRule());
auditBefore = (await taxAuditIds()).length;
const freshAdd = formWith(t.html, 'name="propertyId"'), freshEdit = ruleBlock(t.html, vatId, 'name="status"'), freshToggle = formWith(t.html, 'name="apply"');
const refused = [
  ["an order number of 0", () => send("/app/settings/tax", OWNER_COOKIE, freshAdd, { ...baseNew, name: "Zero order", sequence: "0" }), "tax_invalid"],
  ["a name of 61 characters", () => send("/app/settings/tax", OWNER_COOKIE, freshAdd, { ...baseNew, name: "x".repeat(61) }), "tax_invalid"],
  ["a date that is not a real day", () => send("/app/settings/tax", OWNER_COOKIE, freshAdd, { ...baseNew, name: "Bad day", effectiveFrom: "2090-02-30" }), "tax_invalid"],
  ["an edit with the order left blank", () => send("/app/settings/tax", OWNER_COOKIE, freshEdit, { ...Object.fromEntries(fieldsOf(freshEdit)), sequence: "" }), "tax_invalid"],
  ["an edit that would double-tax (same name as a switched-on rule over the same days)", () => send("/app/settings/tax", OWNER_COOKIE, ruleBlock(t.html, levyId, 'name="status"'), { ...Object.fromEntries(fieldsOf(ruleBlock(t.html, levyId, 'name="status"'))), name: "e2e compound" }), "tax_duplicate"],
  ["an edit of a rule that does not exist", () => send("/app/settings/tax", OWNER_COOKIE, freshEdit, { ...Object.fromEntries(fieldsOf(freshEdit)), ruleId: "00000000-0000-0000-0000-00000000dead" }), "tax_not_found"],
  ["an edit with a rule id that is not an id", () => send("/app/settings/tax", OWNER_COOKIE, freshEdit, { ...Object.fromEntries(fieldsOf(freshEdit)), ruleId: "nope" }), "bad_request"],
  ["an add with a property id that is not an id", () => send("/app/settings/tax", OWNER_COOKIE, freshAdd, { ...baseNew, name: "No property", propertyId: "nope" }), "bad_request"],
];
for (const [label, run, want] of refused) {
  const r = await run();
  check(`${label} is refused (${want})`, r.status === 303 && outcome(r).get("err") === want && outcome(r).get("ok") === null, `${r.status} ${r.headers.get("location")}`);
}
check("none of those refusals changed a rule or wrote an audit row", JSON.stringify(await everyRule()) === rulesSnapshot && (await taxAuditIds()).length === auditBefore);
for (const [code, _kind, words_] of [
  ["tax_rule_created", "status", ["Tax rule added.", "does not tax extras until you switch that on"]],
  ["tax_rule_updated", "status", ["Tax rule saved.", "keep the tax they were made with"]],
  ["tax_extras_off", "status", ["no longer taxed with this rule"]],
]) {
  const n = await getPage(`/app/settings/tax?ok=${code}`, OWNER_COOKIE);
  check(`the '${code}' notice is a status message in plain words`, n.html.includes('role="status"') && sees(n.text, ...words_), n.text.slice(0, 300));
}
for (const [code, words_] of [["tax_forbidden", ["You do not have permission to change the hotel's tax rules."]], ["tax_not_percent", ["Only a percentage tax can be applied to extras."]], ["tax_not_found", ["could not be found, or you may not change it"]], ["tax_duplicate", ["would be taxed twice", "end it the day before this one starts"]]]) {
  const n = await getPage(`/app/settings/tax?err=${code}`, OWNER_COOKIE);
  check(`the '${code}' notice is an alert in plain words`, n.html.includes('role="alert"') && sees(n.text, ...words_), n.text.slice(0, 300));
}

// -- 12.5 a second hotel group sees and changes none of the first's setup
const forgedAdd = formWith((await getPage("/app/settings/tax", OWNER_COOKIE)).html, 'name="propertyId"');
const rulesOfA = JSON.stringify(await everyRule()), auditOfA = (await taxAuditIds()).length;
let b = await getPage("/app/settings/tax", OWNER_B_COOKIE);
check("hotel B's owner opens the tax screen and sees none of hotel A's rules", b.status === 200 && sees(b.text, "This hotel has no tax rules") && doesNotSee(b.text, "E2E VAT", "E2E Levy", "E2E Compound", "E2E Last"), b.text.slice(0, 300));
const addB = formWith(b.html, 'name="propertyId"');
check("their add form is for their own property", Boolean(addB) && fieldsOf(addB).get("propertyId") === PROPERTY_B, JSON.stringify([...(addB ? fieldsOf(addB) : [])]));
res = await send("/app/settings/tax", OWNER_B_COOKIE, forgedAdd, { ...baseNew, name: "Cross hotel", propertyId: PROPERTY_A });
check("naming hotel A's property in a hand-made add is refused", outcome(res).get("err") === "tax_forbidden", res.headers.get("location") ?? "");
res = await send("/app/settings/tax", OWNER_B_COOKIE, freshToggle, { ruleId: vatId, apply: "on" });
check("hotel B's owner cannot switch hotel A's rule", outcome(res).get("err") === "tax_not_found", res.headers.get("location") ?? "");
res = await send("/app/settings/tax", OWNER_B_COOKIE, freshEdit, { ...Object.fromEntries(fieldsOf(freshEdit)), rate: "1" });
check("hotel B's owner cannot edit hotel A's rule", outcome(res).get("err") === "tax_not_found", res.headers.get("location") ?? "");
check("hotel A's rules and audit trail are exactly as they were", JSON.stringify(await everyRule()) === rulesOfA && (await taxAuditIds()).length === auditOfA);
check("hotel B's owner reads none of hotel A's rules over the API either", JSON.stringify(await (await api(OWNER_B_JWT, `/tax_rules?property_id=eq.${PROPERTY_A}&select=id`)).json()) === "[]");
res = await send("/app/settings/tax", OWNER_B_COOKIE, addB, { ...baseNew, name: "E2E VAT", rate: "2", compounds: null, propertyId: PROPERTY_B });
check("hotel B can add a rule with the same name, since names only clash within a hotel", outcome(res).get("ok") === "tax_rule_created", res.headers.get("location") ?? "");
b = await getPage("/app/settings/tax", OWNER_B_COOKIE);
check("it shows on their screen at their own rate", sees(b.text, "E2E VAT 2% In force") || sees(b.text, "E2E VAT 2% Starts later"), b.text.slice(0, 300));
check("hotel A's rule of that name keeps its own rate", Number((await taxRows("E2E VAT")).find((r) => r.id === vatId).rate_value) === 10);
let hb = await getPage("/app/settings/history?what=tax", OWNER_B_COOKIE);
check("hotel B's history shows their one change, under their own sign-in, and none of hotel A's",
  historyRows(hb.html).length === 1 && sees(hb.text, `Added the tax rule ${quoted("E2E VAT")}`, "bola.owner@hotel-b.test") && doesNotSee(hb.text, "E2E Levy", "E2E Compound", "Ada Owner"), hb.text.slice(0, 400));
hb = await getPage("/app/settings/history", OWNER_B_COOKIE);
check("hotel B's full history holds only their own setup", sees(hb.text, `Added the room type ${quoted("Standard")}`) && doesNotSee(hb.text, "Solo Suite", "Added room 201", "E2E Levy", "E2E Compound", "ada.owner@hotel-a.test", "accounts@hotel-a.test"), hb.text.slice(0, 400));
hb = await getPage("/app/settings/history?what=staff", OWNER_B_COOKIE);
check("hotel A's suspend and reinstate (migration 030) are not shown to hotel B", sees(hb.text, "Nothing has been recorded for this selection yet.") && historyRows(hb.html).length === 0 && doesNotSee(hb.text, "access from"), hb.text.slice(0, 300));
let ha = await getPage("/app/settings/history?what=tax", OWNER_COOKIE);
check("and hotel B's change is not in hotel A's history", doesNotSee(ha.text, "bola.owner@hotel-b.test"));
const bAudit = await (await api(OWNER_B_JWT, "/audit_logs?select=property_id")).json();
check("over the API hotel B's owner reads audit rows of their own property only", Array.isArray(bAudit) && bAudit.length > 0 && bAudit.every((r) => r.property_id === PROPERTY_B), JSON.stringify(bAudit.slice(0, 3)));
const accountantApi = { rules: await (await api(ACCOUNTANT_JWT, `/tax_rules?property_id=eq.${PROPERTY_A}&select=id`)).json(), audit: await (await api(ACCOUNTANT_JWT, "/audit_logs?select=id")).json() };
check("an accountant reads the rules over the API but not a single audit row", accountantApi.rules.length >= 4 && JSON.stringify(accountantApi.audit) === "[]", JSON.stringify([accountantApi.rules.length, accountantApi.audit.length]));

// -- 12.6 how the history words what happened
ha = await getPage("/app/settings/history?what=tax", OWNER_COOKIE);
let rowsA = historyRows(ha.html);
const rowOf = (needle) => rowsA.find((x) => x.includes(words(needle))) ?? "";
const compoundRow = rowOf(`Added the tax rule ${quoted("E2E Compound")}`);
check("a created rule lists what it started with, in plain words",
  sees(compoundRow, "Kind of tax: A percentage of the night's price", "Rate: 2.5%", "Applied on top of earlier rules: Yes", `First day: ${fmtDate("2090-02-01")}`, "Status: Active", "Taxes extras: No") && !compoundRow.includes("Last day"), compoundRow);
check("a rule's end date appears on its created row", sees(rowOf(`Added the tax rule ${quoted("E2E Last")}`), `Last day: ${fmtDate("2090-12-31")}`, "Order: 999"));
check("a fixed rule reads as naira a night", sees(rowOf(`Added the tax rule ${quoted("E2E Levy")}`), "Kind of tax: A fixed amount each night", "1,000.00 a night"));
check("one edit that changed a rate and a status is one row with both lines", rowsA.some((x) => x.startsWith(`Changed the tax rule ${quoted("E2E VAT")}`) && sees(x, "Rate: 7.5% → 10%", "Status: Active → Switched off")));
check("an edit that changed only the extras mark shows only that line", rowsA.some((x) => x.startsWith(`Changed the tax rule ${quoted("E2E VAT")}`) && sees(x, "Taxes extras: No → Yes") && doesNotSee(x, "Rate:", "Status:")));
check("newest first: the rule added last is above the one added first", ha.text.indexOf(`Added the tax rule ${quoted("E2E Last")}`) < ha.text.indexOf(`Added the tax rule ${quoted("E2E VAT")}`));
check("every row names a person from hotel A (no 'A staff member' fallbacks, no 'The system')", rowsA.length > 0 && rowsA.every((x) => x.includes("Ada Owner")) && doesNotSee(ha.text, "A staff member", "The system"));

// -- 12.7 paging: 52 more rules over the API as the owner, each one written to the audit trail by the trigger
res = await api(OWNER_JWT, "/tax_rules", { method: "POST", headers: { prefer: "return=minimal" }, body: JSON.stringify(Array.from({ length: 52 }, (_, i) => ({
  tenant_id: TENANT_A, property_id: PROPERTY_A, name: `E2E Page ${String(i + 1).padStart(2, "0")}`, basis: "fixed_per_night", rate_value: 100000, sequence: 100 + i, effective_from: "2090-01-01" }))) });
check("fifty-two more rules are added", res.status === 201, `${res.status} ${await res.text()}`);
const totalRows = (await taxAuditIds()).length, PER_PAGE = 50, pages = Math.ceil(totalRows / PER_PAGE);
check("each wrote an audit row, so the history needs more than one page", totalRows >= 52 + 6 && pages >= 2, `${totalRows} rows`);
const seen = [];
for (let n = 1; n <= pages; n++) {
  const pg = await getPage(`/app/settings/history?property=${PROPERTY_A}&what=tax${n > 1 ? `&page=${n}` : ""}`, OWNER_COOKIE);
  const here = historyRows(pg.html), lastPage = n === pages, want = lastPage ? totalRows - PER_PAGE * (pages - 1) : PER_PAGE;
  seen.push(...here);
  check(`page ${n} of ${pages} shows ${want} rows`, pg.status === 200 && here.length === want, `${here.length}`);
  check(`page ${n} links ${n > 1 ? "to newer" : "to no newer"} entries and ${lastPage ? "to no older" : "to older"} ones, and says which page it is`,
    pg.html.includes('rel="prev"') === (n > 1) && pg.html.includes('rel="next"') === !lastPage && sees(pg.text, `Page ${n}`), `${pg.html.includes('rel="prev"')} ${pg.html.includes('rel="next"')}`);
  if (!lastPage) check(`the 'Older' link on page ${n} keeps the property and the filter`, pg.html.includes(`href="/app/settings/history?property=${PROPERTY_A}&amp;what=tax&amp;page=${n + 1}"`), (/href="[^"]*page=[^"]*"/.exec(pg.html) ?? [""])[0]);
}
check("across the pages nothing is shown twice and nothing is skipped", seen.length === totalRows && new Set(seen).size === totalRows, `${seen.length} shown, ${new Set(seen).size} distinct, ${totalRows} written`);
check("the newest rows come first and the oldest row of all is last", seen[0].includes("E2E Page") && seen[seen.length - 1].startsWith(`Added the tax rule ${quoted("E2E VAT")}`), `${seen[0]} | ${seen[seen.length - 1]}`);
const beyond = await getPage(`/app/settings/history?what=tax&page=${pages + 1}`, OWNER_COOKIE);
check("a page beyond the end says there is nothing further back and offers the way back", sees(beyond.text, "There is nothing further back.") && beyond.html.includes('rel="prev"') && !beyond.html.includes('rel="next"'));
check("hotel B's history is still just their one row after all that", historyRows((await getPage("/app/settings/history?what=tax", OWNER_B_COOKIE)).html).length === 1);

// -- 12.8 the audit trail cannot be changed, not even by the owner
const [target] = await (await api(SERVICE_JWT, `/audit_logs?property_id=eq.${PROPERTY_A}&action=eq.tax_rule.created&select=id,action,metadata&limit=1`)).json();
const countBefore = (await taxAuditIds()).length;
const del = await api(OWNER_JWT, `/audit_logs?id=eq.${target.id}`, { method: "DELETE" });
const patch = await api(OWNER_JWT, `/audit_logs?id=eq.${target.id}`, { method: "PATCH", body: JSON.stringify({ action: "tax_rule.deleted", metadata: {} }) });
const [auditAfter] = await (await api(SERVICE_JWT, `/audit_logs?id=eq.${target.id}&select=id,action,metadata`)).json();
check("the owner cannot delete or rewrite an audit row over the API", !del.ok && !patch.ok && auditAfter?.action === "tax_rule.created" && JSON.stringify(auditAfter.metadata) === JSON.stringify(target.metadata) && (await taxAuditIds()).length === countBefore, `${del.status} ${patch.status} ${JSON.stringify(auditAfter)}`);

// 13. Cancellation and payment policies: the staff screen, the audit rows, and the text on the reserve page.
// Versions start in 2090, so no booking made in this run is affected. Policies are never edited, so each save is a new version.
res = await staff("/app/settings/policies", null);
check("the policies page sends a signed-out visitor to sign in", res.status === 307 && (res.headers.get("location") ?? "").includes("/login"), `status ${res.status} ${res.headers.get("location")}`);

res = await staff("/app/settings/policies", OWNER_COOKIE);
let polHtml = await res.text();
check("the owner sees the policies page with the publish form", res.status === 200 && sees(pageText(polHtml), "Cancellation and payment policies", "Publish version 1"), `status ${res.status} ${pageText(polHtml).slice(0, 300)}`);
const polBlock = formWith(polHtml, 'name="effectiveFrom"');
check("the publish form carries a server action and the property", Boolean(polBlock) && /\$ACTION_ID_/.test(polBlock) && polBlock.includes(PROPERTY_A), polBlock?.slice(0, 200));

const polRows = async () => (await (await api(SERVICE_JWT, `/property_policies?property_id=eq.${PROPERTY_A}&select=version,effective_from,config,created_by&order=version`)).json());
const policyFields = { propertyId: PROPERTY_A, effectiveFrom: "2090-01-01", onlineMode: "deposit_percent", depositPercent: "30", checkinPayment: "full",
  rule_hours_0: "168", rule_type_0: "nights", rule_value_0: "1", rule_hours_1: "48", rule_type_1: "percent", rule_value_1: "50", rule_hours_2: "0", rule_type_2: "percent", rule_value_2: "100" };
const publishPolicy = (fields, cookie = OWNER_COOKIE) => staff("/app/settings/policies", cookie, { method: "POST", body: formData(polBlock, { ...policyFields, ...fields }) });
const polBefore = (await polRows()).length;

res = await publishPolicy({});
check("publishing redirects with the success code", res.status === 303 && outcome(res).get("ok") === "policy_published", `status ${res.status} ${res.headers.get("location")}`);
let polAll = await polRows();
const polV1 = polAll[polBefore];
check("the version is stored: its date, the deposit, three rules, the check-in rule and who published it",
  polAll.length === polBefore + 1 && polV1.effective_from === "2090-01-01" && polV1.config.online_payment?.mode === "deposit_percent" && Number(polV1.config.online_payment?.value) === 30
  && polV1.config.cancellation_rules?.length === 3 && polV1.config.cancellation_rules[0].within_hours === 168 && polV1.config.cancellation_rules[0].charge.type === "nights"
  && polV1.config.checkin_payment === "full" && polV1.created_by === OWNER_ID, JSON.stringify(polV1));

const polRefused = [
  ["a repeated window", { rule_hours_3: "48", rule_type_3: "fixed", rule_value_3: "5000" }, "policy_rules"],
  ["a percentage above 100", { rule_value_1: "150" }, "policy_rules"],
  ["a deposit of zero", { depositPercent: "0" }, "policy_deposit"],
  ["a date that is not real", { effectiveFrom: "2090-02-30" }, "policy_date"],
  ["a start date in the past", { effectiveFrom: "2000-01-01" }, "policy_past"],
  ["a start date that is not after the newest version", { effectiveFrom: "2090-01-01" }, "policy_order"],
];
for (const [name, fields, code] of polRefused) {
  res = await publishPolicy({ effectiveFrom: "2090-03-01", ...fields });
  check(`${name} is refused`, res.status === 303 && outcome(res).get("err") === code, `status ${res.status} ${res.headers.get("location")}`);
}
check("none of the refused versions was stored", (await polRows()).length === polBefore + 1);

res = await publishPolicy({ effectiveFrom: "2090-03-01" }, ACCOUNTANT_COOKIE);
check("a login without property.configure cannot publish: the database refuses it", res.status === 303 && outcome(res).get("err") === "policy_forbidden", `status ${res.status} ${res.headers.get("location")}`);
check("and nothing was stored", (await polRows()).length === polBefore + 1);

res = await staff("/app/settings/policies", OWNER_COOKIE);
polHtml = await res.text();
const polText = pageText(polHtml);
check("the page lists the scheduled version and the sentences guests will read",
  sees(polText, `Version ${polV1.version} is scheduled`, "Pay a 30% deposit online to confirm your booking.", "The booking must be fully paid before check-in.", "Within 2 days of check-in, you pay 50% of the total."), polText.slice(0, 400));

// A second version: no rules and full payment. Nothing is edited; the first one stays on record.
res = await publishPolicy({ effectiveFrom: "2090-06-01", onlineMode: "full", checkinPayment: "none", rule_hours_0: "", rule_type_0: "percent", rule_value_0: "", rule_hours_1: "", rule_value_1: "", rule_hours_2: "", rule_value_2: "" });
check("a later version can be published", res.status === 303 && outcome(res).get("ok") === "policy_published", `status ${res.status} ${res.headers.get("location")}`);
polAll = await polRows();
const polV2 = polAll[polBefore + 1];
check("it is the next version with no rules, and the first is unchanged",
  polAll.length === polBefore + 2 && polV2.version === polV1.version + 1 && polV2.config.cancellation_rules?.length === 0 && polV2.config.online_payment?.mode === "full"
  && polAll[polBefore].config.cancellation_rules.length === 3, JSON.stringify(polAll.slice(polBefore)));

const polPatch = await api(OWNER_JWT, `/property_policies?property_id=eq.${PROPERTY_A}&version=eq.${polV1.version}`, { method: "PATCH", body: JSON.stringify({ config: {} }) });
const delPol = await api(OWNER_JWT, `/property_policies?property_id=eq.${PROPERTY_A}&version=eq.${polV1.version}`, { method: "DELETE" });
check("the owner cannot rewrite or delete a version over the API", !polPatch.ok && !delPol.ok && (await polRows())[polBefore].config.cancellation_rules.length === 3);

const polAudit = await (await api(SERVICE_JWT, `/audit_logs?action=eq.property_policy.created&select=actor_user_id,property_id,metadata&order=created_at`)).json();
check("each published version is in the audit log with who made it and its values",
  polAudit.length >= 2 && polAudit.slice(-2).every((a) => a.actor_user_id === OWNER_ID && a.property_id === PROPERTY_A) && Number(polAudit.at(-2).metadata?.values?.version) === polV1.version, JSON.stringify(polAudit.slice(-2)));

res = await staff("/app/settings/history?what=policies", OWNER_COOKIE);
const polHistText = pageText(await res.text());
check("setup history shows the published versions under their own filter", sees(polHistText, `Published policy version ${polV1.version}`, "starting"), polHistText.slice(0, 400));

// The guest side. Versions start in 2090, so the host still gets the defaults today; the function is closed to everyone but the server.
const guestPol = await api(SERVICE_JWT, "/rpc/guest_policy", { method: "POST", body: JSON.stringify({ p_host: HOST }) });
const guestPolBody = await guestPol.json();
check("guest_policy answers the server with only the keys guests need (terms, currency, and whether they may cancel themselves)", guestPol.ok && Object.keys(guestPolBody).sort().join() === "cancellation_rules,checkin_payment,currency,guest_cancellation,online_payment", JSON.stringify(guestPolBody));
const guestPolOwner = await api(OWNER_JWT, "/rpc/guest_policy", { method: "POST", body: JSON.stringify({ p_host: HOST }) });
check("guest_policy is refused to a signed-in person", !guestPolOwner.ok);
res = await site(reserveHref);
const polReserveText = pageText(await res.text());
check("the reserve page shows the payment and cancellation terms in force", res.status === 200 && sees(polReserveText, "Payment and cancellation") && polReserveText.includes("to confirm your booking"), polReserveText.slice(0, 500));
check("and none of the 2090 versions yet", doesNotSee(polReserveText, "Pay a 30% deposit"));

// 14. The room board (migration 039) for people who may see rooms but not bookings, guests or rates. The owner books the
// one Solo Suite for tonight, checks the guest in, and blocks a Standard room; then each login opens /app/rooms.
const HK_ID = "00000000-0000-0000-0000-00000000aa06", GUEST_A = "00000000-0000-0000-0000-0000000000a5", TYPE_SOLO = "00000000-0000-0000-0000-0000000000a4";
const HK_COOKIE = session(HK_ID, "hk@hotel-a.test");
// The hotel's own calendar day (the seed gives Hotel A Africa/Lagos); property_today() is an internal helper that logins cannot call.
const dayOf = async () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
const tonight = await dayOf(), dayAfter = new Date(Date.parse(`${tonight}T00:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10);
const booked = await call("create_reservation", { p_property_id: PROPERTY_A, p_primary_guest_id: GUEST_A, p_source: "staff_entry", p_arrival: tonight, p_departure: dayAfter,
  p_rooms: [{ room_type_id: TYPE_SOLO, requested_room_id: null, adults: 1 }], p_idempotency_key: "e2e-board-booking" }, OWNER_JWT);
check("the owner books the Solo Suite for tonight", booked.status === 200 && Boolean(booked.body?.rooms?.[0]?.reservation_room_id), JSON.stringify(booked));
const boardRr = booked.body?.rooms?.[0]?.reservation_room_id, boardRef = booked.body?.booking_reference;
const checkedIn = await call("check_in", { p_reservation_room_id: boardRr }, OWNER_JWT);
check("and checks the guest in", checkedIn.status === 200, JSON.stringify(checkedIn));
const standard101 = (await (await api(SERVICE_JWT, `/rooms?property_id=eq.${PROPERTY_A}&room_number=eq.101&select=id`)).json())[0]?.id;
const blocked = await call("create_room_block", { p_room_id: standard101, p_start: tonight, p_end: dayAfter, p_reason: "E2E leak in the ceiling", p_resolution: "fail", p_idempotency_key: "e2e-board-block" }, OWNER_JWT);
check("and blocks Standard room 101", blocked.status === 200, JSON.stringify(blocked));

const hkBoard = await getPage("/app/rooms", HK_COOKIE);
const card = (text, number) => { const i = text.indexOf(` ${number} `); return i < 0 ? "" : text.slice(i, i + 160); };
check("housekeeping opens the board", hkBoard.status === 200 && sees(hkBoard.text, "Rooms", "What every room is doing today."), `${hkBoard.status} ${hkBoard.text.slice(0, 200)}`);
check("housekeeping sees rooms grouped under their type's name", sees(hkBoard.text, "Standard (5)", "Solo Suite (1)"), hkBoard.text.slice(0, 600));
check("housekeeping sees the checked-in room as occupied, not merely booked", sees(card(hkBoard.text, "201"), "Occupied") && !card(hkBoard.text, "201").includes("Booked tonight"), card(hkBoard.text, "201"));
check("and the block, with its reason", sees(card(hkBoard.text, "101"), "Blocked", "E2E leak in the ceiling"), card(hkBoard.text, "101"));
check("the totals count one occupied and one blocked room", sees(hkBoard.text, "1 occupied", "1 blocked"), hkBoard.text.slice(0, 500));
check("housekeeping is shown no booking reference, guest name or booking link", doesNotSee(hkBoard.text, boardRef ?? "BK-", "Ada Okafor") && !hkBoard.html.includes(`/app/reservations/`), hkBoard.text.slice(0, 400));
check("nor any price", !/₦\s?\d/.test(hkBoard.text) && !hkBoard.html.includes("9000000") && !hkBoard.html.includes("2500000"));

const ownerBoard = await getPage("/app/rooms", OWNER_COOKIE);
check("the owner sees the same states, and the booking with its guest", sees(card(ownerBoard.text, "201"), "Occupied", "Ada Okafor") && sees(ownerBoard.text, "Solo Suite (1)", "1 occupied", "1 blocked"), card(ownerBoard.text, "201"));
check("and the booking links to its page", ownerBoard.html.includes(`/app/reservations/`) && (boardRef ? ownerBoard.text.includes(boardRef) : true), boardRef);

const accountantBoard = await getPage("/app/rooms", ACCOUNTANT_COOKIE);
check("an accountant, who may not see rooms, gets an empty board", accountantBoard.status === 200 && sees(accountantBoard.text, "No rooms to show.") && doesNotSee(accountantBoard.text, "Solo Suite", "Occupied"), accountantBoard.text.slice(0, 300));
const HK_JWT = jwt("authenticated", JWT_SECRET, HK_ID);
const hkApi = { board: await api(HK_JWT, "/room_board_view?select=room_number,room_type_name"), types: await api(HK_JWT, "/room_types?select=id") };
check("over the API housekeeping reads the board view but still no room types table", (await hkApi.board.json()).length >= 6 && JSON.stringify(await hkApi.types.json()) === "[]");
const anonView = await fetch(`${REST}/room_board_view?select=id`, { headers: { authorization: `Bearer ${jwt("anon")}` } });
check("anon cannot read the board view", anonView.status === 401 || anonView.status === 403, `${anonView.status}`);

// 15. The occupancy report (migration 040), straight after section 14 (the owner's booking for tonight and the block on room 101 are still there).
const occPath = `/app/reports/occupancy?from=${tonight}&to=${dayAfter}`;
const occOwner = await getPage(occPath, OWNER_COOKIE);
check("the owner sees the occupancy report with its totals and the rule that future days are booked so far", occOwner.status === 200 && sees(occOwner.text, "Occupancy", "ADR", "RevPAR", "Room revenue", "room nights", "Download as CSV", fmtDate(tonight)), occOwner.text.slice(0, 200));
check("it counts the booked night and the blocked room", /Blocked/.test(occOwner.text) && occOwner.html.includes("tabular-nums"));
const occAccountant = await getPage(occPath, ACCOUNTANT_COOKIE);
check("an accountant may read it, and the page stays readable", occAccountant.status === 200 && sees(occAccountant.text, "Occupancy", "RevPAR"));
const occHk = await getPage(occPath, HK_COOKIE);
check("housekeeping is told it has no permission, with no figures", occHk.status === 200 && sees(occHk.text, "You do not have permission to see reports.") && doesNotSee(occHk.text, "RevPAR", "ADR"));
const occBad = await getPage("/app/reports/occupancy?from=2026-13-45&to=nonsense", OWNER_COOKIE);
check("unreadable dates fall back to the default range with a note", occBad.status === 200 && sees(occBad.text, "That date range was not usable"));
const occCsv = await staff(`/app/reports/occupancy/csv?${new URLSearchParams({ property: PROPERTY_A, from: tonight, to: dayAfter })}`, OWNER_COOKIE);
const occCsvText = await occCsv.text();
check("the owner downloads it as CSV with a header, a row per day and a total", occCsv.status === 200 && (occCsv.headers.get("content-type") ?? "").startsWith("text/csv") && occCsvText.includes("Date,Rooms in service,Blocked,Available,Sold,Occupancy %") && occCsvText.includes(`${tonight},`) && /Total,/.test(occCsvText) && (occCsv.headers.get("content-disposition") ?? "").includes("occupancy-"), `${occCsv.status} ${occCsvText.slice(0, 120)}`);
const occCsvHk = await staff(`/app/reports/occupancy/csv?${new URLSearchParams({ property: PROPERTY_A, from: tonight, to: dayAfter })}`, HK_COOKIE);
check("housekeeping cannot download it", occCsvHk.status === 404, `${occCsvHk.status}`);
const occCsvAnon = await staff(`/app/reports/occupancy/csv?property=${PROPERTY_A}`, null);
check("nobody signed in cannot download it", [307, 401].includes(occCsvAnon.status), `${occCsvAnon.status}`);
const occRpcAnon = await rpc("occupancy_report", { p_property_id: PROPERTY_A, p_from: tonight, p_to: tonight }, jwt("anon"));
check("anon cannot call the report function", occRpcAnon.status === 401 || occRpcAnon.status === 403, `${occRpcAnon.status}`);
const occRpcB = await rpc("occupancy_report", { p_property_id: PROPERTY_A, p_from: tonight, p_to: tonight }, OWNER_B_JWT);
check("hotel B's owner cannot read hotel A's occupancy", occRpcB.status >= 400, `${occRpcB.status}`);

// 14. A refund Paystack cannot finish without the customer's bank details: payout through the real route, the
// needs-attention event, the bank list, the retry with the bank and account, and the event that completes it.
// The fake Paystack behaves like the documented endpoints (cursor-paged /bank, a retry that answers 422 unless the refund
// is in needs-attention), so this checks our side of that contract, not Paystack's real responses: confirm those in TEST mode.
const postJson = (path, cookie, body) => staff(path, cookie, { method: "POST", headers: { origin: SITE, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ACCOUNT_NUMBER = "0123456789";

// A second booking, paid through the fake checkout and confirmed by the signed webhook, then cancelled and approved
res = await site(reserveHref);
html = await res.text();
form = new FormData();
for (const [k, v] of hiddenInputs(html, "<form")) form.append(k, v);
form.set("quantity", "1"); form.set("full_name", "Bea Okoro"); form.set("email", "bea.e2e@example.com"); form.set("phone", "+2348000000001");
res = await site(reserveHref, { method: "POST", body: form });
const booking2Path = res.headers.get("location") ?? "";
check("a second booking is held", res.status === 303 && /^\/booking\/[\w-]+\.[\w-]+$/.test(booking2Path), `status ${res.status} location ${booking2Path}`);
res = await site(booking2Path);
html = await res.text();
form = new FormData();
for (const [k, v] of hiddenInputs(html, "<form")) form.append(k, v);
res = await site(booking2Path, { method: "POST", body: form });
const attempt2 = decodeURIComponent((res.headers.get("location") ?? "").split("/checkout/")[1] ?? "");
const tx2 = await (await fetch(`${FAKE}/_state/${encodeURIComponent(attempt2)}`)).json();
const charge2 = JSON.stringify({ event: "charge.success", data: { id: tx2.id, reference: attempt2, amount: 1, currency: "USD" } });
res = await hook(charge2, sign(charge2));
out = await res.json();
check("the second booking is paid and confirmed by the signed webhook", res.status === 200 && out.result === "confirmed", JSON.stringify(out));
const reservation2 = JSON.parse(Buffer.from(booking2Path.split("/").pop().split(".")[0], "base64url").toString()).r;
c = await call("cancel_reservation", { p_reservation_id: reservation2, p_reason: "bank details e2e", p_idempotency_key: "e2e-cancel-bank" }, OWNER);
check("the owner cancels it", c.status === 200 && c.body?.status === "cancelled", JSON.stringify(c));
const refundRow = async () => (await (await api(SERVICE_JWT, `/refunds?reservation_id=eq.${reservation2}&select=id,refund_status,amount_minor,needs_bank_details,provider_refund_id,details_retry_started_at`)).json())[0];
let r2 = await refundRow();
check("a refund for everything paid was requested", r2?.refund_status === "requested" && r2.amount_minor === 5000000, JSON.stringify(r2));
c = await call("approve_refund", { p_refund_id: r2.id, p_approve: true, p_note: null, p_idempotency_key: "e2e-approve-bank" }, ACCOUNTANT);
check("the accountant approves it", c.status === 200, JSON.stringify(c));

// Pay out through the real route: our app calls the fake POST /refund
res = await postJson(`/api/staff/refunds/${r2.id}/payout`, HK_COOKIE);
check("a login without refund rights cannot start the payout", res.status === 404, `status ${res.status}`);
res = await postJson(`/api/staff/refunds/${r2.id}/payout`, OWNER_B_COOKIE);
check("another hotel's owner cannot start it either", res.status === 404, `status ${res.status}`);
res = await postJson(`/api/staff/refunds/${r2.id}/payout`, OWNER_COOKIE);
let pay = await res.json();
check("the payout is sent to Paystack and comes back submitted (pending)", res.status === 200 && pay.status === "submitted" && pay.providerStatus === "pending", JSON.stringify(pay));
const fakeRefund = await (await fetch(`${FAKE}/_refund/by-tx/${encodeURIComponent(attempt2)}`)).json();
check("Paystack was asked to refund our transaction reference, the full amount in kobo, once",
  fakeRefund.transaction === attempt2 && fakeRefund.amount === 5000000 && fakeRefund.currency === "NGN" && String(fakeRefund.merchant_note).startsWith("Refund "), JSON.stringify(fakeRefund));
r2 = await refundRow();
check("the refund is processing and does not yet ask for bank details", r2.refund_status === "processing" && r2.needs_bank_details === false, JSON.stringify(r2));

// The banks route needs an open bank-details retry
res = await staff(`/api/staff/refunds/${r2.id}/banks`, OWNER_COOKIE);
check("the bank list is refused while Paystack has not asked for details", res.status === 409, `status ${res.status}`);

// Paystack says it needs the customer's bank details
const attention = { id: fakeRefund.id, status: "needs-attention", transaction_reference: attempt2, amount: "5000000", currency: "NGN" };
res = await refundHook({ ...attention, amount: "4999999" }, "refund.needs-attention");
out = await res.json();
check("a needs-attention event for the wrong amount matches nothing", out.result === "ignored_no_match", JSON.stringify(out));
res = await refundHook(attention, "refund.needs-attention");
out = await res.json();
check("the needs-attention event opens the bank-details retry", res.status === 200 && out.result === "noted_attention", JSON.stringify(out));
r2 = await refundRow();
check("the refund asks for bank details and keeps Paystack's own refund id", r2.needs_bank_details === true && r2.provider_refund_id === String(fakeRefund.id) && r2.refund_status === "processing", JSON.stringify(r2));

res = await staff(`/api/staff/refunds/${r2.id}/banks`, HK_COOKIE);
check("a login without refund rights cannot read the bank list", res.status === 404, `status ${res.status}`);
res = await staff(`/api/staff/refunds/${r2.id}/banks`, OWNER_B_COOKIE);
check("another hotel's owner cannot read it either", res.status === 404, `status ${res.status}`);
res = await staff(`/api/staff/refunds/${r2.id}/banks`, null);
check("nor can someone signed out", res.status === 401, `status ${res.status}`);
res = await staff(`/api/staff/refunds/${r2.id}/banks`, OWNER_COOKIE);
const bankList = await res.json();
check("the bank list follows Paystack's cursor to the second page, with ids as text, sorted by name",
  res.status === 200 && bankList.currency === "NGN" && JSON.stringify(bankList.banks) === JSON.stringify([{ id: "301", name: "Access Bank" }, { id: "302", name: "Guaranty Trust Bank" }, { id: "303", name: "Zenith Bank" }]), JSON.stringify(bankList));
const bankQueries = await (await fetch(`${FAKE}/_banks`)).json();
check("it asked for Nigerian naira banks with cursor paging", bankQueries.length === 2 && bankQueries[0].currency === "NGN" && bankQueries[0].country === "nigeria" && bankQueries[0].use_cursor === "true" && bankQueries[0].perPage === "100" && bankQueries[1].next === "cur2", JSON.stringify(bankQueries));

// Details: typos are refused before the one-shot guard is used
res = await postJson(`/api/staff/refunds/${r2.id}/details`, OWNER_COOKIE, { bankId: "302", accountNumber: "12345" });
check("an account number of the wrong length is refused", res.status === 400 && (await res.json()).error === "account_invalid", `status ${res.status}`);
res = await postJson(`/api/staff/refunds/${r2.id}/details`, OWNER_COOKIE, { accountNumber: ACCOUNT_NUMBER });
check("a missing bank is refused", res.status === 400, `status ${res.status}`);
res = await postJson(`/api/staff/refunds/${r2.id}/details`, HK_COOKIE, { bankId: "302", accountNumber: ACCOUNT_NUMBER });
check("a login without refund rights cannot send details", res.status >= 400 && res.status < 500, `status ${res.status}`);
check("none of that reached Paystack or used the attempt", (await (await fetch(`${FAKE}/_refund/${fakeRefund.id}`)).json()).retries === 0 && (await refundRow()).details_retry_started_at === null);

// Paystack answers 422 unless it has just sent needs-attention: a definite refusal frees the attempt
await fetch(`${FAKE}/_refund/${fakeRefund.id}/state`, { method: "POST", body: JSON.stringify({ state: "pending" }) });
res = await postJson(`/api/staff/refunds/${r2.id}/details`, OWNER_COOKIE, { bankId: "302", accountNumber: ACCOUNT_NUMBER });
let det = await res.json();
check("Paystack's 422 comes back as a refusal with its reason", res.status === 422 && det.status === "rejected" && /needs-attention/.test(det.reason ?? ""), `status ${res.status} ${JSON.stringify(det)}`);
r2 = await refundRow();
check("the refusal freed the attempt and the refund still waits for details", r2.details_retry_started_at === null && r2.needs_bank_details === true, JSON.stringify(r2));

// Now Paystack is ready: the same details go through, once
await fetch(`${FAKE}/_refund/${fakeRefund.id}/state`, { method: "POST", body: JSON.stringify({ state: "needs-attention" }) });
res = await postJson(`/api/staff/refunds/${r2.id}/details`, OWNER_COOKIE, { bankId: "302", accountNumber: "0123 456-789" });
det = await res.json();
check("the details are accepted by Paystack", res.status === 200 && det.status === "submitted", `status ${res.status} ${JSON.stringify(det)}`);
const afterRetry = await (await fetch(`${FAKE}/_refund/${fakeRefund.id}`)).json();
check("Paystack received the currency, the bank id and the account number with spaces and dashes removed, exactly once",
  afterRetry.retries === 1 && afterRetry.state === "processing" && JSON.stringify(afterRetry.details) === JSON.stringify({ currency: "NGN", account_number: ACCOUNT_NUMBER, bank_id: "302" }), JSON.stringify(afterRetry));
r2 = await refundRow();
check("once Paystack accepted the details the refund stops asking for them", r2.refund_status === "processing" && r2.needs_bank_details === false, JSON.stringify(r2));
res = await postJson(`/api/staff/refunds/${r2.id}/details`, OWNER_COOKIE, { bankId: "302", accountNumber: ACCOUNT_NUMBER });
det = await res.json();
check("sending them again is refused and does not reach Paystack", res.status === 409 && /INVALID_STATE/.test(det.error ?? "") && (await (await fetch(`${FAKE}/_refund/${fakeRefund.id}`)).json()).retries === 1, `status ${res.status} ${JSON.stringify(det)}`);

// Paystack finishes the refund
const processed = { id: fakeRefund.id, status: "processed", transaction_reference: attempt2, refund_reference: "rf_e2e_bank", amount: "5000000", currency: "NGN" };
res = await refundHook(processed, "refund.processed");
out = await res.json();
check("refund.processed completes the refund", res.status === 200 && out.result === "succeeded", JSON.stringify(out));
r2 = await refundRow();
check("the refund is done and no longer asks for bank details", r2.refund_status === "succeeded" && r2.needs_bank_details === false, JSON.stringify(r2));
const refundMail2 = await waitForEmail((m) => m.to[0] === "bea.e2e@example.com" && m.subject.startsWith("Refund processed"));
check("the guest got the refund email", !!refundMail2 && refundMail2.text.includes("50,000.00"), JSON.stringify(refundMail2)?.slice(0, 200));

// The customer's bank and account number are only ever passed to Paystack
const refundFull = JSON.stringify(await (await api(SERVICE_JWT, `/refunds?id=eq.${r2.id}&select=*`)).json());
const refundAudit = JSON.stringify(await (await api(SERVICE_JWT, `/audit_logs?entity_id=eq.${r2.id}&select=*`)).json());
check("the account number is nowhere in the refund row or its audit trail", !refundFull.includes(ACCOUNT_NUMBER) && !refundAudit.includes(ACCOUNT_NUMBER) && !refundAudit.includes("0123"), "found in a stored row");
check("the audit trail records the needs-details outcome without the details", refundAudit.includes("refund.needs_bank_details"));

console.log(failures === 0 ? `E2E PASSED (${reference})` : `E2E FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
