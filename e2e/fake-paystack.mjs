// A minimal fake of the Paystack endpoints the app uses, for the end-to-end test only.
import http from "node:http";

const SECRET = process.env.PAYSTACK_SECRET_E2E;
const port = Number(process.env.FAKE_PAYSTACK_PORT ?? 4010);
const transactions = new Map(); // reference -> { init, id }
let nextId = 4_000_000_001;

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
  send(res, 404, { status: false });
}).listen(port, "127.0.0.1", () => console.log(`fake paystack on ${port}`));
