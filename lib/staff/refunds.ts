/** Shared types and rules for the staff refund screens. Pure functions only, so they can be tested. */

export type RefundStatus = "requested" | "approved" | "rejected" | "processing" | "succeeded" | "failed";

export type RefundRow = {
  id: string;
  reservation_id: string;
  payment_id: string;
  internal_reference: string;
  amount_minor: number;
  currency: string;
  refund_status: RefundStatus;
  reason: string;
  requested_by: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  payout_reference: string | null;
  failure_reason: string | null;
  attention_note: string | null;
  provider_call_started_at: string | null;
  created_at: string;
  completed_at: string | null;
};

/** A processing refund with no verdict after this long is shown as stuck. Matches stale_processing_refunds' default. */
export const STUCK_AFTER_MINUTES = 120;

export function minutesSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor((now.getTime() - t) / 60000);
}

/** True when a person has to look at this refund outside the normal flow. */
export function needsAttention(r: RefundRow, now: Date): boolean {
  if (r.refund_status !== "processing") return false;
  if (r.attention_note) return true;
  const mins = minutesSince(r.provider_call_started_at, now);
  return mins !== null && mins >= STUCK_AFTER_MINUTES;
}

export type QueueGroups = {
  attention: RefundRow[];
  awaitingApproval: RefundRow[];
  readyToPay: RefundRow[];
  processing: RefundRow[];
  closed: RefundRow[];
};

/** Every refund lands in exactly one group. Oldest first within the open groups, newest first when closed. */
export function groupQueue(rows: RefundRow[], now: Date): QueueGroups {
  const byOldest = (a: RefundRow, b: RefundRow) => a.created_at.localeCompare(b.created_at);
  const g: QueueGroups = { attention: [], awaitingApproval: [], readyToPay: [], processing: [], closed: [] };
  for (const r of rows) {
    if (needsAttention(r, now)) g.attention.push(r);
    else if (r.refund_status === "requested") g.awaitingApproval.push(r);
    else if (r.refund_status === "approved") g.readyToPay.push(r);
    else if (r.refund_status === "processing") g.processing.push(r);
    else g.closed.push(r);
  }
  g.attention.sort(byOldest);
  g.awaitingApproval.sort(byOldest);
  g.readyToPay.sort(byOldest);
  g.processing.sort(byOldest);
  g.closed.sort((a, b) => (b.completed_at ?? b.created_at).localeCompare(a.completed_at ?? a.created_at));
  return g;
}

export type RefundAction =
  | { kind: "decide" }              // approve or reject
  | { kind: "own_request" }         // the viewer asked for it, so someone else must decide
  | { kind: "manual_payout" }       // staff paid cash / transfer / POS back and record it
  | { kind: "provider_payout" }     // pay out through the provider
  | { kind: "wait" }                // provider call in flight, nothing for staff to do
  | { kind: "none" };

/**
 * What the signed-in person can do with a refund. This only decides which controls to show: the
 * database enforces the same rules (self-approval, permission, state) on every call.
 */
export function availableAction(r: RefundRow, paymentProvider: string | null, viewerId: string | null): RefundAction {
  if (r.refund_status === "requested") {
    return viewerId !== null && r.requested_by === viewerId ? { kind: "own_request" } : { kind: "decide" };
  }
  if (r.refund_status === "approved") {
    return paymentProvider === "manual" ? { kind: "manual_payout" } : { kind: "provider_payout" };
  }
  if (r.refund_status === "processing") return { kind: "wait" };
  return { kind: "none" };
}

/** How much of a payment can still be refunded: the payment less every live or completed refund. */
export function refundableMinor(paymentAmountMinor: number, refunds: Pick<RefundRow, "amount_minor" | "refund_status">[]): number {
  const live = refunds
    .filter((r) => r.refund_status === "requested" || r.refund_status === "approved" || r.refund_status === "processing" || r.refund_status === "succeeded")
    .reduce((sum, r) => sum + r.amount_minor, 0);
  return Math.max(paymentAmountMinor - live, 0);
}

