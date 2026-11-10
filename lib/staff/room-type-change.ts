/** Rules for moving a guest to a different room type (migration 083). Pure; the database enforces the same rules. */
import { transferWindow, type TransferWindow } from "./transfer";

export type TypeOption = { id: string; name: string; status: string };

/**
 * Whether to offer the change: the person may assign rooms, the booking is confirmed or the guest is in the house, this room
 * is not checked out, and the booking has no discount (re-pricing a discount is not done; the database refuses it too).
 * A held, unpaid online booking is not offered: it has no price agreed yet.
 */
export function canChangeType(roomStatus: string, reservationStatus: string, mayAssign: boolean, hasDiscount: boolean): boolean {
  return (
    mayAssign &&
    !hasDiscount &&
    (roomStatus === "booked" || roomStatus === "checked_in") &&
    (reservationStatus === "confirmed" || reservationStatus === "checked_in")
  );
}

/** The first night in the new type can be today (or the arrival) up to the last night. Same window as a room move. */
export const typeChangeWindow = (arrival: string, departure: string, today: string): TransferWindow | null =>
  transferWindow(arrival, departure, today);

/** Other types in service, by name. */
export function otherTypes(types: TypeOption[], currentId: string): TypeOption[] {
  return types.filter((t) => t.status === "active" && t.id !== currentId).sort((a, b) => a.name.localeCompare(b.name));
}

/** Which refusal the database gave, as a code the page words. Null means: use the general classifier. */
export function typeChangeError(message: string): "rt_discount" | "rt_busy" | "rt_same" | "rt_effective" | null {
  if (/POLICY_VIOLATION: discount/.test(message)) return "rt_discount";
  if (/INVALID_STATE: payment started/.test(message)) return "rt_busy";
  if (/POLICY_VIOLATION: same room type/.test(message)) return "rt_same";
  if (/POLICY_VIOLATION: effective date\s*$/.test(message.trim())) return "rt_effective";
  return null;
}
