// A minimal fake of Resend's POST /emails for the end-to-end test. Like Resend, it treats a repeated
// Idempotency-Key as the same email and does not deliver it twice.
import http from "node:http";

const KEY = process.env.RESEND_API_KEY_E2E;
const port = Number(process.env.FAKE_RESEND_PORT ?? 4011);
const sent = [];
const byKey = new Map();

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

  if (req.method === "GET" && req.url === "/_sent") return send(200, sent);
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { name: "missing_api_key", message: "bad key" });
  if (req.method === "POST" && req.url === "/emails") {
    const idem = req.headers["idempotency-key"];
    if (!idem) return send(400, { name: "validation_error", message: "idempotency key required by this fake" });
    if (byKey.has(idem)) return send(200, { id: byKey.get(idem) });
    const body = JSON.parse(raw);
    const id = `em_${sent.length + 1}`;
    byKey.set(idem, id);
    sent.push({ id, idem, to: body.to, from: body.from, subject: body.subject, text: body.text, html: body.html });
    return send(200, { id });
  }
  send(404, { message: "not found" });
}).listen(port, "127.0.0.1", () => console.log(`fake resend on ${port}`));
