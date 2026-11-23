/**
 * Error reporting without a vendor SDK. Builds the small JSON event that Sentry's HTTP "envelope" endpoint accepts (so it also works
 * with GlitchTip and Bugsink), from an error and a little context. Pure functions only, so every rule can be tested; the part that
 * sends is in report.ts and does nothing unless ERROR_REPORT_DSN is set.
 *
 * What is sent, and what is never sent:
 *   sent:  the error's name and message (scrubbed), its stack, the route PATTERN (/app/guests/[id], not the address with the id), the
 *          method, what kind of request it was (page, route, action), the deploy (release) and the environment, and Next's digest so
 *          the report can be matched to the server log line.
 *   never: cookies, headers, request or form bodies, the query string, the signed-in person, IP addresses, or any value read from the
 *          database. Emails, long digit runs (cards, phones, account numbers) and uuids in the message are replaced before sending.
 */

export type Dsn = { publicKey: string; host: string; projectId: string; protocol: string; envelopeUrl: string };

/** Reads `https://<key>@<host>/<project>` (optionally with a path prefix). Returns null for anything else, so a bad value turns reporting off. */
export function parseDsn(raw: string | undefined | null): Dsn | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const publicKey = decodeURIComponent(u.username);
  const parts = u.pathname.split("/").filter(Boolean);
  const projectId = parts.pop();
  if (!publicKey || !projectId || !/^\d+$/.test(projectId)) return null;
  const prefix = parts.length ? `/${parts.join("/")}` : "";
  return {
    publicKey,
    host: u.host,
    projectId,
    protocol: u.protocol.replace(":", ""),
    envelopeUrl: `${u.protocol}//${u.host}${prefix}/api/${projectId}/envelope/`,
  };
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_DIGITS = /(?<![A-Za-z0-9])\+?\d[\d\s-]{7,}\d(?![A-Za-z0-9])/g;

/** Replaces emails, uuids and runs of 9 or more digits (allowing spaces and hyphens) so a message cannot carry personal data out. */
export function scrubText(text: string, max = 1000): string {
  return text.replace(EMAIL, "[email]").replace(UUID, "[id]").replace(LONG_DIGITS, "[number]").slice(0, max);
}

/** Keeps the pattern of a path and drops the query string and anything after a '#'. A concrete id segment becomes `:id`. */
export function scrubPath(path: string | undefined | null): string {
  if (!path) return "";
  const bare = path.split(/[?#]/)[0] ?? "";
  return bare
    .split("/")
    .map((seg) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^\d{4,}$/.test(seg) ? ":id" : seg))
    .join("/")
    .slice(0, 300);
}

export type ErrorContext = {
  /** The route pattern Next matched, such as /app/guests/[id]. Preferred over `path`. */
  routePath?: string;
  /** The address that was requested. Reduced to a pattern before it is sent. */
  path?: string;
  method?: string;
  routeType?: string; // render, route, action, middleware
  routerKind?: string;
  digest?: string;
  release?: string;
  environment?: string;
  runtime?: string;
};

export type ErrorEvent = {
  event_id: string;
  timestamp: number;
  platform: "javascript";
  level: "error";
  release?: string;
  environment?: string;
  server_name?: string;
  exception: { values: { type: string; value: string; stacktrace?: { frames: { filename?: string; function?: string; lineno?: number; colno?: number }[] } }[] };
  tags: Record<string, string>;
  request?: { method?: string; url: string };
};

const FRAME = /^\s*at\s+(?:(.*?)\s+\()?(.*?):(\d+):(\d+)\)?$/;

/** Parses a V8 stack into frames (oldest first, as Sentry expects). Message lines and unparsable lines are skipped. File names lose any query. */
export function parseStack(stack: string | undefined): { filename?: string; function?: string; lineno?: number; colno?: number }[] {
  if (!stack) return [];
  const frames: { filename?: string; function?: string; lineno?: number; colno?: number }[] = [];
  for (const line of stack.split("\n")) {
    const m = FRAME.exec(line);
    if (!m) continue;
    frames.push({ function: m[1] || undefined, filename: (m[2] ?? "").split("?")[0], lineno: Number(m[3]), colno: Number(m[4]) });
  }
  return frames.slice(0, 50).reverse();
}

/** 32 hex characters, as Sentry wants. */
export function newEventId(random: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(random() * 16).toString(16);
  return s;
}

export function buildEvent(err: unknown, ctx: ErrorContext = {}, now: () => number = Date.now, id: () => string = newEventId): ErrorEvent {
  const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : "Non-error thrown");
  const route = ctx.routePath ? scrubPath(ctx.routePath) : scrubPath(ctx.path);
  const tags: Record<string, string> = {};
  if (ctx.routeType) tags.route_type = ctx.routeType;
  if (ctx.routerKind) tags.router = ctx.routerKind;
  if (ctx.digest) tags.digest = ctx.digest;
  if (ctx.runtime) tags.runtime = ctx.runtime;
  if (route) tags.route = route;
  const frames = parseStack(e.stack);
  return {
    event_id: id(),
    timestamp: Math.floor(now() / 1000),
    platform: "javascript",
    level: "error",
    release: ctx.release || undefined,
    environment: ctx.environment || undefined,
    exception: {
      values: [
        {
          type: scrubText(e.name || "Error", 100),
          value: scrubText(e.message || "(no message)"),
          stacktrace: frames.length ? { frames } : undefined,
        },
      ],
    },
    tags,
    request: route ? { method: ctx.method, url: route } : undefined,
  };
}

/** The three-line envelope body: header, item header, the event. */
export function buildEnvelope(event: ErrorEvent, dsn: Dsn, sentAt: Date = new Date()): string {
  const header = { event_id: event.event_id, sent_at: sentAt.toISOString(), dsn: `${dsn.protocol}://${dsn.publicKey}@${dsn.host}/${dsn.projectId}` };
  const item = { type: "event" };
  return `${JSON.stringify(header)}\n${JSON.stringify(item)}\n${JSON.stringify(event)}\n`;
}

/** The same error twice in a short time is reported once, so a failing page that is refreshed 500 times does not flood the tracker. */
export function makeDeduper(windowMs = 60_000, max = 200, now: () => number = Date.now) {
  const seen = new Map<string, number>();
  return (key: string): boolean => {
    const t = now();
    for (const [k, at] of seen) if (t - at > windowMs) seen.delete(k);
    if (seen.has(key)) return false;
    if (seen.size >= max) seen.delete(seen.keys().next().value as string);
    seen.set(key, t);
    return true;
  };
}

export function dedupeKey(event: ErrorEvent): string {
  const v = event.exception.values[0];
  return `${v?.type}|${v?.value}|${event.tags.route ?? ""}|${v?.stacktrace?.frames.at(-1)?.lineno ?? ""}`;
}
