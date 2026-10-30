import { formatDate, formatMoney, formatTime } from "@/lib/guest-site/format";
import type { BookingStatus } from "@/lib/guest-site/server";

export type EmailKind = "booking_held" | "booking_confirmed" | "booking_link" | "refund_processed" | "booking_cancelled";
export type RenderedEmail = { subject: string; text: string; html: string };

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function timeInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
}

/**
 * Plain text and HTML for each guest email. The link is built by the caller (it carries the signed
 * booking token); templates only place it. Everything interpolated into HTML is escaped.
 */
export function renderEmail(input: {
  kind: EmailKind;
  booking: BookingStatus;
  link: string;
  payload?: Record<string, unknown>;
  now?: number;
}): RenderedEmail {
  const { booking: b, link } = input;
  const now = input.now ?? Date.now();
  const stay = `${formatDate(b.arrival_date)} to ${formatDate(b.departure_date)}`;
  const total = formatMoney(b.total_minor, b.currency);
  const lines: string[] = [];
  let subject: string;
  let heading: string;
  let button: string;

  switch (input.kind) {
    case "booking_held": {
      subject = `Complete your booking ${b.booking_reference} at ${b.property_name}`;
      heading = "Your room is on hold";
      button = "Complete your booking";
      lines.push(`We are holding your room at ${b.property_name} for ${stay}.`);
      if (b.hold_expires_at && Date.parse(b.hold_expires_at) > now) {
        lines.push(`The hold lasts until ${timeInZone(b.hold_expires_at, b.timezone)} (hotel time). Pay before then to confirm your booking.`);
      } else {
        lines.push("The hold may already have expired. Open your booking to check, or search again.");
      }
      lines.push(`Total: ${total}.`);
      break;
    }
    case "booking_confirmed":
      subject = `Booking confirmed: ${b.booking_reference}`;
      heading = "Your booking is confirmed";
      button = "View your booking";
      lines.push(`You are booked at ${b.property_name} for ${stay}.`);
      lines.push(`Check-in is from ${formatTime(b.check_in_time)} and check-out by ${formatTime(b.check_out_time)}.`);
      lines.push(`Total: ${total}. Paid: ${formatMoney(b.paid_minor, b.currency)}.`);
      break;
    case "refund_processed": {
      const amount = typeof input.payload?.amount_minor === "number" ? input.payload.amount_minor : null;
      const currency = typeof input.payload?.currency === "string" ? input.payload.currency : b.currency;
      subject = `Refund processed for booking ${b.booking_reference}`;
      heading = "Your refund has been processed";
      button = "View your booking";
      lines.push(amount !== null ? `We have refunded ${formatMoney(amount, currency)} for your booking at ${b.property_name}.` : `We have processed a refund for your booking at ${b.property_name}.`);
      lines.push("It can take a few days to appear, depending on your bank or card.");
      break;
    }
    case "booking_cancelled": {
      const charge = typeof input.payload?.charge_minor === "number" ? input.payload.charge_minor : 0;
      const refundDue = typeof input.payload?.refund_due_minor === "number" ? input.payload.refund_due_minor : 0;
      const currency = typeof input.payload?.currency === "string" ? input.payload.currency : b.currency;
      subject = `Your booking ${b.booking_reference} has been cancelled`;
      heading = "Your booking has been cancelled";
      button = "View your booking";
      lines.push(`Your booking at ${b.property_name} for ${stay} has been cancelled.`);
      if (charge > 0) lines.push(`A cancellation charge of ${formatMoney(charge, currency)} applies under the booking terms.`);
      if (refundDue > 0) lines.push(`Any refund due to you (${formatMoney(refundDue, currency)}) will be processed by the hotel, and you will get a separate email when it is paid out.`);
      if (charge === 0 && refundDue === 0) lines.push("No charge applies.");
      break;
    }
    case "booking_link":
      subject = `Your booking link for ${b.booking_reference}`;
      heading = "Your booking link";
      button = "Open your booking";
      lines.push(`Here is a new link to your booking ${b.booking_reference} at ${b.property_name} (${stay}).`);
      lines.push("The link works for 7 days. Anyone with it can see this booking, so please do not forward it.");
      break;
  }

  const footer = "If you did not make this booking or request this email, you can ignore it.";
  const text = [heading, "", ...lines, "", `${button}: ${link}`, "", `Booking reference: ${b.booking_reference}`, "", footer].join("\n");
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1b2430">` +
    `<h1 style="font-size:22px">${escapeHtml(heading)}</h1>` +
    lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("") +
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#0f766e;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none">${escapeHtml(button)}</a></p>` +
    `<p style="font-size:13px;color:#5b6573">Or copy this link: ${escapeHtml(link)}</p>` +
    `<p style="font-size:13px;color:#5b6573">Booking reference: ${escapeHtml(b.booking_reference)}</p>` +
    `<p style="font-size:12px;color:#5b6573">${escapeHtml(footer)}</p></div>`;
  return { subject, text, html };
}