/** Short codes carried in the redirect URL after an action; the page turns them into sentences. */
export type ErrorCode =
  | "self_approval" | "exceeds" | "invalid_state" | "not_found" | "reason_required" | "note_required"
  | "amount_invalid" | "provider_payment" | "hold_inactive" | "bad_request" | "unknown"
  | "room_not_ready" | "room_not_active" | "payment_required" | "early_checkin" | "stay_ended" | "no_stay_claim"
  | "overpayment" | "method_invalid" | "not_cancellable"
  | "room_unavailable" | "capacity" | "rate_missing" | "forbidden" | "arrival_past" | "dates_invalid"
  | "guest_name_required" | "too_long_stay" | "room_type_missing" | "guest_failed"
  | "block_conflict" | "block_past" | "block_invalid" | "room_retired"
  | "invoice_exists" | "invoice_has_payments" | "invoice_void"
  | "transfer_unavailable" | "transfer_past" | "transfer_outside" | "transfer_bad_room";

/**
 * Maps a database error message to a code, and an amount when the database reports one. The amount
 * rides in `refundableMinor` for both refunds (what is left to refund) and overpayments (what is
 * still outstanding); the code tells the page which sentence to use.
 */
export function classifyRpcError(message: string): { code: ErrorCode; refundableMinor?: number } {
  if (/SELF_APPROVAL/.test(message)) return { code: "self_approval" };
  const exceeds = /REFUND_EXCEEDS_PAYMENT refundable (\d+)/.exec(message);
  if (exceeds) return { code: "exceeds", refundableMinor: Number(exceeds[1]) };
  if (/note required to reject/.test(message)) return { code: "note_required" };
  if (/reason required/.test(message)) return { code: "reason_required" };
  if (/amount must be positive/.test(message)) return { code: "amount_invalid" };
  if (/refunded through the provider|provider payments/.test(message)) return { code: "provider_payment" };
  if (/hold is no longer active/.test(message)) return { code: "hold_inactive" };
  const over = /OVERPAYMENT outstanding (\d+)/.exec(message);
  if (over) return { code: "overpayment", refundableMinor: Number(over[1]) };
  if (/payment method/.test(message)) return { code: "method_invalid" };
  if (/ROOM_NOT_READY/.test(message)) return { code: "room_not_ready" };
  if (/ROOM_NOT_ACTIVE/.test(message)) return { code: "room_not_active" };
  if (/PAYMENT_REQUIRED/.test(message)) return { code: "payment_required" };
  if (/EARLY_CHECKIN_NOT_SUPPORTED/.test(message)) return { code: "early_checkin" };
  if (/stay already ended/.test(message)) return { code: "stay_ended" };
  if (/no stay claim for today/.test(message)) return { code: "no_stay_claim" };
  if (/block cannot start in the past/.test(message)) return { code: "block_past" };
  if (/invalid block request/.test(message)) return { code: "block_invalid" };
  if (/room retired/.test(message)) return { code: "room_retired" };
  if (/housekeeping status/.test(message)) return { code: "bad_request" };
  if (/effective date is in the past/.test(message)) return { code: "transfer_past" };
  if (/effective date is outside the stay/.test(message)) return { code: "transfer_outside" };
  if (/invalid target room/.test(message)) return { code: "transfer_bad_room" };
  if (/ROOM_UNAVAILABLE/.test(message)) return { code: "room_unavailable" };
  if (/CAPACITY_EXCEEDED/.test(message)) return { code: "capacity" };
  if (/RATE_MISSING/.test(message)) return { code: "rate_missing" };
  if (/FORBIDDEN/.test(message)) return { code: "forbidden" };
  if (/arrival in the past/.test(message)) return { code: "arrival_past" };
  if (/departure must follow/.test(message)) return { code: "dates_invalid" };
  if (/NOT_FOUND: room type|NOT_FOUND: property/.test(message)) return { code: "room_type_missing" };
  if (/invoice exists/.test(message)) return { code: "invoice_exists" };
  if (/invoice has payments/.test(message)) return { code: "invoice_has_payments" };
  if (/INVALID_STATE: void/.test(message)) return { code: "invoice_void" };
  if (/INVALID_STATE/.test(message)) return { code: "invalid_state" };
  if (/NOT_FOUND/.test(message)) return { code: "not_found" };
  return { code: "unknown" };
}

export const OK_MESSAGES = {
  approved: "Refund approved. It is ready to pay out.",
  rejected: "Refund rejected.",
  paid_out: "Payout recorded. The reservation's balance has been updated.",
  requested: "Refund requested. A second person with approval rights must now approve it.",
  resent: "Email put back in the queue and a send was started. Reload in a minute to see whether it went through.",
  cancelled: "Reservation cancelled. The rooms are free again and any money held has been settled below.",
  checked_in: "Room checked in.",
  checked_out: "Room checked out. It is now marked dirty for housekeeping.",
  payment_recorded: "Payment recorded.",
  created: "Reservation created and confirmed. The room is held for the guest.",
  housekeeping_set: "Room status updated.",
  blocked: "Room blocked for those dates.",
  block_released: "Block removed. The room can be booked again.",
  invoice_issued: "Invoice issued.",
  invoice_voided: "Invoice voided.",
  transferred: "Room changed. The booking shows the new room below. If the guest was in the old room, it is now marked dirty.",
} as const;
export type OkCode = keyof typeof OK_MESSAGES;

