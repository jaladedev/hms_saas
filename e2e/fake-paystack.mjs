// A minimal fake of the Paystack endpoints the app uses, for the end-to-end test only.
import http from "node:http";

const SECRET = process.env.PAYSTACK_SECRET_E2E;
const port = Number(process.env.FAKE_PAYSTACK_PORT ?? 4010);
const transactions = new Map(); // reference -> { init, id }
let nextId = 4_000_000_001;
// Refunds: id -> { id, transaction, amount, currency, merchant_note, state, retries, details }. The state starts as
// "pending"; the test moves it (POST /_refund/<id>/state) the way Paystack's own events would. Like the real
// retry_with_customer_details endpoint, the retry is refused with 422 unless the refund is in "needs-attention".
const refunds = new Map();
let nextRefundId = 5_000_000_001;
// The bank list in three rows over two cursor pages, deliberately out of name order, ids as numbers (as Paystack sends them).
const BANKS = [
  [{ id: 303, name: "Zenith Bank", slug: "zenith-bank", code: "057", currency: "NGN", country: "Nigeria" }, { id: 301, name: "Access Bank", slug: "access-bank", code: "044", currency: "NGN", country: "Nigeria" }],
  [{ id: 302, name: "Guaranty Trust Bank", slug: "guaranty-trust-bank", code: "058", currency: "NGN", country: "Nigeria" }],
];
const bankQueries = [];

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");

  if (url.pathname.startsWith("/_state/")) {
    const t = transactions.get(decodeURIComponent(url.pathname.slice(8)));
    return t ? send(res, 200, t) : send(res, 404, { error: "none" });
  }
  if (url.pathname === "/_banks") return send(res, 200, bankQueries);
  if (url.pathname.startsWith("/_refund/")) {
    const rest = decodeURIComponent(url.pathname.slice("/_refund/".length));
    if (rest.startsWith("by-tx/")) {
      const tx = rest.slice(6);
      const r = [...refunds.values()].find((x) => x.transaction === tx);
      return r ? send(res, 200, r) : send(res, 404, { error: "none" });
    }
    const [id, action] = rest.split("/");
    const r = refunds.get(Number(id));
    if (!r) return send(res, 404, { error: "none" });
    if (req.method === "POST" && action === "state") { r.state = JSON.parse(raw).state; return send(res, 200, r); }
    return send(res, 200, r);
  }
  if (req.headers.authorization !== `Bearer ${SECRET}`) return send(res, 401, { status: false, message: "Invalid key" });

  if (req.method === "POST" && url.pathname === "/transaction/initialize") {
    const init = JSON.parse(raw);
    if (transactions.has(init.reference)) return send(res, 400, { status: false, message: "Duplicate Transaction Reference" });
    transactions.set(init.reference, { init, id: nextId++ });
    return send(res, 200, { status: true, message: "Authorization URL created",
      data: { authorization_url: `http://127.0.0.1:${port}/checkout/${encodeURIComponent(init.reference)}`, access_code: "ac_test", reference: init.reference } });
  }
  if (req.method === "GET" && url.pathname.startsWith("/transaction/verify/")) {
    const ref = decodeURIComponent(url.pathname.slice("/transaction/verify/".length));
    const t = transactions.get(ref);
    if (!t) return send(res, 404, { status: false, message: "Transaction reference not found" });
    return send(res, 200, { status: true, message: "Verification successful",
      data: { id: t.id, status: "success", reference: ref, amount: t.init.amount, currency: t.init.currency, channel: "card" } });
  }
  if (req.method === "POST" && url.pathname === "/refund") {
    const body = JSON.parse(raw);
    const tx = transactions.get(body.transaction);
    if (!tx) return send(res, 404, { status: false, message: "Transaction reference not found" });
    if (!Number.isInteger(body.amount) || body.amount < 1) return send(res, 400, { status: false, message: "Invalid amount" });
    const id = nextRefundId++;
    refunds.set(id, { id, transaction: body.transaction, amount: body.amount, currency: body.currency, merchant_note: body.merchant_note, state: "pending", retries: 0, details: null });
    return send(res, 200, { status: true, message: "Refund has been queued for processing",
      data: { id, status: "pending", transaction: { reference: body.transaction }, amount: body.amount, currency: body.currency } });
  }
  if (req.method === "GET" && url.pathname === "/bank") {
    const q = Object.fromEntries(url.searchParams);
    bankQueries.push(q);
    if (!q.currency) return send(res, 400, { status: false, message: "Currency is required" });
    const page = q.next === "cur2" ? 1 : 0;
    return send(res, 200, { status: true, message: "Banks retrieved", data: BANKS[page], meta: { next: page === 0 ? "cur2" : null, previous: null, perPage: 100 } });
  }
  const retry = /^\/refund\/retry_with_customer_details\/(\d+)$/.exec(url.pathname);
  if (req.method === "POST" && retry) {
    const r = refunds.get(Number(retry[1]));
    if (!r) return send(res, 404, { status: false, message: "Refund not found" });
    if (r.state !== "needs-attention") return send(res, 422, { status: false, message: "Refund is not in needs-attention state" });
    const d = JSON.parse(raw).refund_account_details ?? {};
    const bankIds = BANKS.flat().map((b) => String(b.id));
    if (d.currency !== r.currency || !/^\d{10}$/.test(String(d.account_number ?? "")) || !bankIds.includes(String(d.bank_id))) {
      return send(res, 400, { status: false, message: "Invalid refund account details" });
    }
    r.retries += 1; r.details = d; r.state = "processing";
    return send(res, 200, { status: true, message: "Refund retry has been queued for processing", data: { id: r.id, status: "processing" } });
  }
  send(res, 404, { status: false });
}).listen(port, "127.0.0.1", () => console.log(`fake paystack on ${port}`));
