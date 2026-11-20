import { buttonPrimary, inputClass } from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { formatMoney } from "@/lib/guest-site/format";
import { redeemVoucher, releaseVoucher } from "@/lib/staff/vouchers-actions";
import type { BookingVoucher } from "@/lib/staff/vouchers";

/**
 * "Voucher" under the discount of a booking (migration 161). People who can apply discounts enter a code on a confirmed booking that has
 * no discount, or give the voucher back. The database decides again on every action, including payments and invoices, so this only
 * decides what to offer.
 */
export function BookingVoucherCard({
  reservationId,
  voucher,
  canApply,
  confirmed,
  hasOtherDiscount,
  invoiced,
  currency,
}: {
  reservationId: string;
  voucher: Extract<BookingVoucher, { enabled: true }>;
  canApply: boolean;
  confirmed: boolean;
  hasOtherDiscount: boolean;
  invoiced: boolean;
  currency: string;
}) {
  const returnTo = `/app/reservations/${reservationId}`;
  const canSpend = canApply && confirmed && !invoiced && !hasOtherDiscount && !voucher.applied;
  if (!voucher.applied && !canSpend) return null;

  return (
    <section aria-labelledby="voucher-heading" className="mt-4 max-w-md rounded-xl border border-line p-4">
      <h3 id="voucher-heading" className="text-sm font-medium">
        Voucher
      </h3>
      {voucher.applied && (
        <>
          <p className="mt-1 text-sm">
            Voucher <span className="font-mono">{voucher.code}</span> is paying {formatMoney(voucher.appliedMinor, currency)} of this
            booking.
          </p>
          {canApply && confirmed && !invoiced && (
            <form action={releaseVoucher} className="mt-2">
              <input type="hidden" name="reservationId" value={reservationId} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <input type="hidden" name="key" value={crypto.randomUUID()} />
              <PendingButton
                className="min-h-11 rounded-full border border-ink px-5 text-sm hover:bg-ink hover:text-paper"
                pendingLabel="Working…"
              >
                Give the voucher back
              </PendingButton>
            </form>
          )}
        </>
      )}
      {canSpend && (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm font-medium text-primary-strong">Use a voucher on this booking</summary>
          <form action={redeemVoucher} className="mt-3 grid gap-3">
            <input type="hidden" name="reservationId" value={reservationId} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <input type="hidden" name="key" value={crypto.randomUUID()} />
            <div>
              <label htmlFor="voucher-code" className="block text-sm">
                Voucher code
              </label>
              <input
                id="voucher-code"
                name="code"
                required
                autoComplete="off"
                autoCapitalize="characters"
                placeholder="GV-XXXX-XXXX"
                className={`${inputClass} font-mono`}
              />
            </div>
            <p className="text-xs text-muted">
              The voucher takes its value off the whole price, tax included, never more than the booking costs. It becomes this
              booking&rsquo;s discount, so no other discount can be added; give the voucher back to change that. A discount voucher is used
              up even if the booking costs less. The value comes back automatically if the booking is cancelled.
            </p>
            <div>
              <PendingButton className={buttonPrimary} pendingLabel="Applying…">
                Use voucher
              </PendingButton>
            </div>
          </form>
        </details>
      )}
    </section>
  );
}
