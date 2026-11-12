"use client";

import { useState } from "react";
import { nightDayLabel, nightPriceLabel } from "@/lib/guest-site/home";
import { addDaysIso, inStay, pickNight, stayEstimate, type Pick, type PriceNight } from "@/lib/guest-site/room-pick";

const field = "mt-1 w-full rounded-lg border border-line bg-white p-2.5 text-base normal-case tracking-normal text-ink";
const label = "text-xs font-medium uppercase tracking-wider text-muted";

/**
 * The price calendar and the booking form of the room page, joined: pressing nights in the calendar fills the dates (one
 * press for a night, a second on a later night for the last night of a longer stay), the dates can still be typed, and the
 * stay's price before tax shows when the calendar covers it. The form sends the guest to the homepage search with the dates
 * filled in, exactly as before; the server prices and checks the stay there.
 */
export function RoomBooking({
  typeId,
  currency,
  nights,
  maxAdults,
  maxChildren,
  fromLabel,
}: {
  typeId: string;
  currency: string;
  nights: PriceNight[];
  maxAdults: number;
  maxChildren: number;
  fromLabel: string | null;
}) {
  const today = nights[0]?.date;
  const [pick, setPick] = useState<Pick>({ arrival: "", departure: "", awaitingEnd: false });
  const est = stayEstimate(nights, pick.arrival, pick.departure);

  return (
    <>
      <section aria-labelledby="calendar-title" className="mt-6 rounded-2xl border border-line bg-white p-5">
        <h2 id="calendar-title" className="font-medium">
          Price calendar
        </h2>
        <p className="mt-1 text-xs text-muted">
          The nightly rate for the next {nights.length} nights, before tax. Press a night to pick it; press a later one to stay until then.
        </p>
        <ul className="mt-3 grid grid-cols-2 gap-2 text-center text-sm sm:grid-cols-4 xl:grid-cols-5">
          {nights.map((n) => {
            const on = inStay(n.date, pick.arrival, pick.departure);
            const none = n.rate_minor === null;
            return (
              <li key={n.date}>
                <button
                  type="button"
                  disabled={none}
                  aria-pressed={on}
                  onClick={() => setPick((p) => pickNight(p, nights, n.date))}
                  className={`w-full rounded-lg border px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60 ${
                    on ? "border-primary bg-primary text-white" : "border-line hover:border-primary"
                  }`}
                >
                  <span className={`block text-xs ${on ? "text-white/80" : "text-muted"}`}>{nightDayLabel(n.date)}</span>
                  <span className="block font-medium">{nightPriceLabel(n.rate_minor, currency)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <form action="/" method="get" className="mt-6 grid grid-cols-2 gap-4 rounded-2xl border border-line bg-white p-5">
        <h2 className="col-span-2 font-display text-xl">Book this room</h2>
        <input type="hidden" name="type" value={typeId} />
        <label className={label}>
          Check in
          <input
            type="date"
            name="arrival"
            min={today}
            required
            value={pick.arrival}
            onChange={(e) => {
              const arrival = e.target.value;
              setPick((p) => ({
                arrival,
                departure: p.departure > arrival ? p.departure : arrival ? addDaysIso(arrival, 1) : "",
                awaitingEnd: false,
              }));
            }}
            className={field}
          />
        </label>
        <label className={label}>
          Check out
          <input
            type="date"
            name="departure"
            min={pick.arrival ? addDaysIso(pick.arrival, 1) : today}
            required
            value={pick.departure}
            onChange={(e) => setPick((p) => ({ ...p, departure: e.target.value, awaitingEnd: false }))}
            className={field}
          />
        </label>
        <label className={label}>
          Adults
          <input
            type="number"
            name="adults"
            min={1}
            max={Math.min(20, maxAdults)}
            defaultValue={Math.min(2, maxAdults)}
            required
            className={field}
          />
        </label>
        <label className={label}>
          Children
          <input type="number" name="children" min={0} max={Math.min(20, maxChildren)} defaultValue={0} className={field} />
        </label>
        <p role="status" aria-live="polite" className="col-span-2 min-h-5 text-sm text-muted">
          {est
            ? `${est.nights} ${est.nights === 1 ? "night" : "nights"}, about ${nightPriceLabel(est.totalMinor, currency)} before tax`
            : ""}
        </p>
        <button
          type="submit"
          className="col-span-2 rounded-full bg-primary px-4 py-3 font-medium text-white hover:bg-primary-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {fromLabel ? `Check availability · ${fromLabel} a night` : "Check availability"}
        </button>
      </form>
    </>
  );
}
