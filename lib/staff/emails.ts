/** Rules for the staff failed-email screen. Pure functions, tested without a database. */

export type EmailState = "failed" | "retrying";

export type FailedEmail = {
  id: string;
  kind: string;
  to_email: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  next_attempt_at: string;
  reservation_id: string;
  property_id: string;
  booking_reference: string;
  reservation_status: string;
  state: EmailState;
};

const KIND: Record<string, string> = {
  booking_held: "Room on hold",
  booking_confirmed: "Booking confirmed",
  booking_link: "Booking link",
  refund_processed: "Refund sent",
  booking_cancelled: "Booking cancelled",
};
export const kindLabel = (kind: string) => KIND[kind] ?? kind.replace(/_/g, " ");

/** A held-room email is only worth sending while the room is still held. The database refuses it too. */
export function holdEnded(e: Pick<FailedEmail, "kind" | "reservation_status">): boolean {
  return e.kind === "booking_held" && e.reservation_status !== "pending";
}

/** Whether to offer Resend: failed for good, allowed to modify that hotel's reservations, and still worth sending. */
export function canOfferResend(e: FailedEmail, canModify: boolean): boolean {
  return e.state === "failed" && canModify && !holdEnded(e);
}

/**
 * Plain advice for a stored send error. Only recognises causes the app itself writes; anything else is
 * shown as the provider reported it and left for a person to judge.
 */
export function errorAdvice(lastError: string | null): string | null {
  if (!lastError) return null;
  if (/no verified domain/i.test(lastError)) {
    return "This hotel has no verified booking domain, so the booking link cannot be built. Verify a domain first; resending before then fails again.";
  }
  return null;
}

/** Splits the list into the two groups the page shows. */
export function splitEmails(rows: FailedEmail[]): { failed: FailedEmail[]; retrying: FailedEmail[] } {
  return { failed: rows.filter((r) => r.state === "failed"), retrying: rows.filter((r) => r.state === "retrying") };
}
