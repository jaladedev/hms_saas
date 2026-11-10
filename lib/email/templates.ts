import { formatDate, formatMoney, formatTime } from "@/lib/guest-site/format";
import type { BookingStatus } from "@/lib/guest-site/server";

export type EmailKind = "booking_held" | "booking_confirmed" | "booking_link" | "refund_processed" | "booking_cancelled" | "payment_no_room" | "folio_invoice" | "early_checkout_credit" | "stay_changed" | "change_request_answered";
export type RenderedEmail = { subject: string; text: string; html: string };

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function timeInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(iso));
}

type InvoiceLine = { date: string; description: string; quantity: number; unit: number; tax: number; total: number };

/** Reads the frozen copy of an invoice for extras out of an email's payload. Anything that is not the expected shape is left out. */
export function invoiceLinesFrom(payload: Record<string, unknown> | undefined): InvoiceLine[] {
  const raw = payload?.lines;
  if (!Array.isArray(raw)) return [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const out: InvoiceLine[] = [];
  for (const l of raw) {
    if (typeof l !== "object" || l === null) continue;
    const o = l as Record<string, unknown>;
    const quantity = num(o.quantity), unit = num(o.unit_amount_minor), tax = num(o.tax_minor), total = num(o.line_total_minor);
    if (typeof o.description !== "string" || quantity === null || unit === null || tax === null || total === null) continue;
    out.push({ date: typeof o.service_date === "string" ? o.service_date : "", description: o.description, quantity, unit, tax, total });
  }
  return out;
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
    case "payment_no_room": {
      const paid = typeof input.payload?.paid_minor === "number" ? input.payload.paid_minor : 0;
      const currency = typeof input.payload?.currency === "string" ? input.payload.currency : b.currency;
      subject = `About your payment for booking ${b.booking_reference}`;
      heading = "We received your payment, but your room is no longer available";
      button = "View your booking";
      lines.push(paid > 0
        ? `We received your payment of ${formatMoney(paid, currency)} for booking ${b.booking_reference} at ${b.property_name} (${stay}). Unfortunately the room had been taken by the time it reached us.`
        : `We received your payment for booking ${b.booking_reference} at ${b.property_name} (${stay}). Unfortunately the room had been taken by the time it reached us.`);
      lines.push("You do not need to pay again. The hotel will contact you to arrange either another room for your dates or a full refund of what you paid.");
      break;
    }
    case "early_checkout_credit": {
      const num = (k: string) => (typeof input.payload?.[k] === "number" ? (input.payload[k] as number) : 0);
      const credit = num("credit_minor"), nights = num("nights_credited"), newTotal = typeof input.payload?.new_total_minor === "number" ? input.payload.new_total_minor : b.total_minor, refundDue = num("refund_due_minor");
      const currency = typeof input.payload?.currency === "string" ? input.payload.currency : b.currency;
      subject = `Your early check-out: booking ${b.booking_reference}`;
      heading = "Your stay has been adjusted";
      button = "View your booking";
      lines.push(`Thank you for staying at ${b.property_name}. Because you left before your booked departure, ${nights === 1 ? "1 night" : `${nights} nights`} you did not stay ${nights === 1 ? "has" : "have"} been credited under the hotel's policy.`);
      lines.push(`Credit: ${formatMoney(credit, currency)}. Your booking total is now ${formatMoney(newTotal, currency)}.`);
      if (refundDue > 0) lines.push(`You have paid more than that, so the hotel will refund ${formatMoney(refundDue, currency)}. They will arrange it, and you will get a separate email when it is paid out.`);
      break;
    }
    case "stay_changed": {
      const p = input.payload ?? {};
      const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : null);
      const num = (k: string) => (typeof p[k] === "number" ? (p[k] as number) : null);
      const currency = str("currency") ?? b.currency;
      const from = num("from_total_minor"), to = num("to_total_minor") ?? b.total_minor, refundDue = num("refund_due_minor") ?? 0;
      subject = `Your booking ${b.booking_reference} has changed`;
      heading = "Your booking has changed";
      button = "View your booking";
      if (p.change === "room_type") {
        lines.push(`Your room at ${b.property_name} has been changed to ${str("room_type") ?? "another room type"}${str("effective") ? `, from ${formatDate(str("effective") as string)}` : ""}.`);
      } else {
        const fa = str("from_arrival"), fd = str("from_departure"), ta = str("to_arrival") ?? b.arrival_date, td = str("to_departure") ?? b.departure_date;
        lines.push(`The dates of your stay at ${b.property_name} are now ${formatDate(ta)} to ${formatDate(td)}${fa && fd ? ` (they were ${formatDate(fa)} to ${formatDate(fd)})` : ""}.`);
      }
      lines.push(from !== null && from !== to
        ? `Your booking total is now ${formatMoney(to, currency)} (it was ${formatMoney(from, currency)}).`
        : `Your booking total is ${formatMoney(to, currency)}.`);
      if (refundDue > 0) lines.push(`You have paid more than that, so the hotel will refund ${formatMoney(refundDue, currency)}. They will arrange it, and you will get a separate email when it is paid out.`);
      break;
    }
    case "change_request_answered": {
      const p = input.payload ?? {};
      const declined = p.outcome === "declined";
      const note = typeof p.note === "string" && p.note.trim() ? p.note.trim() : null;
      subject = declined ? `About your request for booking ${b.booking_reference}` : `Your request for booking ${b.booking_reference} is dealt with`;
      heading = declined ? "We could not make that change" : "Your request has been dealt with";
      button = "View your booking";
      lines.push(declined
        ? `${b.property_name} was not able to make the change you asked for on booking ${b.booking_reference}. Your booking stays as it was (${stay}).`
        : `${b.property_name} has dealt with the change you asked for on booking ${b.booking_reference}. Your booking is now ${stay}.`);
      if (note) lines.push(`Message from the hotel: ${note}`);
      break;
    }
    case "folio_invoice": {
      const number = typeof input.payload?.invoice_number === "string" ? input.payload.invoice_number : "";
      const currency = typeof input.payload?.currency === "string" ? input.payload.currency : b.currency;
      const sum = typeof input.payload?.total_minor === "number" ? input.payload.total_minor : null;
      const tax = typeof input.payload?.tax_minor === "number" ? input.payload.tax_minor : 0;
      subject = number ? `Invoice ${number} for extras at ${b.property_name}` : `Invoice for extras at ${b.property_name}`;
      heading = "Your invoice for extras";
      button = "View your booking";
      lines.push(`Here is your invoice${number ? ` ${number}` : ""} for the extras charged during your stay at ${b.property_name} (${stay}).`);
      for (const l of invoiceLinesFrom(input.payload)) {
        const when = l.date ? `${formatDate(l.date)}: ` : "";
        lines.push(`${when}${l.description}, ${l.quantity} x ${formatMoney(l.unit, currency)} = ${formatMoney(l.total, currency)}${l.tax > 0 ? ` (tax ${formatMoney(l.tax, currency)} included)` : ""}`);
      }
      if (sum !== null) lines.push(`Total: ${formatMoney(sum, currency)}${tax > 0 ? `, of which tax ${formatMoney(tax, currency)}` : ""}.`);
      lines.push("Money you have paid for extras is not shown on this invoice. If anything looks wrong, please speak to the hotel.");
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
