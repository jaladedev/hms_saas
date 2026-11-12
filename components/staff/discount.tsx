import { buttonPrimary, inputClass } from "@/components/staff/ui";
import { minorToInput } from "@/lib/staff/money-input";
import { blockedText, DISCOUNT_REASON_MAX, type DiscountView } from "@/lib/staff/discount";
import { setDiscount } from "@/lib/staff/discount-actions";
import { PendingButton } from "@/components/ui/pending-button";

/**
 * "Discount" under the Money figures of a confirmed booking (migration 058). Offered only while nothing is paid and no
 * invoice is live; otherwise it says why it is not. The database decides again on every save, including how far this
 * person's role may go.
 */
export function Discount({ reservationId, view }: { reservationId: string; view: Exclude<DiscountView, { kind: "hidden" }> }) {
  if (view.kind === "blocked") return <p className="mt-4 max-w-md text-sm text-muted">{blockedText(view.why)}</p>;
  return (
    <details className="mt-4 max-w-md">
      <summary className="cursor-pointer text-sm font-medium text-primary-strong">
        {view.current.kind === "none" ? "Give a discount" : "Change or remove the discount"}
      </summary>
      <form action={setDiscount} className="mt-3 grid gap-3">
        <input type="hidden" name="reservationId" value={reservationId} />
        <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
        <fieldset className="grid gap-2">
          <legend className="text-sm">Give it as</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="kind" value="percent" defaultChecked={view.current.kind !== "amount"} /> A percentage of the whole
            price
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="kind" value="amount" defaultChecked={view.current.kind === "amount"} /> A fixed amount in naira
          </label>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="discount-percent" className="block text-sm">
              Percent
            </label>
            <input
              id="discount-percent"
              name="percent"
              inputMode="decimal"
              defaultValue={view.current.kind === "percent" ? view.current.percent : ""}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="discount-amount" className="block text-sm">
              Amount (₦)
            </label>
            <input
              id="discount-amount"
              name="amount"
              inputMode="decimal"
              defaultValue={view.current.kind === "amount" ? minorToInput(view.current.amountMinor) : ""}
              className={inputClass}
            />
          </div>
        </div>
        <p className="text-xs text-muted">
          Fill in the one you chose; 0 removes the discount. Your role has a limit, counted as a share of the price.
        </p>
        <div>
          <label htmlFor="discount-reason" className="block text-sm">
            Why?
          </label>
          <textarea id="discount-reason" name="reason" required maxLength={DISCOUNT_REASON_MAX} rows={2} className={inputClass} />
        </div>
        <p className="text-xs text-muted">
          Replaces any discount already given. The tax lines stay as they are; the discount comes off the total.
        </p>
        <div>
          <PendingButton className={buttonPrimary} pendingLabel="Saving…">
            Save discount
          </PendingButton>
        </div>
      </form>
    </details>
  );
}
