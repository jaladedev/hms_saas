import { buttonPrimary, inputClass } from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { formatMoney } from "@/lib/guest-site/format";
import { pointsText, pointsValueMinor, type BookingLoyalty } from "@/lib/staff/loyalty";
import { redeemLoyaltyPoints, releaseLoyaltyPoints } from "@/lib/staff/loyalty-actions";

/**
 * "Loyalty points" under the discount of a booking (migration 159). Everyone who can see the booking sees the guest's balance; people
 * who can apply discounts can spend points on a confirmed booking with no discount and give them back. The database decides again on
 * every action, including payments and invoices, so this only decides what to offer.
 */
export function LoyaltyPoints({
  reservationId,
  loyalty,
  canApply,
  confirmed,
  hasOtherDiscount,
  invoiced,
  currency,
}: {
  reservationId: string;
  loyalty: Extract<BookingLoyalty, { enabled: true }>;
  canApply: boolean;
  confirmed: boolean;
  hasOtherDiscount: boolean;
  invoiced: boolean;
  currency: string;
}) {
  const returnTo = `/app/reservations/${reservationId}`;
  const money = (m: number) => formatMoney(m, currency);
  const worth = pointsValueMinor(loyalty.balance, loyalty.pointValueMinor);
  const canSpend =
    canApply && confirmed && !invoiced && !hasOtherDiscount && loyalty.redeemedPoints === 0 && loyalty.balance >= loyalty.minRedeem;

  return (
    <section aria-labelledby="loyalty-heading" className="mt-4 max-w-md rounded-xl border border-line p-4">
      <h3 id="loyalty-heading" className="text-sm font-medium">
        Loyalty points
      </h3>
      {!loyalty.hasEmail ? (
        <p className="mt-1 text-sm text-muted">Add the guest&rsquo;s e-mail address to earn and use points.</p>
      ) : (
        <p className="mt-1 text-sm">
          The guest has {pointsText(loyalty.balance)}, worth {money(worth)}.
        </p>
      )}

      {loyalty.redeemedPoints > 0 && (
        <>
          <p className="mt-2 text-sm">
            {pointsText(loyalty.redeemedPoints)} are paying {money(loyalty.redeemedMinor)} of this booking.
          </p>
          {canApply && confirmed && !invoiced && (
            <form action={releaseLoyaltyPoints} className="mt-2">
              <input type="hidden" name="reservationId" value={reservationId} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <input type="hidden" name="key" value={crypto.randomUUID()} />
              <PendingButton
                className="min-h-11 rounded-full border border-ink px-5 text-sm hover:bg-ink hover:text-paper"
                pendingLabel="Working…"
              >
                Give the points back
              </PendingButton>
            </form>
          )}
        </>
      )}

      {loyalty.hasEmail && loyalty.redeemedPoints === 0 && hasOtherDiscount && (
        <p className="mt-2 text-sm text-muted">This booking already has a discount. Remove it first to use points.</p>
      )}

      {canSpend && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium text-primary-strong">Use points on this booking</summary>
          <form action={redeemLoyaltyPoints} className="mt-3 grid gap-3">
            <input type="hidden" name="reservationId" value={reservationId} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <input type="hidden" name="key" value={crypto.randomUUID()} />
            <div>
              <label htmlFor="loyalty-points" className="block text-sm">
                Points to use (at least {loyalty.minRedeem}, up to {loyalty.balance})
              </label>
              <input
                id="loyalty-points"
                name="points"
                inputMode="numeric"
                required
                defaultValue={loyalty.balance >= loyalty.minRedeem ? loyalty.minRedeem : undefined}
                className={inputClass}
              />
            </div>
            <p className="text-xs text-muted">
              Each point takes {money(loyalty.pointValueMinor)} off the whole price, tax included. It becomes this booking&rsquo;s discount,
              so no other discount can be added; give the points back to change that. Points come back automatically if the booking is
              cancelled.
            </p>
            <div>
              <PendingButton className={buttonPrimary} pendingLabel="Applying…">
                Use points
              </PendingButton>
            </div>
          </form>
        </details>
      )}
    </section>
  );
}
