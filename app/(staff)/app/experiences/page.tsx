import { buttonPrimary, buttonQuiet, EmptyState, ErrorBanner, Notice, PageIntro, PageTitle } from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { setExperienceRequest } from "@/lib/staff/experience-actions";
import { canPostToFolio, parseOpenRequests } from "@/lib/staff/experiences";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Experience requests guests sent from their booking page that are still open. Confirm or decline each one; a confirmed one is posted to
 * the guest's folio once they are checked in. Needs folio.charge at the hotel; a hotel the person may not see is left out.
 */
export default async function ExperienceRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const supabase = await createClient();
  const { data: props } = await supabase.from("properties").select("id, name, currency").order("name");
  const properties = (props ?? []) as { id: string; name: string; currency: string }[];
  const results = await Promise.all(properties.map((p) => supabase.rpc("experience_requests_open", { p_property: p.id })));
  const failed = results.some((r) => r.error && !/NOT_FOUND/.test(r.error.message));
  const many = properties.length > 1;
  const groups = properties.map((p, i) => ({ property: p, rows: parseOpenRequests(results[i]?.data) })).filter((g) => g.rows.length > 0);

  return (
    <main className="max-w-4xl">
      <PageTitle>Experiences</PageTitle>
      <PageIntro>
        Requests from guests for the experiences you list in Settings. Confirm one once you can provide it, or decline it, and tell the
        guest yourself; nothing is sent to them. When a guest is in the house, post a confirmed request to their folio so it is paid with
        the rest of the stay.
      </PageIntro>
      <div className="mt-6">
        <Notice search={search} currency="NGN" />
        {failed && <ErrorBanner className="mb-5">The requests could not be loaded. Reload the page to try again.</ErrorBanner>}
      </div>
      {groups.length === 0 && !failed && <EmptyState className="mt-8">No open requests.</EmptyState>}
      {groups.map((g) => (
        <section key={g.property.id} className="mt-6">
          {many && <h2 className="mb-2 font-display text-xl">{g.property.name}</h2>}
          <ul className="border-t border-line">
            {g.rows.map((r) => {
              const key = `${r.id}-${r.status}`;
              return (
                <li key={r.id} className="border-b border-line py-5">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {r.name} &times; {r.quantity}
                    <span className="rounded-full bg-ink/5 px-2.5 py-0.5 text-xs text-muted">
                      {r.status === "confirmed" ? "Confirmed" : "Requested"}
                    </span>
                  </p>
                  <p className="mt-1 text-sm">
                    {formatMoney(r.total_minor, g.property.currency)}
                    {r.date ? ` · wanted on ${formatDate(r.date)}` : ""}
                  </p>
                  <p className="mt-1 text-sm text-muted">
                    <a href={`/app/reservations/${r.reservation_id}`} className="underline underline-offset-2">
                      Booking {r.booking_reference}
                    </a>
                    {` · ${formatDate(r.arrival_date)} to ${formatDate(r.departure_date)} · ${r.reservation_status.replace("_", " ")}`}
                  </p>
                  {r.note ? <p className="mt-1 text-sm">&ldquo;{r.note}&rdquo;</p> : null}
                  <form action={setExperienceRequest} className="mt-3 flex flex-wrap gap-2">
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="key" value={`exp-${key}`.padEnd(8, "x")} />
                    {r.status === "requested" ? (
                      <button type="submit" name="action" value="confirm" className={buttonPrimary}>
                        Confirm
                      </button>
                    ) : canPostToFolio(r.reservation_status) ? (
                      <button type="submit" name="action" value="charge" className={buttonPrimary}>
                        Post to folio
                      </button>
                    ) : (
                      <span className="self-center text-sm text-muted">Can be posted to the folio once the guest is checked in.</span>
                    )}
                    <button type="submit" name="action" value="decline" className={buttonQuiet}>
                      Decline
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </main>
  );
}