export function errorMessage(code: string, refundable: number | null, formatMinor: (minor: number) => string): string {
  switch (code as ErrorCode) {
    case "self_approval": return "You requested this refund, so someone else has to decide it.";
    case "exceeds": return refundable !== null ? `That is more than can be refunded on this payment. At most ${formatMinor(refundable)} is left.` : "That is more than can be refunded on this payment.";
    case "invalid_state": return "That item has already moved on. The page now shows where it stands.";
    case "not_found": return "That item was not found, or you do not have access to it.";
    case "reason_required": return "A reason is required.";
    case "note_required": return "A note is required when rejecting a refund.";
    case "amount_invalid": return "Enter an amount such as 12,500 or 12500.50.";
    case "hold_inactive": return "This room is no longer on hold, so telling the guest it is would be wrong. The email was not resent.";
    case "room_not_ready": return "The room is not clean yet. Check the guest in anyway only with an override reason.";
    case "room_not_active": return "That room is out of service. Move the guest to another room first.";
    case "payment_required": return "This booking must be paid in full before check-in. A person with payment approval rights can override it with a reason.";
    case "early_checkin": return "The guest cannot be checked in before the arrival date yet.";
    case "stay_ended": return "The departure date has passed, so this room cannot be checked in.";
    case "no_stay_claim": return "No room is assigned for tonight. Check the room assignment first.";
    case "overpayment": return refundable !== null ? `That is more than is owed. At most ${formatMinor(refundable)} is outstanding.` : "That is more than is owed on this reservation.";
    case "method_invalid": return "Choose how the money was received.";
    case "not_cancellable": return "This reservation can no longer be cancelled because a guest has already checked in or it has ended.";
    case "room_unavailable": return "No room of that type is free for all of those nights. Try other dates or another room type.";
    case "capacity": return "That room type cannot take that many adults and children.";
    case "rate_missing": return "There is no rate set for those dates, so the price cannot be worked out. Set the rates first.";
    case "forbidden": return "You do not have permission to create reservations at this property.";
    case "arrival_past": return "The arrival date is already past. Choose today or a later date.";
    case "dates_invalid": return "The departure date must be after the arrival date.";
    case "too_long_stay": return "Stays are limited to 30 nights. Create a shorter booking and extend it later.";
    case "guest_name_required": return "Enter the guest's name.";
    case "room_type_missing": return "That room type or property is no longer available. Reload the form.";
    case "guest_failed": return "The guest could not be saved. Check the email and phone number and try again.";
    case "invoice_exists": return "This reservation already has an invoice. Void it first if it needs to be reissued.";
    case "invoice_has_payments": return "This invoice has payments recorded against it, so it cannot be voided. Refund the guest first; once no money is held it can be voided.";
    case "invoice_void": return "That invoice is already void.";
    case "transfer_unavailable": return "No room was free for the rest of the stay from that date, so nothing was changed and the guest keeps the current room. Choose a later date or a different room.";
    case "transfer_past": return "The move cannot start before today.";
    case "transfer_outside": return "That date is outside this room's stay. Choose a night the guest is booked in.";
    case "transfer_bad_room": return "That room cannot be used for this move. Choose a different room.";
    case "block_conflict": return refundable !== null ? `${refundable} ${refundable === 1 ? "booking is" : "bookings are"} already on that room for those dates, so it was not blocked. Move ${refundable === 1 ? "it" : "them"} first.` : "Bookings are already on that room for those dates, so it was not blocked.";
    case "block_past": return "A block cannot start in the past. Choose today or a later date.";
    case "block_invalid": return "Enter a reason and an end date after the start date.";
    case "room_retired": return "That room is retired, so it cannot be changed.";
    case "provider_payment": return "Card and online payments are paid out through the provider, not recorded by hand.";
    case "bad_request": return "The form was incomplete. Reload the page and try again.";
    default: return "Something went wrong. Nothing was changed; try again, and tell a developer if it keeps happening.";
  }
}
