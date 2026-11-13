import { resetErrorMessage } from "./auth";
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
  /** Paystack asked for the customer's bank details (migration 022). Optional: not every query selects it. */
  needs_bank_details?: boolean;
  details_retry_started_at?: string | null;
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
  | { kind: "decide" } // approve or reject
  | { kind: "own_request" } // the viewer asked for it, so someone else must decide
  | { kind: "manual_payout" } // staff paid cash / transfer / POS back and record it
  | { kind: "provider_payout" } // pay out through the provider
  | { kind: "bank_details" } // Paystack needs the customer's bank details to finish the refund
  | { kind: "wait" } // provider call in flight, nothing for staff to do
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
  if (r.refund_status === "processing") {
    // Once the details were sent, a person only waits (or checks Paystack when the answer was unclear).
    if (r.needs_bank_details === true && !r.details_retry_started_at) return { kind: "bank_details" };
    return { kind: "wait" };
  }
  return { kind: "none" };
}

/** How much of a payment can still be refunded: the payment less every live or completed refund. */
export function refundableMinor(paymentAmountMinor: number, refunds: Pick<RefundRow, "amount_minor" | "refund_status">[]): number {
  const live = refunds
    .filter(
      (r) =>
        r.refund_status === "requested" ||
        r.refund_status === "approved" ||
        r.refund_status === "processing" ||
        r.refund_status === "succeeded",
    )
    .reduce((sum, r) => sum + r.amount_minor, 0);
  return Math.max(paymentAmountMinor - live, 0);
}

