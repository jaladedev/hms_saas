import type { Metadata } from "next";
import { eventNotice } from "@/lib/guest-site/events";
import { formatMoney } from "@/lib/guest-site/format";
import { guestEvents, requestHost } from "@/lib/guest-site/server";
import { formatLocal } from "@/lib/staff/events";
import { PendingButton } from "@/components/ui/pending-button";
import { ticketOrderAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Events" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const field = "mt-1 w-full rounded border border-line p-2";

export default async function EventsPage({ searchParams }: Props) {
  const raw = await searchParams;
  const result = await guestEvents(await requestHost());
  const notice = typeof raw.error === "string" ? eventNotice(raw.error) : null;
  const events = result.ok ? result.data.events : [];
  const currency = result.ok ? result.data.currency : "NGN";

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="font-display text-3xl">Events</h1>
      {notice ? (
        <p role="alert" className="mt-4 rounded border border-critical/40 bg-white p-3 text-critical">
          {notice}
        </p>
      ) : null}
      {!result.ok ? (
        <p className="mt-4 text-sm text-critical">The events could not be loaded. Reload the page.</p>
      ) : events.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No events have tickets on sale right now.</p>
      ) : (
        <ul className="mt-6 space-y-6">
          {events.map((e) => {
            const types = e.ticket_types.filter((t) => t.remaining > 0);
            return (
              <li key={e.id} className="rounded border border-line bg-white p-4">
                <h2 className="font-display text-xl">{e.title}</h2>
                <p className="mt-1 text-sm text-muted">
                  {formatLocal(e.starts_at)} to {formatLocal(e.ends_at)}
                  {e.venue ? ` · ${e.venue}` : ""}
                </p>
                {e.body ? <p className="mt-2 text-sm">{e.body}</p> : null}
                {types.length === 0 ? (
                  <p className="mt-3 text-sm font-medium">Sold out.</p>
                ) : (
                  <form action={ticketOrderAction} className="mt-3 space-y-3">
                    <input type="hidden" name="eventId" value={e.id} />
                    <input type="hidden" name="key" value={crypto.randomUUID()} />
                    <div className="grid gap-3 sm:grid-cols-2">
                      {types.map((t) => (
                        <label key={t.id} className="block text-sm">
                          {t.name}: {t.price_minor ? formatMoney(t.price_minor, currency) : "Free"}
                          <span className="text-muted"> ({t.remaining} left)</span>
                          <input name={`qty_${t.id}`} inputMode="numeric" defaultValue="0" aria-label={`Number of ${t.name} tickets`} className={field} />
                        </label>
                      ))}
                    </div>
                    <p className="text-xs text-muted">Up to {e.max_per_order} tickets in one order. Your tickets are held for 20 minutes while you pay.</p>
                    <div className="grid gap-3 sm:grid-cols-3">
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
                    <PendingButton className="rounded-full bg-primary px-6 py-3 text-white" pendingLabel="Holding…">
                      Continue to payment
                    </PendingButton>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
