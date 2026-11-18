import Link from "next/link";
import { EmptyState, ErrorBanner, headRow, linkClass, Notice, PageIntro, PageTitle, SectionTitle } from "@/components/staff/ui";
import { EventForm } from "@/components/staff/event-form";
import { eventProperties } from "@/lib/staff/event-page-helpers";
import { EVENT_STATUS_LABEL, formatLocal } from "@/lib/staff/events";

export const dynamic = "force-dynamic";
type Search = Record<string, string | string[] | undefined>;
type Ev = { id: string; title: string; status: string; starts_at: string };

/** Ticketed events (a concert, a gala dinner, a market day): sold by the hotel's own staff and online. */
export default async function TicketedEventsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const { supabase, chosen } = await eventProperties("event.view", typeof search.property === "string" ? search.property : undefined);
  if (!chosen) {
    return (
      <main className="max-w-2xl">
        <PageTitle>Ticketed events</PageTitle>
        <EmptyState className="mt-4">You do not have permission to see events.</EmptyState>
      </main>
    );
  }
  const [evQ, venueQ, manageQ] = await Promise.all([
    supabase
      .from("hotel_events")
      .select("id, title, status, starts_at")
      .eq("property_id", chosen.id)
      .order("starts_at", { ascending: false })
      .limit(100),
    supabase.from("hotel_venues").select("id, name").eq("property_id", chosen.id).eq("is_active", true).order("sort_order"),
    supabase.rpc("has_permission", { p_property: chosen.id, p_permission: "event.manage" }),
  ]);
  const events = (evQ.data ?? []) as Ev[];
  const ids = events.map((e) => e.id);
  const tixQ = ids.length
    ? await supabase.from("tickets").select("event_id, status").in("event_id", ids).neq("status", "void")
    : { data: [] };
  const sold = new Map<string, number>();
  for (const t of (tixQ.data ?? []) as { event_id: string }[]) sold.set(t.event_id, (sold.get(t.event_id) ?? 0) + 1);
  const venues = (venueQ.data ?? []) as { id: string; name: string }[];

  return (
    <main className="max-w-4xl">
      <PageTitle>Ticketed events</PageTitle>
      <p className="text-sm">
        <Link href={`/app/events?property=${chosen.id}`} className={linkClass}>
          Venue hire
        </Link>
        <span aria-hidden="true"> · </span>
        <span className="font-medium">Ticketed events</span>
      </p>
      <PageIntro>
        Create an event, add ticket types with a price and a number on sale, then switch it on sale. Tickets sell at the desk and online.
      </PageIntro>
      <div className="mt-4">
        <Notice search={search} currency={chosen.currency} />
      </div>
      {(evQ.error || venueQ.error) && <ErrorBanner className="mb-4">The events could not be loaded. Reload the page.</ErrorBanner>}
      {events.length === 0 ? (
        <EmptyState>No events yet.</EmptyState>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className={headRow}>
              <th className="py-2 pr-3 font-normal">Event</th>
              <th className="px-2 py-2 font-normal">When</th>
              <th className="px-2 py-2 font-normal">Status</th>
              <th className="px-2 py-2 text-right font-normal">Tickets sold</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className="border-b border-line">
                <td className="py-2 pr-3">
                  <Link href={`/app/events/tickets/${e.id}`} className={linkClass}>
                    {e.title}
                  </Link>
                </td>
                <td className="px-2 py-2">{formatLocal(e.starts_at)}</td>
                <td className="px-2 py-2">{EVENT_STATUS_LABEL[e.status] ?? e.status}</td>
                <td className="px-2 py-2 text-right tabular-nums">{sold.get(e.id) ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {manageQ.data === true && (
        <>
          <SectionTitle>New event</SectionTitle>
          <EventForm propertyId={chosen.id} venues={venues} item={null} />
        </>
      )}
    </main>
  );
}
