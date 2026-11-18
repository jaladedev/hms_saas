import type { Mailer } from "@/lib/email/mailer";
import { escapeHtml, type RenderedEmail } from "@/lib/email/templates";
import { formatMoney } from "@/lib/guest-site/format";
import type { TicketOrderView, VenueBookingView } from "@/lib/guest-site/server";
import { formatLocal } from "@/lib/staff/events";

export type EventEmailKind = "venue_received" | "venue_held" | "venue_confirmed" | "tickets_paid";
export type ClaimedEventEmail = {
  id: string;
  kind: EventEmailKind;
  to_email: string;
  attempt: number;
  target_id: string;
  site_host: string | null;
  view: unknown;
};

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;
export const eventLinkPath = (kind: EventEmailKind) => (kind === "tickets_paid" ? "/tickets/" : "/event-booking/");

function page(heading: string, lines: string[], link: string, button: string, footer: string): { text: string; html: string } {
  const text = [...lines, "", `${button}: ${link}`, "", footer].join("\n");
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1b2430">` +
    `<h1 style="font-size:22px">${escapeHtml(heading)}</h1>` +
    lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("") +
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#0f766e;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none">${escapeHtml(button)}</a></p>` +
    `<p style="font-size:13px;color:#5b6573">Or copy this link: ${escapeHtml(link)}</p>` +
    `<p style="font-size:12px;color:#5b6573">${escapeHtml(footer)}</p></div>`;
  return { text, html };
}

/** The email for one claimed row. `view` is what the guest's own page shows (guest_venue_booking or guest_ticket_order). Throws when it is not usable. */
export function renderEventEmail(kind: EventEmailKind, view: unknown, link: string): RenderedEmail {
  if (typeof view !== "object" || view === null) throw new Error("event email has no page data");
  if (kind === "tickets_paid") {
    const o = view as TicketOrderView;
    if (typeof o.event !== "string" || !Array.isArray(o.tickets)) throw new Error("ticket email has unusable data");
    const lines = [
      `Hello ${o.buyer_name},`,
      `Your payment for ${o.event} at ${o.hotel} has been received. Your order is ${o.reference}.`,
      `The event is on ${formatLocal(o.starts_at)}${o.venue ? ` at ${o.venue}` : ""}.`,
      o.tickets.length > 0
        ? `Your ticket codes: ${o.tickets.map((t) => t.code).join(", ")}. Show a code at the door.`
        : "Your tickets are on your order page.",
    ];
    const body = page(
      "Your tickets",
      lines,
      link,
      "Open your tickets",
      "Keep this email. The link opens your tickets from any phone, with no account.",
    );
    return { subject: `Your tickets for ${o.event}`, ...body };
  }
  const b = view as VenueBookingView;
  if (typeof b.venue !== "string" || typeof b.currency !== "string") throw new Error("venue email has unusable data");
  const money = (n: number) => formatMoney(n, b.currency);
  const when = `${b.venue}, ${formatLocal(b.starts_at)} to ${formatLocal(b.ends_at)}`;
  const footer = "Keep this email. The link opens your booking from any phone, with no account.";
  if (kind === "venue_received") {
    const lines = [
      `Hello ${b.contact_name},`,
      `Thank you for your enquiry about ${when} at ${b.hotel}. Your reference is ${b.reference}.`,
      "Nothing is held yet. The hotel will reply with a quote, and you can follow it on your booking page.",
    ];
    return {
      subject: `We have your venue enquiry at ${b.hotel}`,
      ...page("We have your enquiry", lines, link, "Open your booking", footer),
    };
  }
  if (kind === "venue_held") {
    const lines = [
      `Hello ${b.contact_name},`,
      `${when} is being held for you at ${b.hotel}${b.hold_expires_at ? ` until ${formatLocal(b.hold_expires_at)}` : ""}. Your reference is ${b.reference}.`,
      `The total is ${money(b.total_minor)}. A deposit of ${money(b.deposit_minor)} confirms the booking; if it is not paid before the hold ends, the venue is released.`,
    ];
    return { subject: `Your venue is held at ${b.hotel}`, ...page("Your venue is held", lines, link, "Pay the deposit", footer) };
  }
  const lines = [
    `Hello ${b.contact_name},`,
    `Your booking for ${when} at ${b.hotel} is confirmed. Your reference is ${b.reference}.`,
    b.due_minor > 0 ? `${money(b.due_minor)} is still to pay; you can pay it from your booking page.` : "Nothing more is due.",
  ];
  return {
    subject: `Your venue booking is confirmed at ${b.hotel}`,
    ...page("Your booking is confirmed", lines, link, "Open your booking", footer),
  };
}

export type EventEmailDeps = {
  claim(limit: number): Promise<ClaimedEventEmail[]>;
  mark(id: string, ok: boolean, error?: string): Promise<void>;
  mailer: Mailer;
  /** Signed event link token for a booking ("v") or an order ("t"); the secret stays in the app. */
  makeToken(kind: "v" | "t", id: string): string;
  linkScheme: "http" | "https";
  log?(level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void;
};

/** Sends claimed event emails one by one; one failure never blocks the others. */
export async function drainEventEmails(deps: EventEmailDeps, limit: number): Promise<{ claimed: number; sent: number; failed: number }> {
  const log = deps.log ?? (() => {});
  const claimed = await deps.claim(limit);
  let sent = 0;
  let failed = 0;
  for (const m of claimed) {
    let error: string | null = null;
    try {
      if (!m.site_host || !HOST.test(m.site_host)) throw new Error("no verified domain for this hotel");
      const link = `${deps.linkScheme}://${m.site_host}${eventLinkPath(m.kind)}${deps.makeToken(m.kind === "tickets_paid" ? "t" : "v", m.target_id)}`;
      await deps.mailer.send({ to: m.to_email, ...renderEventEmail(m.kind, m.view, link), idempotencyKey: m.id });
    } catch (e) {
      error = e instanceof Error ? e.message : "send failed";
    }
    try {
      await deps.mark(m.id, error === null, error ?? undefined);
    } catch (e) {
      log("error", "could not record event email result", { emailId: m.id, message: e instanceof Error ? e.message : "unknown" });
    }
    if (error === null) sent++;
    else {
      failed++;
      log("warn", "event email failed", { emailId: m.id, kind: m.kind, attempt: m.attempt, error });
    }
  }
  return { claimed: claimed.length, sent, failed };
}
