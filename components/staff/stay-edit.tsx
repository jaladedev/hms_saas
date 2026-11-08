import { buttonPrimary, inputClass } from "@/components/staff/ui";
import { editStay } from "@/lib/staff/stay-actions";
import { STAY_REASON_MAX } from "@/lib/staff/stay-edit";

export type StayEditRoom = { id: string; label: string; adults: number; children: number; maxAdults: number; maxChildren: number };

/**
 * "Change dates or guests" under the Stay details of a confirmed booking (migration 033). With money on the booking
 * the invoice is replaced and any surplus is flagged for refund (migration 070). The database decides again on every save,
 * and the whole change is all or nothing.
 */
export function StayEdit({
  reservationId, arrival, departure, today, rooms,
}: {
  reservationId: string; arrival: string; departure: string; today: string; rooms: StayEditRoom[];
}) {
  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-sm font-medium text-primary-strong">Change dates or guests</summary>
      <form action={editStay} className="mt-3 grid max-w-md gap-3">
        <input type="hidden" name="reservationId" value={reservationId} />
        <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="stay-arrival" className="block text-sm">Arrival</label>
            <input id="stay-arrival" name="arrival" type="date" required min={arrival < today ? arrival : today} defaultValue={arrival} className={inputClass} />
          </div>
          <div>
            <label htmlFor="stay-departure" className="block text-sm">Departure</label>
            <input id="stay-departure" name="departure" type="date" required defaultValue={departure} className={inputClass} />
          </div>
        </div>
        {rooms.map((r) => (
          <fieldset key={r.id} className="grid grid-cols-2 gap-3">
            <legend className="mb-1 text-sm text-muted">{r.label}</legend>
            <div>
              <label htmlFor={`stay-adults-${r.id}`} className="block text-sm">Adults</label>
              <input id={`stay-adults-${r.id}`} name={`adults_${r.id}`} type="number" inputMode="numeric" min={1} max={r.maxAdults} step={1} defaultValue={r.adults} required className={`${inputClass} tabular-nums`} />
            </div>
            <div>
              <label htmlFor={`stay-children-${r.id}`} className="block text-sm">Children</label>
              <input id={`stay-children-${r.id}`} name={`children_${r.id}`} type="number" inputMode="numeric" min={0} max={r.maxChildren} step={1} defaultValue={r.children} required className={`${inputClass} tabular-nums`} />
            </div>
          </fieldset>
        ))}
        <div>
          <label htmlFor="stay-reason" className="block text-sm">Why is it being changed?</label>
          <textarea id="stay-reason" name="reason" required maxLength={STAY_REASON_MAX} rows={2} className={inputClass} />
        </div>
        <p className="text-xs text-muted">
          Nights already booked keep the price they were booked at. Any new night is priced at today&rsquo;s rate and tax, and the total follows the nights.
          Each guest keeps their room if it is free for the new dates; if not, they are given another room of the same type. If any room cannot be held,
          nothing is changed. This works only while nothing has been paid and no invoice is issued.
        </p>
        <div><button type="submit" className={buttonPrimary}>Save changes</button></div>
      </form>
    </details>
  );
}
