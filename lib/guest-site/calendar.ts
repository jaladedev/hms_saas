/** An iCalendar (.ics) file for a booking, so a guest can add the stay to a phone or desktop calendar. */

export type CalendarStay = {
  reference: string;
  hotelName: string;
  place: string | null;
  arrivalDate: string; // YYYY-MM-DD
  departureDate: string; // YYYY-MM-DD, the check-out day
  checkInTime: string; // "14:00:00"
  checkOutTime: string;
  rooms: string[]; // "Standard Room: 2 adults"
};

/** Text values: backslash, semicolon, comma and line breaks are escaped (RFC 5545 section 3.3.11). */
export function escapeIcsText(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/;/g, ";").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Lines longer than 75 bytes are folded: a CRLF and one space, never inside a multi-byte character. */
export function foldIcsLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) {
      parts.push(cur);
      cur = "";
      curBytes = 0;
      limit = 74; // the leading space counts
    }
    cur += ch;
    curBytes += b;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

const compactDate = (iso: string) => iso.replace(/-/g, "");

/** "2026-11-12T10:15:00.000Z" to "20261112T101500Z". */
function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** The stay as one all-day event from the arrival day to the day before departure's end (DTEND is the day after the last night, which is the check-out day). */
export function bookingIcs(stay: CalendarStay, now: Date = new Date()): string {
  const description = [
    `Booking ${stay.reference}`,
    `Check in from ${stay.checkInTime.slice(0, 5)}, check out by ${stay.checkOutTime.slice(0, 5)}.`,
    ...stay.rooms,
  ].join("\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Hotel booking//Guest site//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(stay.reference)}@booking`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART;VALUE=DATE:${compactDate(stay.arrivalDate)}`,
    `DTEND;VALUE=DATE:${compactDate(stay.departureDate)}`,
    `SUMMARY:${escapeIcsText(`Stay at ${stay.hotelName}`)}`,
    ...(stay.place ? [`LOCATION:${escapeIcsText(stay.place)}`] : []),
    `DESCRIPTION:${escapeIcsText(description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

/** A file name that is safe on every system: letters, digits and hyphens from the booking reference. */
export function icsFileName(reference: string): string {
  const safe = reference.replace(/[^A-Za-z0-9-]/g, "").slice(0, 40);
  return `booking-${safe || "stay"}.ics`;
}