/** Short codes carried in the redirect URL after an action; the page turns them into sentences. */
export type ErrorCode =
  | "self_approval"
  | "exceeds"
  | "invalid_state"
  | "not_found"
  | "reason_required"
  | "note_required"
  | "amount_invalid"
  | "provider_payment"
  | "hold_inactive"
  | "bad_request"
  | "unknown"
  | "room_not_ready"
  | "room_not_active"
  | "payment_required"
  | "early_checkin"
  | "early_checkin_too_early"
  | "waiver_forbidden"
  | "waiver_discount"
  | "stay_ended"
  | "no_stay_claim"
  | "overpayment"
  | "method_invalid"
  | "not_cancellable"
  | "room_unavailable"
  | "room_choice"
  | "capacity"
  | "rate_missing"
  | "forbidden"
  | "arrival_past"
  | "dates_invalid"
  | "guest_name_required"
  | "too_long_stay"
  | "room_type_missing"
  | "guest_failed"
  | "role_name"
  | "role_name_taken"
  | "role_permissions"
  | "role_limit"
  | "role_in_use"
  | "request_note"
  | "block_conflict"
  | "block_in_house"
  | "block_past"
  | "block_invalid"
  | "room_retired"
  | "invoice_exists"
  | "invoice_has_payments"
  | "invoice_void"
  | "transfer_unavailable"
  | "transfer_past"
  | "transfer_outside"
  | "transfer_bad_room"
  | "guest_name"
  | "guest_email"
  | "guest_country"
  | "guest_field"
  | "guest_notes"
  | "profile_name"
  | "profile_phone"
  | "profile_density"
  | "wrong_password"
  | "pw_mismatch"
  | "pw_short"
  | "pw_long"
  | "pw_same"
  | "pw_weak"
  | "pw_failed"
  | "role_escalation"
  | "self_change"
  | "last_owner"
  | "staff_suspended"
  | "staff_revoked"
  | "staff_property"
  | "invite_failed"
  | "email_invalid"
  | "rate_range_invalid"
  | "rate_range_long"
  | "rate_forbidden"
  | "rate_no_plan"
  | "tax_forbidden"
  | "tax_not_percent"
  | "tax_not_found"
  | "tax_invalid"
  | "tax_duplicate"
  | "policy_forbidden"
  | "policy_conflict"
  | "policy_invalid"
  | "policy_rules"
  | "policy_deposit"
  | "policy_date"
  | "policy_past"
  | "policy_order"
  | "setup_invalid"
  | "theme_color"
  | "theme_contrast"
  | "theme_font"
  | "theme_radius"
  | "offer_invalid"
  | "review_invalid"
  | "offer_dates"
  | "offer_limit"
  | "place_invalid"
  | "place_limit"
  | "invoice_pay_unavailable"
  | "invoice_pay_failed"
  | "invoice_pay_closed"
  | "invoice_pay_review"
  | "setup_duplicate_code"
  | "setup_duplicate_name"
  | "setup_duplicate_room"
  | "setup_forbidden"
  | "room_has_bookings"
  | "photo_file"
  | "photo_limit"
  | "photo_upload"
  | "task_taken"
  | "task_forbidden"
  | "task_assignee"
  | "task_reason"
  | "task_invalid"
  | "mt_taken"
  | "mt_forbidden"
  | "mt_assignee"
  | "mt_reason"
  | "mt_place"
  | "mt_block"
  | "mt_invalid"
  | "mt_duplicate"
  | "fo_category"
  | "fo_description"
  | "fo_quantity"
  | "fo_amount"
  | "fo_date"
  | "fo_room"
  | "fo_reason"
  | "fo_method"
  | "fo_too_long"
  | "fo_overpay"
  | "fo_not_open"
  | "fo_paid"
  | "fo_not_found"
  | "fo_duplicate"
  | "fo_unknown"
  | "fo_on_invoice"
  | "fo_nothing"
  | "fo_no_email"
  | "fo_invoice_void"
  | "se_dates"
  | "se_too_long"
  | "se_reason"
  | "se_room"
  | "se_capacity"
  | "se_arrival_past"
  | "se_unavailable"
  | "se_rate"
  | "se_paid"
  | "se_invoiced"
  | "dc_percent"
  | "dc_amount"
  | "dc_reason"
  | "gl_reason"
  | "dc_limit"
  | "dc_status"
  | "dc_cap_percent"
  | "dc_cap_role"
  | "se_payment_started"
  | "se_split"
  | "se_not_editable"
  | "se_discount"
  | "se_not_found"
  | "se_duplicate"
  | "se_unknown"
  | "hold_lapsed"
  | "hold_source"
  | "ns_early"
  | "ns_note"
  | "rt_discount"
  | "rt_busy"
  | "rt_same"
  | "rt_effective";

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
  if (/POLICY_VIOLATION: waiver/.test(message)) return { code: "waiver_forbidden" };
  if (/POLICY_VIOLATION: discount limit/.test(message)) return { code: "dc_limit" };
  if (/POLICY_VIOLATION: discount$/.test(message.trim())) return { code: "waiver_discount" };
  if (/EARLY_CHECKIN_TOO_EARLY/.test(message)) return { code: "early_checkin_too_early" };
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
  if (/POLICY_VIOLATION: name taken/.test(message)) return { code: "role_name_taken" };
  if (/POLICY_VIOLATION: permissions/.test(message)) return { code: "role_permissions" };
  if (/POLICY_VIOLATION: too many roles/.test(message)) return { code: "role_limit" };
  if (/INVALID_STATE: in use/.test(message)) return { code: "role_in_use" };
  if (/POLICY_VIOLATION: outcome/.test(message)) return { code: "request_note" };
  if (/FORBIDDEN/.test(message)) return { code: "forbidden" };
  if (/arrival in the past/.test(message)) return { code: "arrival_past" };
  if (/departure must follow/.test(message)) return { code: "dates_invalid" };
  if (/NOT_FOUND: requested room/.test(message)) return { code: "room_choice" };
  if (/NOT_FOUND: room type|NOT_FOUND: property/.test(message)) return { code: "room_type_missing" };
  if (/invoice exists/.test(message)) return { code: "invoice_exists" };
  if (/invoice has payments/.test(message)) return { code: "invoice_has_payments" };
  if (/POLICY_VIOLATION: name/.test(message)) return { code: "guest_name" };
  if (/POLICY_VIOLATION: email/.test(message)) return { code: "guest_email" };
  if (/POLICY_VIOLATION: country/.test(message)) return { code: "guest_country" };
  if (/POLICY_VIOLATION: too long/.test(message)) return { code: "guest_field" };
  if (/POLICY_VIOLATION: notes/.test(message)) return { code: "guest_notes" };
  if (/ROLE_ESCALATION/.test(message)) return { code: "role_escalation" };
  if (/SELF_CHANGE/.test(message)) return { code: "self_change" };
  if (/LAST_OWNER/.test(message)) return { code: "last_owner" };
  if (/INVALID_STATE: suspended/.test(message)) return { code: "staff_suspended" };
  if (/INVALID_STATE: revoked/.test(message)) return { code: "staff_revoked" };
  if (/POLICY_VIOLATION: property/.test(message)) return { code: "staff_property" };
  if (/POLICY_VIOLATION: status/.test(message)) return { code: "bad_request" };
  if (/INVALID_STATE: too early/.test(message)) return { code: "ns_early" };
  if (/POLICY_VIOLATION: note/.test(message)) return { code: "ns_note" };
  if (/INVALID_STATE: hold lapsed/.test(message)) return { code: "hold_lapsed" };
  if (/POLICY_VIOLATION: source/.test(message)) return { code: "hold_source" };
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
  verified: "Payment marked as verified.",
  resent: "Email put back in the queue and a send was started. Reload in a minute to see whether it went through.",
  cancelled: "Reservation cancelled. The rooms are free again and any money held has been settled below.",
  checked_in: "Room checked in.",
  checked_in_early: "Guest checked in early. The booking now starts today, with the earlier nights added.",
  checked_in_early_waived: "Guest checked in early. The booking now starts today, and the charge for the earlier nights has been waived.",
  checked_out: "Room checked out. It is now marked dirty for housekeeping.",
  payment_recorded: "Payment recorded.",
  created: "Reservation created and confirmed. The room is held for the guest.",
  no_show_marked:
    "Marked as a no-show. The rooms are released and the booking is settled like a cancellation: any charge is invoiced and money held beyond it is queued for refund, which a second person must approve.",
  created_hold:
    "Room held. Record the guest's payment before the hold runs out and the booking is confirmed; if it runs out, the room is released.",
  payment_confirmed: "Payment recorded. The booking is now confirmed and the room is the guest's.",
  housekeeping_set: "Room status updated.",
  role_created: "Role created. You can now give it to people from the Staff page.",
  role_updated: "Role saved. The change applies at once to everyone who holds it.",
  role_deleted: "Role deleted.",
  request_done: "Request marked as dealt with. The guest sees it on their booking page.",
  request_declined: "Request declined. The guest sees your note on their booking page.",
  blocked: "Room blocked for those dates.",
  blocked_moved: "Room blocked. The bookings that were on it have moved to other rooms of the same type.",
  blocked_cancelled:
    "Room blocked. The bookings that were on it are cancelled with no charge, and the guests are emailed. Anything they had paid is now a refund request, waiting for approval.",
  block_released: "Block removed. The room can be booked again.",
  invoice_issued: "Invoice issued.",
  discount_set: "Discount saved.",
  discount_set_refund_due:
    "Discount saved. The guest has paid more than the new price: request a refund for the difference from the booking's payments.",
  discount_removed: "Discount removed.",
  discount_unchanged: "That discount was already in place. Nothing changed.",
  guest_links_reset: "Guest links reset. Old links no longer work, and the guest has been emailed a new one.",
  guest_links_reset_no_email: "Guest links reset. Old links no longer work. This booking has no guest email, so no new link was sent.",
  discount_cap_set: "Discount limit saved for this hotel.",
  discount_cap_reset: "That role is back to the standard limit.",
  invoice_voided: "Invoice voided.",
  rate_plan_created: "Standard rate plan created. Bookings can now be made.",
  rates_set: "Nightly prices saved.",
  rates_cleared: "Those dates now use the room type's standard price.",
  tax_extras_on: "Extras posted from now on are taxed with this rule. Charges already posted keep the tax they were posted with.",
  tax_extras_off:
    "Extras posted from now on are no longer taxed with this rule. Charges already posted keep the tax they were posted with.",
  policy_published:
    "New policy saved. It applies to bookings made from its start date; bookings already made keep the policy they were made under.",
  tax_rule_created:
    "Tax rule added. It applies to quotes and bookings made from now on, and it does not tax extras until you switch that on.",
  tax_rule_updated:
    "Tax rule saved. It applies to quotes and bookings made from now on; bookings already made and charges already posted keep the tax they were made with.",
  room_type_created: "Room type added. Add its rooms below, then set its rates.",
  room_type_updated: "Room type saved. New bookings use these details; bookings already made keep the price they were made at.",
  room_type_deactivated: "Room type switched off. It can no longer be booked, by staff or online. Existing bookings are not affected.",
  room_type_activated: "Room type switched on. It can be booked again.",
  photo_added: "Photo added. Guests see it on the hotel's website.",
  photo_removed: "Photo removed.",
  hotel_profile_saved: "Hotel details saved. Guests see them on the hotel's website.",
  waitlist_updated: "Waiting list updated.",
  hotel_reminder_saved: "Arrival reminder saved. It applies to bookings from now on; guests already reminded are not emailed again.",
  hotel_extras_saved: "Facilities and social links saved. Guests see them on the hotel's website.",
  hotel_basics_saved: "Hotel name, address and times saved. Bookings made from now on use the new check-in and check-out times.",
  hotel_logo_saved: "Logo saved. Guests see it in the header of your website.",
  hotel_logo_removed: "Logo removed.",
  review_approved: "Review approved. It now shows on your website.",
  review_rejected: "Review rejected. It is not shown on your website.",
  offer_saved: "Offer saved. Guests see it on the homepage while it is switched on and inside its dates.",
  offer_deleted: "Offer deleted.",
  place_saved: "Place saved. Guests see it on the homepage while it is switched on.",
  place_deleted: "Place deleted.",
  invoice_paid: "Payment received. The invoice is marked paid. Thank you.",
  invoice_pay_pending: "We have not received the payment yet. If you paid, it will show here shortly; otherwise try again.",
  hotel_theme_saved: "Look saved. Your website and the staff screens for this hotel now use it.",
  photo_moved: "Photo order saved.",
  photo_caption_saved: "Caption saved.",
  room_added: "Room added.",
  room_status_changed: "Room status updated.",
  guest_updated: "Guest details saved.",
  guest_profile_saved: "Notes and the VIP setting are saved.",
  profile_saved: "Your details and display setting are saved.",
  password_changed: "Password changed. Your other sign-ins have been signed out.",
  guest_created: "Guest added. You can now book them in from Reservations, New reservation.",
  guest_exists: "A guest with that email already exists, so no second record was made. This is their page.",
  staff_added:
    "Access granted. A new person gets an email to choose a password; someone who already has an account just signs in as usual.",
  staff_role_removed: "Role removed.",
  staff_suspended_ok: "Access suspended. They can no longer see or change anything until you restore it.",
  staff_reinstated: "Access restored.",
  staff_revoked_ok: "Access revoked and their roles cleared. To bring them back, add them again.",
  task_created: "Task added.",
  task_claimed: "Task is yours.",
  task_started: "Task started.",
  task_completed: "Task done.",
  task_assigned: "Task assigned.",
  task_unassigned: "Task is unassigned again.",
  task_cancelled: "Task cancelled.",
  mt_reported: "Fault reported. Maintenance can see it now.",
  mt_claimed: "Request is yours.",
  mt_started: "Work started.",
  mt_resolved: "Request resolved.",
  mt_resolved_block:
    "Request resolved. The room is still blocked and cannot be booked. Remove the block on the room board when it can be sold again.",
  mt_assigned: "Request assigned.",
  mt_unassigned: "Request is unassigned again.",
  mt_cancelled: "Request cancelled.",
  mt_priority: "Priority changed.",
  mt_block_linked: "Room block linked to this request.",
  mt_block_unlinked: "Room block link removed. The block itself is unchanged.",
  calendar_moved: "Guest moved. The bar now sits on the new room. If the guest was in the old room, it is now marked dirty.",
  type_changed:
    "Room type changed. The nights from that date are priced at the new type's rate and the booking shows the new room below. If an invoice was issued it was replaced by a new one, and any balance is shown in the Money section.",
  type_changed_refund:
    "Room type changed to a cheaper one. The guest has paid more than the new total, so a refund of the difference is due: request it from the booking's payments in the Money section.",
  transferred: "Room changed. The booking shows the new room below. If the guest was in the old room, it is now marked dirty.",
  fo_posted: "Charge added to the folio.",
  fo_voided: "Charge voided. It no longer counts toward what the guest owes.",
  fo_payment: "Payment recorded against the extras.",
  fo_emailed: "The invoice is on its way to the guest. If it does not arrive, check the Emails page for a failed send.",
  fo_invoiced: "Invoice issued for the extras. It is numbered and cannot be edited; to correct it, void it and issue it again.",
  fo_invoice_voided: "Invoice voided. Its extras can be invoiced again. No money has moved: payments for extras stay on the folio.",
  fo_reversed: "Payment reversed. The amount is owed again. No money has been paid back to the guest.",
  se_changed:
    "Booking updated. The nights already booked keep their price; any new nights are priced at today\u2019s rates. If an invoice was issued it was replaced by a new one, and any balance is shown in the Money section.",
  se_changed_refund:
    "Booking updated. The guest has paid more than the new total, so a refund of the difference is due: request it from the booking\u2019s payments in the Money section. If an invoice was issued it was replaced by a new one for the new dates.",
  se_changed_moved:
    "Booking updated, and a guest had to be given a different room because the old one is not free for the new dates. Check the room number below and tell the guest.",
  se_nochange: "Nothing was different, so nothing was changed.",
} as const;
export type OkCode = keyof typeof OK_MESSAGES;

