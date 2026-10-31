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
  | "amount_invalid" | "provider_payment" | "hold_inactive" | "bad_request" | "unknown";

/** Maps a database error message to a code, and the refundable amount when the database reports one. */
export function classifyRpcError(message: string): { code: ErrorCode; refundableMinor?: number } {
  if (/SELF_APPROVAL/.test(message)) return { code: "self_approval" };
  const exceeds = /REFUND_EXCEEDS_PAYMENT refundable (\d+)/.exec(message);
  if (exceeds) return { code: "exceeds", refundableMinor: Number(exceeds[1]) };
  if (/note required to reject/.test(message)) return { code: "note_required" };
  if (/reason required/.test(message)) return { code: "reason_required" };
  if (/amount must be positive/.test(message)) return { code: "amount_invalid" };
  if (/refunded through the provider|provider payments/.test(message)) return { code: "provider_payment" };
  if (/hold is no longer active/.test(message)) return { code: "hold_inactive" };
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
    case "provider_payment": return "Card and online payments are paid out through the provider, not recorded by hand.";
    case "bad_request": return "The form was incomplete. Reload the page and try again.";
    default: return "Something went wrong. Nothing was changed; try again, and tell a developer if it keeps happening.";
  }
}
