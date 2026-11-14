import type { Mailer } from "@/lib/email/mailer";
import { escapeHtml, type RenderedEmail } from "@/lib/email/templates";
import { formatDate } from "@/lib/guest-site/format";

export type ClaimedNotice = { id: string; to_email: string; payload: Record<string, unknown>; attempt: number };

export type NoticePayload = {
  hotel: string;
  room_type: string;
  guest_name: string;
  arrival: string;
  departure: string;
  adults: number;
  children: number;
  site_host: string;
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
// A host name as stored for a verified domain: letters, digits, dots, hyphens and an optional port. Anything else is not linked.
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

/** Reads the stored payload; a missing text is empty and a missing count is the smallest valid one. */
export function noticePayload(raw: Record<string, unknown>): NoticePayload {
  const s = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  const n = (k: string, min: number) =>
    typeof raw[k] === "number" && Number.isFinite(raw[k]) ? Math.max(min, Math.trunc(raw[k] as number)) : min;
  return {
    hotel: s("hotel") || "the hotel",
    room_type: s("room_type"),
    guest_name: s("guest_name"),
    arrival: s("arrival"),
    departure: s("departure"),
    adults: n("adults", 1),
    children: n("children", 0),
    site_host: s("site_host"),
  };
}

/** The hotel's site with the same search filled in: arrival, departure and party. Null when the dates or host are not usable. */
export function searchLink(p: NoticePayload, scheme: "http" | "https"): string | null {
  if (!ISO.test(p.arrival) || !ISO.test(p.departure) || !HOST.test(p.site_host)) return null;
  const q = new URLSearchParams({ arrival: p.arrival, departure: p.departure, adults: String(p.adults), children: String(p.children) });
  return `${scheme}://${p.site_host}/?${q.toString()}`;
}

/** "A room may be free": says nothing is held, and links to the search for the same dates. */
export function renderWaitlistNotice(raw: Record<string, unknown>, scheme: "http" | "https" = "https"): RenderedEmail {
  const p = noticePayload(raw);
  const link = searchLink(p, scheme);
  if (!link) throw new Error("waiting list email has no usable dates or site address");
  const subject = `A room may now be free at ${p.hotel}`;
  const lines = [
    p.guest_name ? `Hello ${p.guest_name},` : "Hello,",
    `You asked us to tell you if a ${p.room_type || "room"} became free at ${p.hotel} for ${formatDate(p.arrival)} to ${formatDate(p.departure)}.`,
    "A room may now be available. Nothing is held for you, and another guest may book it first, so please check and book soon if you still want it.",
  ];
  const text = [
    ...lines,
    "",
    `Check availability: ${link}`,
    "",
    "You are receiving this because you joined the waiting list on the hotel's website. If you no longer need a room, you can ignore this email.",
  ].join("\n");
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1b2430">` +
    `<h1 style="font-size:22px">A room may now be free</h1>` +
    lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("") +
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#0f766e;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none">Check availability</a></p>` +
    `<p style="color:#5b6573;font-size:13px">You are receiving this because you joined the waiting list on the hotel's website. If you no longer need a room, you can ignore this email.</p></div>`;
  return { subject, text, html };
}

export type NoticeDeps = {
  claim(limit: number): Promise<ClaimedNotice[]>;
  mark(id: string, ok: boolean, error?: string): Promise<void>;
  mailer: Mailer;
  linkScheme: "http" | "https";
  log?(level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void;
};

/** Sends claimed notices one by one; one failure never blocks the others. */
export async function drainNotices(deps: NoticeDeps, limit: number): Promise<{ claimed: number; sent: number; failed: number }> {
  const log = deps.log ?? (() => {});
  const claimed = await deps.claim(limit);
  let sent = 0;
  let failed = 0;
  for (const d of claimed) {
    let error: string | null = null;
    try {
      await deps.mailer.send({ to: d.to_email, ...renderWaitlistNotice(d.payload, deps.linkScheme), idempotencyKey: d.id });
    } catch (e) {
      error = e instanceof Error ? e.message : "send failed";
    }
    try {
      await deps.mark(d.id, error === null, error ?? undefined);
    } catch (e) {
      log("error", "could not record waiting list email result", { noticeId: d.id, message: e instanceof Error ? e.message : "unknown" });
    }
    if (error === null) sent++;
    else {
      failed++;
      log("warn", "waiting list email failed", { noticeId: d.id, attempt: d.attempt, error });
    }
  }
  return { claimed: claimed.length, sent, failed };
}
