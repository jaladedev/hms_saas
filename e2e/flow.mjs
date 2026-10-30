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
check("search page renders room types from the database", res.status === 200 && html.includes("Standard") && html.includes("Solo Suite") && html.includes("50,000.00"), `status ${res.status}`);
const reserveHref = decode(/href="(\/reserve\?[^"]*type=[^"]*)"/.exec(html)?.[1] ?? "");
check("search page links to the reserve page", reserveHref.startsWith("/reserve?"), html.slice(0, 300));

// 2. A host the system does not know gets a polite message, not data
res = await fetch(`${SITE}/?arrival=${arrival}&departure=${departure}`, { headers: { "x-forwarded-host": "nobody.example" }, redirect: "manual" });
html = await res.text();
check("unknown host shows the not-configured message", html.includes("not available on this site yet"));

// 3. Reserve page, then submit the real server-action form
res = await site(reserveHref);
html = await res.text();
check("reserve page renders the quote and form", res.status === 200 && html.includes("Hold my room") && html.includes("Your reservation"), `status ${res.status}`);
let form = new FormData();
for (const [k, v] of hiddenInputs(html, "<form")) form.append(k, v);
form.set("quantity", "1"); form.set("full_name", "Ada Obi"); form.set("email", "ada.e2e@example.com"); form.set("phone", "+2348000000000");
res = await site(reserveHref, { method: "POST", body: form });
const bookingPath = res.headers.get("location") ?? "";
check("reserve action creates a hold and redirects to the booking page", res.status === 303 && /^\/booking\/[\w-]+\.[\w-]+$/.test(bookingPath), `status ${res.status} location ${bookingPath}`);

// 4. Booking page shows a live hold and a pay button
res = await site(bookingPath);
html = await res.text();
check("booking page shows reference, hold and pay button", res.status === 200 && /BK-[A-Z0-9-]+/.test(html) && html.includes("Pay now") && html.includes("Still to pay"));
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
check("callback page says payment is being confirmed", html.includes("confirming your payment") && html.includes('http-equiv="refresh"'));

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
check("booking page shows confirmed and paid", html.includes("Your booking is confirmed") && !html.includes("Pay now"), "");

// 9b. Emails: held (sent right after the reserve action) and confirmed (after the webhook), with working links
const heldMail = await waitForEmail((m) => m.to[0] === "ada.e2e@example.com" && m.subject.includes("Complete your booking") && m.subject.includes(reference));
check("hold email was sent to the guest with the booking reference", heldMail !== null, JSON.stringify((await emails()).map((m) => m.subject)));
const heldPath = heldMail ? linkIn(heldMail) : undefined;
check("the emailed link opens the booking", !!heldPath && (await (await site(heldPath)).text()).includes(reference), String(heldPath));
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
check("matching link request emails a fresh working link", !!linkMail && !!linkIn(linkMail) && (await (await site(linkIn(linkMail))).text()).includes(reference));
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
check("the limit message is friendly", html.includes("Too many attempts"));

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
check("other addresses are not affected by that limit", res.status === 200 && html.includes("Find a room") && !html.includes("Too many attempts"));
res = await site(`/?arrival=${arrival}&departure=${departure}&adults=2&children=0`, { headers: { "x-forwarded-for": "198.51.100.77" } });
check("the limited address still browses (search has its own, larger limit)", res.status === 200 && !(await res.text()).includes("Too many attempts"));

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

console.log(failures === 0 ? `E2E PASSED (${reference})` : `E2E FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
