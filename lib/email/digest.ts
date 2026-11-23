import type { Mailer } from "@/lib/email/mailer";
import { escapeHtml, type RenderedEmail } from "@/lib/email/templates";
import { formatDate } from "@/lib/guest-site/format";

export type OutlookNight = { date: string; occupied: number };

export type DigestPayload = {
  hotel: string;
  date: string;
  arrivals: number;
  departures: number;
  in_house: number;
  tomorrow: number;
  holds: number;
  messages: number;
  waiting: number;
  rooms: number;
  occupied_tonight: number;
  occupied_tomorrow: number;
  /** Today and the six nights after it, as the database counted them (migration 184). Empty for a summary queued before that migration. */
  outlook: OutlookNight[];
};
export type ClaimedDigest = { id: string; to_email: string; payload: Record<string, unknown>; attempt: number };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sat 28 Nov" for a calendar date, the same in every environment (no locale data involved). */
export function shortDay(iso: string): string {
  if (!ISO_DATE.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${d} ${MONTHS[m - 1] ?? ""}`.trim();
}

/** Whole-number percent of the rooms in service that are occupied, never above 100; null when the hotel has no rooms in service. */
export function occupancyPercent(occupied: number, rooms: number): number | null {
  return rooms > 0 ? Math.round((Math.min(occupied, rooms) / rooms) * 100) : null;
}

function parseOutlook(raw: unknown): OutlookNight[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 7).flatMap((e) => {
    if (typeof e !== "object" || e === null) return [];
    const r = e as Record<string, unknown>;
    const occupied = r.occupied;
    if (typeof r.date !== "string" || !ISO_DATE.test(r.date) || typeof occupied !== "number" || !Number.isFinite(occupied) || occupied < 0)
      return [];
    return [{ date: r.date, occupied: Math.trunc(occupied) }];
  });
}

export type OutlookSummary = {
  nights: number;
  /** All the nights together: room nights occupied over room nights in service, not an average of the daily percentages. */
  percent: number;
  busiest: { date: string; percent: number } | null;
  quietest: { date: string; percent: number } | null;
};

/** The few numbers worth reading first about the week ahead. Null with fewer than two nights or no rooms in service. */
export function outlookSummary(outlook: OutlookNight[], rooms: number): OutlookSummary | null {
  if (outlook.length < 2 || rooms <= 0) return null;
  const used = outlook.reduce((a, n) => a + Math.min(n.occupied, rooms), 0);
  const nights = outlook.map((n) => ({ date: n.date, percent: occupancyPercent(n.occupied, rooms) ?? 0 }));
  const busiest = nights.reduce((b, n) => (n.percent > b.percent ? n : b));
  const quietest = nights.reduce((q, n) => (n.percent < q.percent ? n : q));
  const same = busiest.percent === quietest.percent;
  return {
    nights: outlook.length,
    percent: Math.round((used / (rooms * outlook.length)) * 100),
    busiest: same ? null : busiest,
    quietest: same ? null : quietest,
  };
}

/** The week-ahead sentences for the summary. Empty when the summary has no outlook. */
export function outlookLines(outlook: OutlookNight[], rooms: number): string[] {
  const o = outlookSummary(outlook, rooms);
  if (!o) return [];
  const lines = [`Next ${o.nights} nights: ${o.percent}% occupied`];
  if (o.busiest) lines.push(`Busiest night: ${shortDay(o.busiest.date)} (${o.busiest.percent}%)`);
  if (o.quietest) lines.push(`Quietest night: ${shortDay(o.quietest.date)} (${o.quietest.percent}%)`);
  return lines;
}

/** Reads the counts the database stored; anything missing or not a whole number counts as 0. */
export function digestPayload(raw: Record<string, unknown>): DigestPayload {
  const n = (k: string) => (typeof raw[k] === "number" && Number.isFinite(raw[k]) && raw[k] >= 0 ? Math.trunc(raw[k] as number) : 0);
  return {
    hotel: typeof raw.hotel === "string" ? raw.hotel : "Your hotel",
    date: typeof raw.date === "string" ? raw.date : "",
    arrivals: n("arrivals"),
    departures: n("departures"),
    in_house: n("in_house"),
    tomorrow: n("tomorrow"),
    holds: n("holds"),
    messages: n("messages"),
    waiting: n("waiting"),
    rooms: n("rooms"),
    occupied_tonight: n("occupied_tonight"),
    occupied_tomorrow: n("occupied_tomorrow"),
    outlook: parseOutlook(raw.outlook),
  };
}

/** "12 of 20 (60%)", or "12" when the hotel has no rooms in service to compare with. */
export function occupancyText(occupied: number, rooms: number): string {
  if (rooms <= 0) return String(occupied);
  const shown = Math.min(occupied, rooms);
  return `${shown} of ${rooms} (${Math.round((shown / rooms) * 100)}%)`;
}

/** The morning summary: counts only, no guest names or money. */
export function renderDigest(raw: Record<string, unknown>): RenderedEmail {
  const p = digestPayload(raw);
  const day = p.date ? formatDate(p.date) : "today";
  const rows: [string, number | string][] = [
    ["Arrivals still to come today", p.arrivals],
    ["Departures still to go today", p.departures],
    ["Guests in house", p.in_house],
    ["Rooms occupied tonight", occupancyText(p.occupied_tonight, p.rooms)],
    ["Rooms booked for tomorrow night", occupancyText(p.occupied_tomorrow, p.rooms)],
    ["Arrivals tomorrow", p.tomorrow],
    ["Holds waiting for payment", p.holds],
    ["Guest messages to answer", p.messages],
    ["Waiting-list requests", p.waiting],
  ];
  const tonight = occupancyPercent(p.occupied_tonight, p.rooms);
  const subject =
    tonight === null
      ? `${p.hotel}: ${p.arrivals} arriving, ${p.departures} leaving today`
      : `${p.hotel}: ${tonight}% full tonight, ${p.arrivals} arriving, ${p.departures} leaving`;
  const week = outlookLines(p.outlook, p.rooms);
  const byNight = p.outlook.length > 1 && p.rooms > 0 ? p.outlook : [];
  const nightText = (n: OutlookNight) => `${shortDay(n.date)}: ${occupancyText(n.occupied, p.rooms)}`;
  const text = [
    `${p.hotel}, ${day}`,
    "",
    ...rows.map(([l, v]) => `${l}: ${v}`),
    ...(week.length > 0 ? ["", ...week] : []),
    ...(byNight.length > 0 ? ["", "Rooms occupied by night:", ...byNight.map(nightText)] : []),
    "",
    "Open the staff app for names, rooms and balances.",
  ].join("\n");
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1b2430">` +
    `<h1 style="font-size:22px">${escapeHtml(p.hotel)}</h1><p>${escapeHtml(day)}</p>` +
    `<table style="border-collapse:collapse;width:100%">` +
    rows
      .map(
        ([l, v]) =>
          `<tr><td style="padding:6px 0;border-bottom:1px solid #e5e7eb">${escapeHtml(l)}</td><td style="padding:6px 0;border-bottom:1px solid #e5e7eb;text-align:right"><strong>${v}</strong></td></tr>`,
      )
      .join("") +
    `</table>` +
    week
      .map(
        (l, i) =>
          `<p style="margin:${i === 0 ? "14px" : "2px"} 0 2px;${i === 0 ? "font-weight:bold" : "color:#5b6573"}">${escapeHtml(l)}</p>`,
      )
      .join("") +
    (byNight.length > 0
      ? `<h2 style="font-size:15px;margin:18px 0 4px">Rooms occupied by night</h2><table style="border-collapse:collapse;width:100%">` +
        byNight
          .map(
            (n) =>
              `<tr><td style="padding:6px 0;border-bottom:1px solid #e5e7eb">${escapeHtml(shortDay(n.date))}</td><td style="padding:6px 0;border-bottom:1px solid #e5e7eb;text-align:right">${escapeHtml(occupancyText(n.occupied, p.rooms))}</td></tr>`,
          )
          .join("") +
        `</table>`
      : "") +
    `<p style="color:#5b6573;font-size:13px">Open the staff app for names, rooms and balances.</p></div>`;
  return { subject, text, html };
}

export type DigestDeps = {
  claim(limit: number): Promise<ClaimedDigest[]>;
  mark(id: string, ok: boolean, error?: string): Promise<void>;
  mailer: Mailer;
  log?(level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void;
};

/** Sends claimed summaries one by one; one failure never blocks the others. */
export async function drainDigests(deps: DigestDeps, limit: number): Promise<{ claimed: number; sent: number; failed: number }> {
  const log = deps.log ?? (() => {});
  const claimed = await deps.claim(limit);
  let sent = 0;
  let failed = 0;
  for (const d of claimed) {
    let error: string | null = null;
    try {
      await deps.mailer.send({ to: d.to_email, ...renderDigest(d.payload), idempotencyKey: d.id });
    } catch (e) {
      error = e instanceof Error ? e.message : "send failed";
    }
    try {
      await deps.mark(d.id, error === null, error ?? undefined);
    } catch (e) {
      log("error", "could not record digest result", { digestId: d.id, message: e instanceof Error ? e.message : "unknown" });
    }
    if (error === null) sent++;
    else {
      failed++;
      log("warn", "digest send failed", { digestId: d.id, attempt: d.attempt, error });
    }
  }
  return { claimed: claimed.length, sent, failed };
}
