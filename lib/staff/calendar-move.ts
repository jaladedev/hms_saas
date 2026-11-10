/**
 * Moving a guest to another room by dragging a bar on the room calendar. Pure rules, so they can be tested; the page only
 * offers a drag where these say yes, and transfer_room (008) decides again on submit: permission, same hotel, dates, availability.
 * A move is the same operation as "Move to another room" on the booking page: the rest of the stay in that room, from a date,
 * goes to another room of the SAME type (the price does not change), all or nothing.
 */
import { addDays } from "./transfer";

export type MovableClaim = { claim_type: string; end_date: string; reservation_room_id: string | null };

/**
 * A stay or a hold of a booking the viewer can see (the board view gives no booking id without reservation.view), with at
 * least one night left today or later, and a viewer who may assign rooms. Blocks and past stays do not move.
 */
export function canMoveBar(c: MovableClaim, today: string, mayAssign: boolean): boolean {
  return mayAssign && c.reservation_room_id !== null && (c.claim_type === "stay" || c.claim_type === "hold") && c.end_date > today;
}

export type DropRoom = { id: string; room_type_id: string; operational_status: string };

/** Only another room of the same type that is in service. A busy room is allowed here: the database says no if it is taken. */
export function canDropOn(source: { roomId: string; roomTypeId: string }, target: DropRoom): boolean {
  return target.id !== source.roomId && target.room_type_id === source.roomTypeId && target.operational_status === "active";
}

/**
 * The first night that moves. Dropping on a night inside what is left of the stay (today or later, before departure) moves
 * from that night; anywhere else moves everything that is left. Null when no night is left.
 */
export function moveEffective(start: string, end: string, today: string, dropped: string | null): string | null {
  const first = start > today ? start : today;
  if (first >= end) return null;
  return dropped !== null && dropped >= first && dropped < end ? dropped : first;
}

/** The sentence the confirmation shows. `from` is the room the bar sits on, `to` the room it was dropped on. */
export function moveSummary(p: {
  label: string;
  from: string;
  to: string;
  effective: string;
  start: string;
  end: string;
  dateText: (iso: string) => string;
}): string {
  const nights = Math.round((Date.parse(`${p.end}T00:00:00Z`) - Date.parse(`${p.effective}T00:00:00Z`)) / 86_400_000);
  const part = p.effective === p.start ? "the whole of this room's stay" : `the stay from ${p.dateText(p.effective)}`;
  return `Move ${p.label} from room ${p.from} to room ${p.to}: ${part}, ${nights} ${nights === 1 ? "night" : "nights"}, leaving ${p.dateText(p.end)}. Earlier nights stay where they are. If room ${p.to} is taken for any of those nights, nothing changes.`;
}

/** The last night that moves, for display and tests. */
export const lastMovedNight = (end: string): string => addDays(end, -1);
