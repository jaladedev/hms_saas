/**
 * The room calendar (a tape chart): rooms down the side, nights across. Pure functions, so they can be tested.
 * A claim covers the nights from start_date up to, but not including, end_date, so a stay arriving on the 5th and leaving
 * on the 8th is drawn over the 5th, 6th and 7th. The departure day stays free for the next guest.
 */
import { addDays } from "./transfer";
import { parseIsoDate } from "./reservations";
import { compareRoomNumbers, type BoardClaim, type BoardRoom } from "./room-board";

export const WINDOW_CHOICES = [7, 14, 30] as const;
export const DEFAULT_WINDOW = 14;

export type CalendarWindow = { start: string; days: number; end: string };

/** ?from=&days= from the URL. A bad date gives today, a bad length gives 14 days. `end` is the day after the last night shown. */
export function parseWindow(from: unknown, days: unknown, today: string): CalendarWindow {
  const start = parseIsoDate(typeof from === "string" ? from : undefined) ?? today;
  const n = Number(typeof days === "string" ? days : NaN);
  const length = (WINDOW_CHOICES as readonly number[]).includes(n) ? n : DEFAULT_WINDOW;
  return { start, days: length, end: addDays(start, length) };
}

export type DayHead = {
  date: string;
  day: number;
  weekday: string;
  month: string;
  isToday: boolean;
  isWeekend: boolean;
  monthStart: boolean;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function dayHeads(w: CalendarWindow, today: string): DayHead[] {
  return Array.from({ length: w.days }, (_, i) => {
    const date = addDays(w.start, i);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    return {
      date,
      day: Number(date.slice(8)),
      weekday: WEEKDAYS[dow]!,
      month: MONTHS[Number(date.slice(5, 7)) - 1]!,
      isToday: date === today,
      isWeekend: dow === 0 || dow === 6,
      monthStart: date.endsWith("-01") || i === 0,
    };
  });
}

export type Bar = {
  claim: BoardClaim;
  /** 1-based grid column of the first night shown, and how many nights are shown. */
  column: number;
  span: number;
  /** The claim carries on beyond the left or right edge of the window. */
  continuesBefore: boolean;
  continuesAfter: boolean;
  kind: "occupied" | "arriving" | "held" | "blocked";
};

export type CalendarRow = { room: BoardRoom; bars: Bar[] };

/** Cuts a claim to the window; null when it does not touch it. Claims are [start_date, end_date). */
export function clip(claim: BoardClaim, w: CalendarWindow): Pick<Bar, "column" | "span" | "continuesBefore" | "continuesAfter"> | null {
  if (claim.end_date <= w.start || claim.start_date >= w.end) return null;
  const from = claim.start_date < w.start ? w.start : claim.start_date;
  const to = claim.end_date > w.end ? w.end : claim.end_date;
  const column = Math.round((Date.parse(`${from}T00:00:00Z`) - Date.parse(`${w.start}T00:00:00Z`)) / 86_400_000) + 1;
  const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  return { column, span, continuesBefore: claim.start_date < w.start, continuesAfter: claim.end_date > w.end };
}

const kindOf = (c: BoardClaim): Bar["kind"] =>
  c.claim_type === "block" ? "blocked" : c.claim_type === "hold" ? "held" : c.checked_in === true ? "occupied" : "arriving";

/** One row for each room that is not retired, in natural room-number order within the room type, with its bars in date order. */
export function buildRows(rooms: BoardRoom[], claims: BoardClaim[], w: CalendarWindow): CalendarRow[] {
  const byRoom = new Map<string, Bar[]>();
  for (const claim of claims) {
    const cut = clip(claim, w);
    if (!cut) continue;
    byRoom.set(claim.room_id, [...(byRoom.get(claim.room_id) ?? []), { claim, ...cut, kind: kindOf(claim) }]);
  }
  return rooms
    .filter((r) => r.operational_status !== "retired")
    .map((room) => ({ room, bars: (byRoom.get(room.id) ?? []).sort((a, b) => a.column - b.column) }))
    .sort(
      (a, b) =>
        (a.room.room_type_name ?? "").localeCompare(b.room.room_type_name ?? "", "en") ||
        compareRoomNumbers(a.room.room_number, b.room.room_number),
    );
}

/** Rooms with a stay on each night of the window (holds and blocks are not stays), and how many rooms could be sold: in service and not blocked. */
export function nightTotals(rows: CalendarRow[], w: CalendarWindow): { date: string; stays: number; sellable: number }[] {
  return Array.from({ length: w.days }, (_, i) => {
    const col = i + 1;
    let stays = 0;
    let sellable = 0;
    for (const r of rows) {
      const bar = r.bars.find((b) => col >= b.column && col < b.column + b.span);
      if (bar && (bar.kind === "occupied" || bar.kind === "arriving")) stays += 1;
      if (r.room.operational_status === "active" && bar?.kind !== "blocked") sellable += 1;
    }
    return { date: addDays(w.start, i), stays, sellable };
  });
}

/** The window a Previous or Next link goes to, one whole window away. */
export const shiftStart = (w: CalendarWindow, direction: -1 | 1): string => addDays(w.start, direction * w.days);

export const KIND_LABEL: Record<Bar["kind"], string> = { occupied: "In house", arriving: "Booked", held: "On hold", blocked: "Blocked" };
