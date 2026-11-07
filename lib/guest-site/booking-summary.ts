/**
 * Whether the guest's booking page may say money is still owed.
 *
 * `outstanding_minor` is the total less what was paid, whatever state the booking is in, so on a booking that is over
 * (cancelled, expired or a no-show) it still reads the full price. Nothing more can be paid on such a booking, and a
 * guest told "Still to pay ₦50,000.00" under a "this booking was cancelled" notice may well pay it. Any refund or
 * cancellation charge is the hotel's to settle and is not shown as an amount due.
 */
const OVER = new Set(["cancelled", "expired", "no_show"]);

export function showsAmountDue(status: string): boolean {
  return !OVER.has(status);
}
