import { buttonQuiet, inputClass } from "@/components/staff/ui";
import { GUEST_LINK_REASON_MAX } from "@/lib/staff/guest-link";
import { resetGuestLinks } from "@/lib/staff/guest-link-actions";
import { PendingButton } from "@/components/ui/pending-button";

/**
 * "Reset the guest's links" on a booking (migration 066): for a link that went to the wrong person. Every link sent so far
 * stops working and the guest is emailed a new one if the booking has an email address.
 */
export function GuestLinkReset({ reservationId }: { reservationId: string }) {
  return (
    <details className="mt-4 max-w-md">
      <summary className="cursor-pointer text-sm font-medium text-primary-strong">Reset the guest&apos;s booking links</summary>
      <form action={resetGuestLinks} className="mt-3 grid gap-3">
        <input type="hidden" name="reservationId" value={reservationId} />
        <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
        <p className="text-xs text-muted">
          Use this if a booking link reached the wrong person. Every link sent so far stops working, and the guest is emailed a new one if
          we have their address.
        </p>
        <div>
          <label htmlFor="guest-link-reason" className="block text-sm">
            Why?
          </label>
          <textarea id="guest-link-reason" name="reason" required maxLength={GUEST_LINK_REASON_MAX} rows={2} className={inputClass} />
        </div>
        <div>
          <PendingButton className={buttonQuiet} pendingLabel="Resetting…">
            Reset links
          </PendingButton>
        </div>
      </form>
    </details>
  );
}
