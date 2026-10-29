// End-to-end guest flow against the real app, real PostgREST, real Postgres and a fake Paystack.
import { createHmac } from "node:crypto";

const SITE = process.env.SITE_URL ?? "http://127.0.0.1:3100";
const FAKE = process.env.FAKE_PAYSTACK_URL ?? "http://127.0.0.1:4010";
const REST = process.env.POSTGREST_URL ?? "http://127.0.0.1:3001";
const HOST = "book.hotel-a.test";
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

function jwt(role, secret = JWT_SECRET) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b({ alg: "HS256", typ: "JWT" }), body = b({ role, iss: "e2e", exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}
const rpc = (fn, args, token) => fetch(`${REST}/rpc/${fn}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(args) });

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
