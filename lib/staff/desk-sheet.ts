import type { DeskGroups, DeskRow } from "./front-desk";
import { deskFlag } from "./front-desk";
import { PAYMENT_LABEL, nightsBetween } from "./reservations";

/**
 * The printable front desk sheet (TODO "Unreliable internet", offline step 2b: the paper fallback). Pure functions, so they can be
 * tested; the page reads the data and prints what these return. The sheet carries what the desk needs when the screen is gone: who
 * arrives, who is in the hotel, who leaves, in which room, and whether they have paid. It never shows a price, a phone number or an
 * ID, because a printed sheet is left on a desk.
 */

/** One reservation room as the sheet needs it: its number once assigned (null before), and how many people. */
export type SheetRoom = { reservationId: string; roomNumber: string | null; adults: number; children: number };

export type SheetRow = {
  id: string;
  propertyId: string;
  reference: string;
  guest: string;
  /** "204", "204, 205" or "Not assigned yet". */
  rooms: string;
  /** "2 adults", "2 adults, 1 child", or "" when nothing is known. */
  people: string;
  arrival: string;
  departure: string;
  nights: number;
  /** "Paid", "Unpaid", "Part paid" and so on. */
  payment: string;
  /** "Needs attention" or null. Money flags are in `payment`. */
  attention: boolean;
};

export type SheetSection = { key: "arrivals" | "inHouse" | "departures" | "problems"; title: string; hint?: string; rows: SheetRow[] };

const UNASSIGNED = "Not assigned yet";

/** Room order for the paper: by room number, naturally ("9" before "10"); bookings with no room yet last; then by booking reference. */
function byRoom(a: SheetRow, b: SheetRow): number {
  const au = a.rooms === UNASSIGNED,
    bu = b.rooms === UNASSIGNED;
  if (au !== bu) return au ? 1 : -1;
  return a.rooms.localeCompare(b.rooms, undefined, { numeric: true }) || a.reference.localeCompare(b.reference);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 adults, 1 child". Counts across all of a reservation's rooms; cancelled rooms are the caller's to leave out. */
export function peopleLabel(rooms: Pick<SheetRoom, "adults" | "children">[]): string {
  const adults = rooms.reduce((s, r) => s + r.adults, 0);
  const children = rooms.reduce((s, r) => s + r.children, 0);
  if (adults + children === 0) return "";
  return children > 0
    ? `${plural(adults, "adult", "adults")}, ${plural(children, "child", "children")}`
    : plural(adults, "adult", "adults");
}

/** Room numbers in a natural order ("9" before "10"), each once. */
export function roomsLabel(numbers: (string | null)[]): string {
  const real = [...new Set(numbers.filter((n): n is string => Boolean(n && n.trim())).map((n) => n.trim()))];
  if (real.length === 0) return UNASSIGNED;
  return real.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(", ");
}

/**
 * Turns the front desk groups into the sheet's sections. `guests` maps a guest id to a name (empty without permission, and the row
 * then shows the booking reference alone); `rooms` are the reservation rooms to show. Arrivals, in house and departures are separate
 * lists: a multi-room booking can be in both arrivals and in house, as on the screen.
 */
export function buildSheet(input: { groups: DeskGroups; guestOf: (r: DeskRow) => string; rooms: SheetRoom[] }): SheetSection[] {
  const byRes = new Map<string, SheetRoom[]>();
  for (const r of input.rooms) byRes.set(r.reservationId, [...(byRes.get(r.reservationId) ?? []), r]);

  const toRow = (r: DeskRow): SheetRow => {
    const mine = byRes.get(r.id) ?? [];
    return {
      id: r.id,
      propertyId: r.property_id,
      reference: r.booking_reference,
      guest: input.guestOf(r),
      rooms: roomsLabel(mine.map((m) => m.roomNumber)),
      people: peopleLabel(mine),
      arrival: r.arrival_date,
      departure: r.departure_date,
      nights: nightsBetween(r.arrival_date, r.departure_date),
      payment: PAYMENT_LABEL[r.payment_status] ?? r.payment_status.replace(/_/g, " "),
      attention: deskFlag(r) === "Needs attention",
    };
  };

  const g = input.groups;
  const list = (rows: DeskRow[]) => rows.map(toRow).sort(byRoom);
  return [
    { key: "arrivals", title: "Arriving today", rows: list(g.arrivals) },
    { key: "inHouse", title: "In house", rows: list(g.inHouse) },
    { key: "departures", title: "Departing today", rows: list(g.departures) },
    {
      key: "problems",
      title: "Overdue and late",
      hint: "Still in house past their departure date, or expected before today and not checked in.",
      rows: list([...g.overdue, ...g.lateArrivals]),
    },
  ];
}

/** A stay claim as the sheet reads it. */
export type SheetClaim = { room_id: string; start_date: string; end_date: string };

/**
 * The physical room a reservation room is in on `today`: the stay claim covering today (arrival inclusive, departure exclusive), or,
 * for an overdue or late booking whose claim does not cover today, the one that ends last. Null when it has no claim, so the sheet
 * says "Not assigned yet" instead of guessing.
 */
export function currentRoomId(claims: SheetClaim[], today: string): string | null {
  if (claims.length === 0) return null;
  const covering = claims.find((c) => c.start_date <= today && c.end_date > today);
  if (covering) return covering.room_id;
  return [...claims].sort((a, b) => b.end_date.localeCompare(a.end_date) || b.start_date.localeCompare(a.start_date))[0]?.room_id ?? null;
}
