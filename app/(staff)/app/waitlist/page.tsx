import { buttonPrimary, buttonQuiet, EmptyState, ErrorBanner, Notice, PageIntro, PageTitle } from "@/components/staff/ui";
import { formatDate } from "@/lib/guest-site/format";
import { setWaitlistStatus } from "@/lib/staff/waitlist-actions";
import { freeCount, freeLabel, parseWaitlist, sortWaitlist } from "@/lib/staff/waitlist";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function WaitlistPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const { data: props } = await supabase.from("properties").select("id, name").order("name");
  const properties = (props ?? []) as { id: string; name: string }[];
  const results = await Promise.all(properties.map((p) => supabase.rpc("waitlist_list", { p_property: p.id })));
  // A hotel the person may not see requests for answers NOT_FOUND; that hotel is left out, any other failure is shown.
  const failed = results.some((r) => r.error && !/NOT_FOUND/.test(r.error.message));
  const many = properties.length > 1;
  const groups = properties
    .map((p, i) => ({ property: p, rows: sortWaitlist(parseWaitlist(results[i]?.data)) }))
    .filter((g) => g.rows.length > 0);
  const free = groups.reduce((n, g) => n + freeCount(g.rows), 0);

  return (
    <main className="max-w-4xl">
      <PageTitle>Waiting list</PageTitle>
      <PageIntro>
        Guests who found a room type sold out for their dates and left their details. Nothing is sent to them: when a room shows as free
        now, call or email the guest yourself, take the booking in Reservations, then mark the request contacted or closed. Requests are
        removed a month after the stay dates.
      </PageIntro>
      <div className="mt-6">
        <Notice search={search} currency="NGN" />
        {failed && <ErrorBanner className="mb-5">The waiting list could not be loaded. Reload the page to try again.</ErrorBanner>}
      </div>
      {free > 0 && (
        <p role="status" className="mb-5 border-l-4 border-primary bg-primary/5 px-4 py-3 text-sm text-primary-strong">
          {free === 1 ? "1 request has a room free now." : `${free} requests have a room free now.`}
        </p>
      )}
      {groups.length === 0 && !failed && <EmptyState className="mt-8">Nobody is waiting for a room.</EmptyState>}
      {groups.map((g) => (
        <section key={g.property.id} className="mt-6">
          {many && <h2 className="mb-2 font-display text-xl">{g.property.name}</h2>}
          <ul className="border-t border-line">
            {g.rows.map((r) => (
              <li key={r.id} className="border-b border-line py-5">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {r.guest_name}
                  {r.rooms_free_now > 0 ? (
                    <span className="rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-white">{freeLabel(r)}</span>
                  ) : (
                    <span className="rounded-full bg-ink/5 px-2.5 py-0.5 text-xs text-muted">{freeLabel(r)}</span>
                  )}
                  {r.status === "contacted" && <span className="rounded-full bg-ink/5 px-2.5 py-0.5 text-xs text-muted">Contacted</span>}
                </p>
                <p className="mt-1 text-sm">
                  {r.room_type}, {formatDate(r.arrival_date)} to {formatDate(r.departure_date)}, {r.adults} adult{r.adults === 1 ? "" : "s"}
                  {r.children > 0 ? `, ${r.children} child${r.children === 1 ? "" : "ren"}` : ""}
                </p>
                <p className="mt-1 text-sm text-muted">
                  <a href={`mailto:${r.email}`} className="underline underline-offset-2">
                    {r.email}
                  </a>
                  {r.phone ? ` · ${r.phone}` : ""}
                </p>
                <form action={setWaitlistStatus} className="mt-3 flex flex-wrap gap-2">
                  <input type="hidden" name="id" value={r.id} />
                  {r.status === "waiting" ? (
                    <button type="submit" name="status" value="contacted" className={buttonPrimary}>
                      Mark contacted
                    </button>
                  ) : (
                    <button type="submit" name="status" value="waiting" className={buttonQuiet}>
                      Back to waiting
                    </button>
                  )}
                  <button type="submit" name="status" value="closed" className={buttonQuiet}>
                    Close
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
