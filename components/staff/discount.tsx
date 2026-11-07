import { buttonPrimary, inputClass } from "@/components/staff/ui";
import { blockedText, DISCOUNT_REASON_MAX, type DiscountView } from "@/lib/staff/discount";
import { setDiscount } from "@/lib/staff/discount-actions";

/**
 * "Discount" under the Money figures of a confirmed booking (migration 058). Offered only while nothing is paid and no
 * invoice is live; otherwise it says why it is not. The database decides again on every save, including how far this
 * person's role may go.
 */
export function Discount({ reservationId, view }: { reservationId: string; view: Exclude<DiscountView, { kind: "hidden" }> }) {
  if (view.kind === "blocked") return <p className="mt-4 max-w-md text-sm text-muted">{blockedText(view.why)}</p>;
  return (
    <details className="mt-4 max-w-md">
      <summary className="cursor-pointer text-sm font-medium text-primary-strong">{view.currentPercent ? "Change or remove the discount" : "Give a discount"}</summary>
      <form action={setDiscount} className="mt-3 grid gap-3">
        <input type="hidden" name="reservationId" value={reservationId} />
        <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
        <div>
          <label htmlFor="discount-percent" className="block text-sm">Percent off the whole price (0 removes it)</label>
          <input id="discount-percent" name="percent" inputMode="decimal" required defaultValue={view.currentPercent ?? ""} className={inputClass} />
        </div>
        <div>
          <label htmlFor="discount-reason" className="block text-sm">Why?</label>
          <textarea id="discount-reason" name="reason" required maxLength={DISCOUNT_REASON_MAX} rows={2} className={inputClass} />
        </div>
        <p className="text-xs text-muted">Replaces any discount already given. The tax lines stay as they are; the discount comes off the total.</p>
        <div><button type="submit" className={buttonPrimary}>Save discount</button></div>
      </form>
    </details>
  );
}
