import type { BookingStatus } from "@/lib/guest-site/server";
import { formatTime } from "@/lib/guest-site/format";

export type SmsKind = "booking_confirmed" | "arrival_reminder" | "review_request";

export const SMS_KINDS: readonly SmsKind[] = ["booking_confirmed", "arrival_reminder", "review_request"];

/** A host name as stored for a verified domain; anything else is not put in a text. */
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Plain letters, digits and common punctuation only. Accents are folded to their letters, curly quotes and dashes become straight
 * ones, the naira sign becomes "NGN", and the characters that cost two places in a GSM text ([ ] \ ^ { } ~ |) are dropped, so a text
 * stays one part for as long as possible and never turns into question marks on an older phone.
 */
export function gsmSafe(value: string): string {
  return value
    .replace(/₦/g, "NGN ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019\u201a\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[[\]\\^{}~|]/g, "")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** How many parts a text is sent as: one up to 160 characters, then 153 per part. */
export function smsParts(text: string): number {
  return text.length <= 160 ? 1 : Math.ceil(text.length / 153);
}

function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return iso;
  return `${d} ${MONTHS[m - 1]}`;
}

function cut(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}.`;
}

export type SmsInput = {
  kind: SmsKind;
  booking: BookingStatus;
  /** The hotel's own number, shown in the reminder so a guest can call; null leaves it out. */
  hotelPhone: string | null;
  /** The hotel's verified site; the lookup page there is linked. Null or an unusable host leaves the link out. */
  siteHost: string | null;
  scheme: "http" | "https";
};

/**
 * The words of a text. It never carries the signed booking link: that link is long (it would cost several parts) and a text is
 * easier to read over a shoulder than an email, so the guest gets the booking reference and the hotel's lookup page, where a fresh
 * link is emailed to the address on the booking.
 */
export function renderSms(input: SmsInput): string {
  const { booking: b } = input;
  const hotel = cut(gsmSafe(b.property_name) || "Your hotel", 28);
  const ref = gsmSafe(b.booking_reference);
  const link = input.siteHost && HOST.test(input.siteHost) ? `${input.scheme}://${input.siteHost}/booking/find` : null;
  const checkIn = formatTime(b.check_in_time);
  let text: string;
  switch (input.kind) {
    case "booking_confirmed":
      text = `${hotel}: booking ${ref} confirmed, ${shortDate(b.arrival_date)} to ${shortDate(b.departure_date)}. Check-in from ${checkIn}.${link ? ` Details: ${link}` : ""}`;
      break;
    case "arrival_reminder": {
      const phone = input.hotelPhone ? gsmSafe(input.hotelPhone) : "";
      text = `${hotel}: see you on ${shortDate(b.arrival_date)}! Check-in from ${checkIn}. Booking ${ref}.${phone ? ` Call ${phone}.` : ""}`;
      break;
    }
    case "review_request":
      text = `${hotel}: thank you for staying with us. Tell us how it went${link ? `: ${link}` : "."} (booking ${ref})`;
      break;
  }
  return text.replace(/\s+/g, " ").trim();
}
