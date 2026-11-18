import type { Metadata } from "next";
import { formatMoney } from "@/lib/guest-site/format";
import { eventNotice } from "@/lib/guest-site/events";
import { guestVenueBusy, guestVenues, requestHost } from "@/lib/guest-site/server";
import { EVENT_TYPE_LABEL, EVENT_TYPES, formatLocal } from "@/lib/staff/events";
import { PendingButton } from "@/components/ui/pending-button";
import { venueRequestAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Venues and events" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const field = "mt-1 w-full rounded border border-line p-2";

export default async function VenuesPage({ searchParams }: Props) {
  const raw = await searchParams;
  const host = await requestHost();
  const result = await guestVenues(host);
  const notice = typeof raw.error === "string" ? eventNotice(raw.error) : null;

  if (!result.ok || result.data.venues.length === 0) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="font-display text-3xl">Venues and events</h1>
        <p className="mt-4 text-sm text-muted">This hotel has no venues to hire online. Please contact the hotel.</p>
      </main>
    );
  }
  const { currency, venues, deposit_percent: depositPercent, hold_hours: holdHours } = result.data;
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 60 * 86400_000).toISOString().slice(0, 10);
  const busy = await Promise.all(venues.map((v) => guestVenueBusy(host, v.id, from, to)));
  const key = crypto.randomUUID();
  const anyOnline = venues.some((v) => v.bookable_online);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="font-display text-3xl">Venues and events</h1>
      <p className="mt-2 text-sm text-muted">
        Hire a hall or meeting room for a wedding, a conference or a party. Send an enquiry and the hotel will send you a quote
        {anyOnline ? `, or book a venue marked below online: the slot is held for ${holdHours} hours while you pay a ${depositPercent}% deposit` : ""}.
      </p>
      {notice ? (
        <p role="alert" className="mt-4 rounded border border-critical/40 bg-white p-3 text-critical">
          {notice}
        </p>
      ) : null}

      <ul className="mt-6 space-y-4">
        {venues.map((v, i) => {
          const b = busy[i];
          const taken = b && b.ok ? b.data.busy : [];
          return (
            <li key={v.id} className="rounded border border-line bg-white p-4">
              <h2 className="font-display text-xl">{v.name}</h2>
              {v.body ? <p className="mt-1 text-sm">{v.body}</p> : null}
              <p className="mt-1 text-sm text-muted">
                Up to {v.capacity} people
                {v.hourly_rate_minor ? ` · ${formatMoney(v.hourly_rate_minor, currency)} an hour` : ""}
                {v.day_rate_minor ? ` · ${formatMoney(v.day_rate_minor, currency)} a day` : ""}
                {v.bookable_online ? " · can be booked online" : " · by enquiry"}
              </p>
              {taken.length > 0 ? (
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer text-primary">Already taken in the next 60 days</summary>
                  <ul className="mt-1 space-y-0.5 text-muted">
                    {taken.map((t) => (
                      <li key={t.starts_at}>
                        {formatLocal(t.starts_at)} to {formatLocal(t.ends_at)}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : (
                <p className="mt-2 text-sm text-muted">Free for the next 60 days.</p>
              )}
            </li>
          );
        })}
      </ul>

      <form action={venueRequestAction} className="mt-8 space-y-4 rounded-2xl border border-line bg-white p-6">
        <h2 className="font-display text-xl">Enquire or book</h2>
        <input type="hidden" name="key" value={key} />
        <label className="block text-sm">
          Venue
          <select name="venueId" required className={field}>
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.bookable_online ? " (online booking)" : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            Starts
            <input type="datetime-local" name="startsAt" required className={field} />
          </label>
          <label className="block text-sm">
            Ends
            <input type="datetime-local" name="endsAt" required className={field} />
          </label>
          <label className="block text-sm">
            Kind of event
            <select name="eventType" className={field}>
              {EVENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {EVENT_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            People expected
            <input name="attendees" required inputMode="numeric" className={field} />
          </label>
        </div>
        <label className="block text-sm">
          Name of the event (optional)
          <input name="title" maxLength={80} className={field} />
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block text-sm">
            Your name
            <input name="name" required maxLength={80} autoComplete="name" className={field} />
          </label>
          <label className="block text-sm">
            Email
            <input type="email" name="email" required maxLength={120} autoComplete="email" className={field} />
          </label>
          <label className="block text-sm">
            Phone (optional)
            <input type="tel" name="phone" maxLength={40} autoComplete="tel" className={field} />
          </label>
        </div>
        <label className="block text-sm">
          Anything we should know (optional)
          <textarea name="note" rows={3} maxLength={500} className={field} />
        </label>
        <fieldset className="space-y-1 text-sm">
          <legend className="font-medium">What would you like to do?</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="mode" value="enquiry" defaultChecked className="accent-primary" /> Send an enquiry (nothing is held; the hotel replies with a quote)
          </label>
          {anyOnline ? (
            <label className="flex items-center gap-2">
              <input type="radio" name="mode" value="book" className="accent-primary" /> Book now (venues marked online booking only; at least 48 hours ahead)
            </label>
          ) : null}
        </fieldset>
        <PendingButton className="rounded-full bg-primary px-6 py-3 text-white" pendingLabel="Sending…">
          Continue
        </PendingButton>
      </form>
    </main>
  );
}
