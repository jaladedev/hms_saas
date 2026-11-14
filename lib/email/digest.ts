import type { Mailer } from "@/lib/email/mailer";
import { escapeHtml, type RenderedEmail } from "@/lib/email/templates";
import { formatDate } from "@/lib/guest-site/format";

export type DigestPayload = {
  hotel: string;
  date: string;
  arrivals: number;
  departures: number;
  in_house: number;
  tomorrow: number;
  holds: number;
};
export type ClaimedDigest = { id: string; to_email: string; payload: Record<string, unknown>; attempt: number };

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
  };
}

/** The morning summary: counts only, no guest names or money. */
export function renderDigest(raw: Record<string, unknown>): RenderedEmail {
  const p = digestPayload(raw);
  const day = p.date ? formatDate(p.date) : "today";
  const rows: [string, number][] = [
    ["Arrivals still to come today", p.arrivals],
    ["Departures still to go today", p.departures],
    ["Guests in house", p.in_house],
    ["Arrivals tomorrow", p.tomorrow],
    ["Holds waiting for payment", p.holds],
  ];
  const subject = `${p.hotel}: ${p.arrivals} arriving, ${p.departures} leaving today`;
  const text = [
    `${p.hotel}, ${day}`,
    "",
    ...rows.map(([l, v]) => `${l}: ${v}`),
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
    `</table><p style="color:#5b6573;font-size:13px">Open the staff app for names, rooms and balances.</p></div>`;
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