export function errorMessage(code: string, refundable: number | null, formatMinor: (minor: number) => string): string {
  switch (code as ErrorCode) {
    case "self_approval":
      return "You requested this refund, so someone else has to decide it.";
    case "exceeds":
      return refundable !== null
        ? `That is more than can be refunded on this payment. At most ${formatMinor(refundable)} is left.`
        : "That is more than can be refunded on this payment.";
    case "invalid_state":
      return "That item has already moved on. The page now shows where it stands.";
    case "not_found":
      return "That item was not found, or you do not have access to it.";
    case "reason_required":
      return "A reason is required.";
    case "note_required":
      return "A note is required when rejecting a refund.";
    case "amount_invalid":
      return "Enter an amount such as 12,500 or 12500.50.";
    case "hold_inactive":
      return "This room is no longer on hold, so telling the guest it is would be wrong. The email was not resent.";
    case "room_not_ready":
      return "The room is not clean yet. Check the guest in anyway only with an override reason.";
    case "room_not_active":
      return "That room is out of service. Move the guest to another room first.";
    case "payment_required":
      return "This booking must be paid in full before check-in. A person with payment approval rights can override it with a reason.";
    case "early_checkin":
      return "The guest cannot be checked in before the arrival date: this hotel has not switched early check-in on.";
    case "waiver_forbidden":
      return "You may not waive charges. Check the guest in without the waiver, or ask someone who can give discounts.";
    case "waiver_discount":
      return "This booking already has a discount, so the added nights cannot also be waived. Check the guest in without the waiver.";
    case "early_checkin_too_early":
      return "That is further ahead of the arrival date than this hotel allows for early check-in.";
    case "stay_ended":
      return "The departure date has passed, so this room cannot be checked in.";
    case "no_stay_claim":
      return "No room is assigned for tonight. Check the room assignment first.";
    case "overpayment":
      return refundable !== null
        ? `That is more than is owed. At most ${formatMinor(refundable)} is outstanding.`
        : "That is more than is owed on this reservation.";
    case "method_invalid":
      return "Choose how the money was received.";
    case "not_cancellable":
      return "This reservation can no longer be cancelled because a guest has already checked in or it has ended.";
    case "room_unavailable":
      return 'No room of that type is free for all of those nights, or the room you chose is taken. Nothing was booked. Try other dates, another room, or leave the room as "any free room".';
    case "room_choice":
      return 'That room does not belong to the room type chosen for it. Choose a room of that type, or leave the room as "any free room".';
    case "capacity":
      return "That room type cannot take that many adults and children.";
    case "rate_missing":
      return "There is no rate set for those dates, so the price cannot be worked out. Set the rates first.";
    case "forbidden":
      return "You do not have permission to create reservations at this property.";
    case "arrival_past":
      return "The arrival date is already past. Choose today or a later date.";
    case "dates_invalid":
      return "The departure date must be after the arrival date.";
    case "too_long_stay":
      return "Stays are limited to 30 nights. Create a shorter booking and extend it later.";
    case "guest_name_required":
      return "Enter the guest's name.";
    case "room_type_missing":
      return "That room type or property is no longer available. Reload the form.";
    case "guest_failed":
      return "The guest could not be saved. Check the email and phone number and try again.";
    case "rate_range_invalid":
      return "Choose a first and last night (the last on or after the first) and a price above zero.";
    case "rate_range_long":
      return "A price change can cover at most 366 nights at a time. Split it into smaller ranges.";
    case "rate_forbidden":
      return "You do not have permission to change rates.";
    case "rate_no_plan":
      return "This hotel has no standard rate plan yet. Create one first.";
    case "tax_forbidden":
      return "You do not have permission to change the hotel's tax rules.";
    case "tax_not_percent":
      return "Only a percentage tax can be applied to extras. A fixed amount cannot.";
    case "tax_not_found":
      return "That tax rule could not be found, or you may not change it. Reload the page.";
    case "tax_invalid":
      return "Some of the tax details are not valid. Give it a name (up to 60 characters), a rate above zero (a percentage up to 100, or a naira amount a night), real dates with the last day on or after the first, and an order number from 1 to 999 or leave it blank.";
    case "tax_duplicate":
      return "Another tax rule with that name is already switched on for some of the same dates, so guests would be taxed twice on those nights. Switch the old rule off, or end it the day before this one starts.";
    case "policy_forbidden":
      return "You do not have permission to change the hotel's policies.";
    case "policy_conflict":
      return "Another policy was saved for this hotel at the same moment, or already starts on that date. Reload the page and try again.";
    case "policy_invalid":
      return "Some of the policy details are not valid. Check them and try again.";
    case "policy_rules":
      return "Check the cancellation rules. Each needs a number of hours (0 to 8760) that no other rule uses, and a charge: a percentage above 0 up to 100, 1 to 30 nights, or a naira amount. Leave a row empty to skip it.";
    case "policy_deposit":
      return "Enter the deposit as a percentage above 0 and up to 100, or choose to take the full amount online.";
    case "policy_date":
      return "Choose a real start date for the new policy.";
    case "policy_past":
      return "The new policy cannot start in the past. Choose today or a later date.";
    case "policy_order":
      return "The new policy must start after the one saved last. Choose a later date.";
    case "theme_color":
      return "Enter the colour as six hex digits, such as #0f766e, or leave it blank to use the look's own colour.";
    case "review_invalid":
      return "That review could not be updated. Reload the page and try again.";
    case "offer_invalid":
      return "Check the offer. It needs a title (up to 80 characters); the text can be up to 300 and the badge up to 24.";
    case "offer_dates":
      return "Check the dates. Leave them empty for no limit, or enter real dates with the end on or after the start.";
    case "invoice_pay_unavailable":
      return "Paying online is not available right now. Contact the platform with the invoice number.";
    case "invoice_pay_failed":
      return "The payment could not be started. Try again, or contact the platform with the invoice number.";
    case "invoice_pay_closed":
      return "That invoice is no longer open.";
    case "invoice_pay_review":
      return "A payment came in that does not match the invoice. Nothing was marked paid; the platform will contact you. Keep your payment receipt.";
    case "place_invalid":
      return "Check the place. It needs a name (up to 60 characters); the text can be up to 140.";
    case "place_limit":
      return "A hotel can list up to 8 places. Delete one you no longer need first.";
    case "offer_limit":
      return "A hotel can have up to 12 offers. Delete one you no longer need first.";
    case "theme_radius":
      return "Choose the corners from the list, or leave them as standard.";
    case "theme_font":
      return "Choose a heading font and a body font from the lists, or leave them as the look's own.";
    case "theme_contrast":
      return "White text cannot be read clearly on that colour (buttons) or it is too light for links. Choose a darker colour.";
    case "setup_invalid":
      return "Some of the details are not valid. Check the capacity numbers, the code and the price, and try again.";
    case "setup_duplicate_code":
      return "Another room type at this property already uses that code. Choose a different one.";
    case "setup_duplicate_name":
      return "Another room type at this property has a name that is too similar. Choose a different name.";
    case "setup_duplicate_room":
      return "That room number already exists at this property.";
    case "setup_forbidden":
      return "You do not have permission to change the hotel setup.";
    case "photo_file":
      return "Choose a JPEG, PNG or WebP picture up to 2 MB.";
    case "photo_limit":
      return "A room type can have up to 5 photos. Remove one first.";
    case "photo_upload":
      return "The picture could not be saved. Try again.";
    case "room_has_bookings":
      return "That room has current or future bookings or blocks. Move the guests and release the blocks first.";
    case "invoice_exists":
      return "This reservation already has an invoice. Void it first if it needs to be reissued.";
    case "invoice_has_payments":
      return "This invoice has payments recorded against it, so it cannot be voided. Refund the guest first; once no money is held it can be voided.";
    case "ns_early":
      return "A booking can only be marked as a no-show once check-in time on its arrival day has passed.";
    case "ns_note":
      return "Keep the note to 200 characters or fewer.";
    case "hold_lapsed":
      return "The hold on this room has run out, so no payment was taken. Book the room again if it is still free.";
    case "hold_source":
      return "A held booking must come from a walk-in, a phone call or a staff entry.";
    case "invoice_void":
      return "That invoice is already void.";
    case "transfer_unavailable":
      return "No room was free for the rest of the stay from that date, so nothing was changed and the guest keeps the current room. Choose a later date or a different room.";
    case "transfer_past":
      return "The move cannot start before today.";
    case "transfer_outside":
      return "That date is outside this room's stay. Choose a night the guest is booked in.";
    case "transfer_bad_room":
      return "That room cannot be used for this move. Choose a different room.";
    case "guest_name":
      return "A name is required (up to 200 characters).";
    case "guest_email":
      return "That does not look like an email address. Leave it empty if there is none.";
    case "guest_country":
      return "Use the two-letter country code, such as NG, or leave it empty.";
    case "guest_field":
      return "The phone number (40 characters) or address (500) is too long.";
    case "guest_notes":
      return "Notes can be up to 2000 characters.";
    case "profile_name":
      return "A name is required (up to 200 characters).";
    case "profile_phone":
      return "The phone number is too long (40 characters at most).";
    case "profile_density":
      return "Choose Comfortable or Compact.";
    case "wrong_password":
      return "That is not your current password. Your password was not changed.";
    case "pw_mismatch":
    case "pw_short":
    case "pw_long":
    case "pw_same":
    case "pw_weak":
    case "pw_failed":
      return resetErrorMessage(code.slice(3)) ?? "Your password was not changed.";
    case "role_escalation":
      return "You can only give or take roles whose permissions you hold yourself, for the places you hold them.";
    case "self_change":
      return "You cannot change your own access. Ask another owner.";
    case "last_owner":
      return "That would leave the hotel with no active owner. Make someone else an owner first.";
    case "staff_suspended":
      return "This person is suspended. Restore their access before changing their roles.";
    case "staff_revoked":
      return "Access was revoked. Add the person again with the form at the top to bring them back.";
    case "staff_property":
      return "That property does not belong to this hotel group.";
    case "invite_failed":
      return "The invitation could not be sent, so nobody was added. Check the address and try again in a few minutes.";
    case "email_invalid":
      return "Enter a valid email address.";
    case "block_conflict":
      return refundable !== null
        ? `${refundable} ${refundable === 1 ? "booking is" : "bookings are"} already on that room for those dates, so it was not blocked. Choose "move" or "cancel" under "If bookings are in the way", or move ${refundable === 1 ? "it" : "them"} on the booking first.`
        : "Bookings are already on that room for those dates, so it was not blocked.";
    case "block_in_house":
      return "A guest is staying in that room for those dates, so nothing was changed. A guest who has arrived cannot be cancelled: move them on their booking, or choose later dates.";
    case "role_name":
      return "Give the role a name of 2 to 60 characters, without < or >.";
    case "role_name_taken":
      return "A role with that name already exists, or it is the name of a built-in role. Choose another name.";
    case "role_permissions":
      return "Pick at least one permission. A role cannot manage staff, and it cannot both request and approve refunds.";
    case "role_limit":
      return "A hotel group can have at most 20 custom roles. Delete one you no longer use first.";
    case "role_in_use":
      return "Someone still holds this role. Remove it from them on the Staff page first.";
    case "request_note":
      return "To decline a request, write a short note for the guest.";
    case "block_past":
      return "A block cannot start in the past. Choose today or a later date.";
    case "block_invalid":
      return "Enter a reason and an end date after the start date.";
    case "room_retired":
      return "That room is retired, so it cannot be changed.";
    case "task_taken":
      return "Someone else has this task. A supervisor can hand it over.";
    case "task_forbidden":
      return "You do not have permission to do that with housekeeping tasks.";
    case "task_assignee":
      return "That person cannot be given housekeeping work at this property.";
    case "task_reason":
      return "Give a reason for cancelling, up to 200 characters.";
    case "task_invalid":
      return "The task details are not valid. Check the type, the priority and that the note is under 500 characters.";
    case "mt_taken":
      return "Someone else has this request. Ask them, or a manager, to hand it over.";
    case "mt_forbidden":
      return "You do not have permission to do that with maintenance requests.";
    case "mt_assignee":
      return "That person cannot be given maintenance work at this property.";
    case "mt_reason":
      return "Give a reason for cancelling, up to 200 characters.";
    case "mt_place":
      return "Choose the room, or name the place if it is not in a room.";
    case "mt_block":
      return "That room block cannot be linked here. Only a block on the same room can be.";
    case "mt_invalid":
      return "The request details are not valid. Check the title (up to 120 characters), the description (2000), the place (100), the note and the priority.";
    case "mt_duplicate":
      return "That form was already sent with different words. Reload the page and report the fault again.";
    case "fo_category":
      return "Choose what the charge was for.";
    case "fo_description":
      return "Say what it was, in up to 200 characters.";
    case "fo_quantity":
      return "The quantity must be a whole number from 1 to 1,000.";
    case "fo_amount":
      return "Enter an amount above zero, such as 1,500 or 1500.50, and no more than 10,000,000.";
    case "fo_date":
      return "The charge date must be a day from the guest's arrival up to today.";
    case "fo_room":
      return "Choose a room that is part of this booking, or leave it as the whole booking.";
    case "fo_reason":
      return "Give a reason, up to 200 characters.";
    case "fo_method":
      return "Choose how the money was received.";
    case "fo_too_long":
      return "The receipt number (up to 100 characters) or the note (up to 500) is too long.";
    case "fo_overpay":
      return refundable !== null
        ? `That is more than the extras still owed. At most ${formatMinor(refundable)} is outstanding.`
        : "That is more than the extras still owed.";
    case "fo_not_open":
      return "Extras can be charged and paid only while the guest is in the house or has just checked out.";
    case "fo_no_email":
      return "The guest has no email address on file, so the invoice cannot be emailed. Add one to the guest first, or print the invoice.";
    case "fo_invoice_void":
      return "That invoice has been voided, so it cannot be emailed.";
    case "fo_on_invoice":
      return "That charge is on an invoice. Void the invoice first, then void the charge.";
    case "fo_nothing":
      return "Every extra is already on an invoice, so there is nothing new to invoice.";
    case "fo_paid":
      return "That charge cannot be voided while the money collected would be more than the charges left. Reverse a payment first.";
    case "fo_not_found":
      return "That reservation, charge or payment was not found, or you do not have permission to change it.";
    case "fo_duplicate":
      return "That form was already sent with different words. Reload the page and try again.";
    case "se_dates":
      return "Choose a departure date after the arrival date.";
    case "se_too_long":
      return "Stays are limited to 30 nights. Shorten the stay, or book the rest separately.";
    case "se_reason":
      return "Give a reason for the change, up to 200 characters.";
    case "se_room":
      return "That room is not part of this booking. Reload the page and try again.";
    case "se_capacity":
      return "That room type cannot take that many adults and children. Check the numbers and try again.";
    case "se_arrival_past":
      return "The arrival date cannot be moved to a day that has already passed.";
    case "se_unavailable":
      return "No room could be held for all of the new dates, so nothing was changed and the booking keeps its dates and room. Try other dates.";
    case "se_rate":
      return "There is no price set for one of the new nights, so the change was not made. Set the rates first.";
    case "se_payment_started":
      return "An online payment for this booking has been started and not finished. Wait for it to finish or lapse, then try again.";
    case "se_split":
      return "This booking has a planned change of room partway through, so its dates cannot be edited. Guest numbers can still be changed. To change the dates, cancel it and book it again.";
    case "se_not_editable":
      return "This booking can no longer be changed. Only a confirmed booking whose guests have not arrived can be edited.";
    case "se_paid":
      return "A payment has been recorded on this booking, so its dates and guests cannot be changed. Cancel it and book it again.";
    case "se_invoiced":
      return "An invoice has been issued for this booking. Void the invoice first, then change the dates and guests.";
    case "rt_discount":
      return "This booking has a discount, so its room type cannot be changed. Remove the discount (Money section), change the room type, then apply it again.";
    case "rt_busy":
      return "A card payment for this booking has been started and not finished. Wait for it to finish, then change the room type.";
    case "rt_same":
      return "Choose a different room type from the one the guest already has.";
    case "rt_effective":
      return "Choose a date inside the stay, from today or the arrival to the last night.";
    case "se_discount":
      return "This booking has a discount, so its dates cannot be edited. Remove the discount (Money section), change the dates, then apply it again.";
    case "dc_cap_percent":
      return "Enter a percentage from 0 to 100 with at most two decimals, such as 10 or 7.5. Use 0 so the role cannot give discounts.";
    case "dc_cap_role":
      return "That role cannot give discounts, so it has no limit to set.";
    case "dc_percent":
      return "Enter a percentage from 0 to 100 with at most two decimals, such as 10 or 7.5. Use 0 to remove the discount.";
    case "dc_amount":
      return "Enter an amount in naira, such as 5,000 or 2500.50, no more than the booking's price. Use 0 to remove the discount.";
    case "gl_reason":
      return "Say why the links are being reset, in 200 characters or fewer.";
    case "dc_reason":
      return "Give a reason for the discount (up to 200 characters).";
    case "dc_limit":
      return "That is more than your role may give. Ask the owner or the general manager.";
    case "dc_status":
      return "A discount can only be set on a confirmed booking.";
    case "se_not_found":
      return "That booking was not found, or you do not have permission to change it.";
    case "se_duplicate":
      return "That form was already sent with different words. Reload the page and try again.";
    case "provider_payment":
      return "Card and online payments are paid out through the provider, not recorded by hand.";
    case "bad_request":
      return "The form was incomplete. Reload the page and try again.";
    default:
      return "Something went wrong. Nothing was changed; try again, and tell a developer if it keeps happening.";
  }
}
