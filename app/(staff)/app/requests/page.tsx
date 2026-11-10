import Link from "next/link";
import {
  buttonPrimary,
  buttonQuiet,
  EmptyState,
  ErrorBanner,
  inputClass,
  linkClass,
  Notice,
  PageIntro,
  PageTitle,
} from "@/components/staff/ui";
import { formatDate } from "@/lib/guest-site/format";
import { formatDateTime } from "@/lib/staff/format";
import { resolveChangeRequest } from "@/lib/staff/change-request-actions";
import { askText, CHANGE_REQUEST_COLUMNS, parseRequests, parseRequestView, statusLabel, withBookings } from "@/lib/staff/change-requests";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function GuestRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const view = parseRequestView(search.view);
  const supabase = await createClient();
  const base = supabase.from("guest_change_requests").select(CHANGE_REQUEST_COLUMNS);
  const [listQ, propQ] = await Promise.all([
    view === "open"
      ? base.eq("status", "open").order("created_at", { ascending: true }).limit(100)
      : base.neq("status", "open").order("created_at", { ascending: false }).limit(50),
    supabase.from("properties").select("id, timezone"),
  ]);
  const found = parseRequests(listQ.data);
  const bookingsQ = found.length
    ? await supabase
        .from("reservations")
        .select("id, booking_reference, arrival_date, departure_date")
        .in("id", [...new Set(found.map((r) => r.reservation_id))])
    : { data: [] };
  const rows = withBookings(
    found,
    (bookingsQ.data ?? []) as { id: string; booking_reference: string; arrival_date: string; departure_date: string }[],
  );
  const zones = new Map(((propQ.data ?? []) as { id: string; timezone: string }[]).map((p) => [p.id, p.timezone]));
  const tab = (active: boolean) =>
    `rounded px-3 py-1.5 text-sm ${active ? "bg-navy-900 text-white" : "bg-ink/5 text-ink hover:bg-ink/10"} focus-visible:outline-2 focus-visible:outline-primary`;

  return (
    <main className="max-w-4xl">
      <PageTitle>Guest requests</PageTitle>
      <PageIntro>
        Guests can ask for new dates, another room or something else from their booking link. A request changes nothing by itself. If you
        can do what the guest asks, change the booking first, then mark the request dealt with. If you cannot, decline it with a short note:
        the guest reads it on their booking page.
      </PageIntro>
      <div className="mt-6">
        <Notice search={search} currency="NGN" />
        {listQ.error && (
          <ErrorBanner className="mb-5">
            The requests could not be loaded. You may not have permission to change bookings. Reload the page to try again.
          </ErrorBanner>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2" role="navigation" aria-label="Which requests">
        <Link href="/app/requests" className={tab(view === "open")} aria-current={view === "open" ? "page" : undefined}>
          Waiting
        </Link>
        <Link
          href="/app/requests?view=answered"
          className={tab(view === "answered")}
          aria-current={view === "answered" ? "page" : undefined}
        >
          Answered
        </Link>
      </div>

      {rows.length === 0 && !listQ.error && (
        <EmptyState className="mt-8">{view === "open" ? "No requests are waiting." : "No requests have been answered yet."}</EmptyState>
      )}

      <ul className="mt-6 border-t border-line">
        {rows.map((r) => {
          const tz = zones.get(r.property_id) ?? "UTC";
          return (
            <li key={r.id} className="border-b border-line py-5">
              <p className="font-medium">{askText(r, formatDate)}</p>
              <p className="mt-1 text-sm">
                <Link href={`/app/reservations/${r.reservation_id}`} className={linkClass}>
                  {r.reservations?.booking_reference ?? "Open the booking"}
                </Link>
                <span className="text-muted">, sent {formatDateTime(r.created_at, tz)}</span>
              </p>
              {r.message && <p className="mt-2 text-sm">&ldquo;{r.message}&rdquo;</p>}
              {r.status === "open" ? (
                <form action={resolveChangeRequest} className="mt-3 grid gap-2 sm:max-w-md">
                  <input type="hidden" name="requestId" value={r.id} />
                  <label htmlFor={`n-${r.id}`} className="block text-xs text-muted">
                    Note for the guest (needed to decline)
                  </label>
                  <input id={`n-${r.id}`} name="note" maxLength={500} className={inputClass} />
                  <div className="flex flex-wrap gap-2">
                    <button type="submit" name="outcome" value="done" className={buttonPrimary}>
                      Mark dealt with
                    </button>
                    <button type="submit" name="outcome" value="declined" className={buttonQuiet}>
                      Decline
                    </button>
                  </div>
                </form>
              ) : (
                <p className="mt-2 text-sm text-muted">
                  {statusLabel(r.status)}
                  {r.resolved_at ? `, ${formatDateTime(r.resolved_at, tz)}` : ""}
                  {r.resolution_note ? `. Note: ${r.resolution_note}` : ""}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
