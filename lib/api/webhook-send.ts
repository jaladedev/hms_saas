import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

/**
 * Outgoing webhooks. The body is signed with the endpoint's secret: header `Hms-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<body>">`.
 * A receiver rebuilds that, compares in constant time, and rejects a timestamp older than a few minutes.
 */
export function signWebhook(secret: string, body: string, timestamp: number): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

/** For tests and for anyone checking our own format: true when the header matches the body and is no older than `toleranceSeconds`. */
export function verifyWebhook(secret: string, body: string, header: string, nowSeconds: number, toleranceSeconds = 300): boolean {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = Buffer.from(signWebhook(secret, body, t).split("v1=")[1]!, "hex");
  const given = Buffer.from(m[2]!, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Addresses a webhook must never be sent to: this machine, private networks and link-local ranges, by literal address or obvious name. */
function isPrivateAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    (!h.includes(".") && isIP(h) === 0)
  )
    return true;
  const kind = isIP(h);
  if (kind === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (kind === 6)
    return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:");
  return false;
}

/** https only, on the standard port, never a private or local address. (A name that later resolves to a private address is stopped at send time by the same check on the answer's host.) */
export function isSafeWebhookUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    (u.port === "" || u.port === "443") &&
    u.username === "" &&
    u.password === "" &&
    !isPrivateAddress(u.hostname)
  );
}

export type Delivery = { id: string; url: string; secret: string; event: string; payload: unknown; attempts: number };
export type SendOutcome = { ok: boolean; code: number | null; error: string | null };

/** One attempt. Never follows redirects (a redirect could point inside the network), gives up after 8 seconds, and never throws. */
export async function sendWebhook(
  d: Delivery,
  fetchImpl: typeof fetch = fetch,
  now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<SendOutcome> {
  if (!isSafeWebhookUrl(d.url)) return { ok: false, code: null, error: "address not allowed" };
  const body = JSON.stringify(d.payload);
  try {
    const res = await fetchImpl(d.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: {
        "content-type": "application/json",
        "user-agent": "hms-webhooks/1",
        "hms-event": d.event,
        "hms-delivery": d.id,
        "hms-signature": signWebhook(d.secret, body, now()),
      },
      body,
    });
    const ok = res.status >= 200 && res.status < 300;
    return { ok, code: res.status, error: ok ? null : `answered ${res.status}` };
  } catch (e) {
    return {
      ok: false,
      code: null,
      error: e instanceof Error ? (e.name === "TimeoutError" ? "timed out" : "could not connect") : "failed",
    };
  }
}

export type WebhookDb = {
  claim(limit: number): Promise<Delivery[]>;
  mark(id: string, outcome: SendOutcome): Promise<void>;
};

/** Claims due deliveries, sends each, records the result. Returns counts. */
export async function drainWebhooks(
  db: WebhookDb,
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ claimed: number; sent: number; failed: number }> {
  const rows = await db.claim(limit);
  let sent = 0;
  let failed = 0;
  for (const d of rows) {
    const out = await sendWebhook(d, fetchImpl);
    await db.mark(d.id, out);
    if (out.ok) sent++;
    else failed++;
  }
  return { claimed: rows.length, sent, failed };
}
