import Link from "next/link";
import { PlatformNotice } from "@/components/platform-notice";
import {
  buttonPrimary,
  buttonQuiet,
  EmptyState,
  ErrorBanner,
  headRow,
  inputClass,
  linkClass,
  PageIntro,
  PageTitle,
  SectionTitle,
  thRowHead,
} from "@/components/staff/ui";
import {
  ACCESS_HOURS,
  ACCESS_STATUS_LABEL,
  awaitingDecision,
  MAX_DECISION_NOTE,
  MAX_REASON,
  MIN_REASON,
  readAccess,
  timeLeft,
} from "@/lib/platform/access";
import { decideAccess, endAccess, requestAccess } from "@/lib/platform/actions";
import { shortDate } from "@/lib/platform/hotel";
import { readTickets } from "@/lib/platform/tickets";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * How platform staff get to look at a hotel's setup. There is no login-as: an approved request opens a read-only view of the
 * setup (no guests, payments or secrets) for 1, 4 or 24 hours, and every request, decision and view is on record. An admin other than
 * the person asking approves or denies. Support people see their own requests; admins see all of them.
 */
export default async function AccessRequests({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const [list, tenants, tickets, level] = await Promise.all([
    supabase.rpc("platform_list_access"),
    supabase.rpc("platform_list_tenants"),
    supabase.rpc("platform_list_tickets"),
    supabase.rpc("platform_level"),
  ]);
  const rows = readAccess(list.data);
  const hotels = ((Array.isArray(tenants.data) ? tenants.data : []) as { id: string; name: string }[]).map((h) => ({
    id: h.id,
    name: h.name,
  }));
  const openTickets = readTickets(tickets.data).filter((k) => k.status === "open" || k.status === "in_progress");
  const admin = level.data === "admin";
  const waiting = admin ? awaitingDecision(rows) : [];
  const now = new Date();

  return (
    <main className="max-w-5xl">
      <PageTitle>Access requests</PageTitle>
      <PageIntro>
        To look at how a hotel is set up, ask here. Nobody ever signs in as a hotel user, and no guest, payment or secret is shown. An admin
        other than you approves the request; once approved you can open a read-only view of the hotel&rsquo;s setup until the time runs out.
        Every request, decision and view is recorded.
      </PageIntro>
      <div className="mt-6">
        <PlatformNotice search={search} />
      </div>
      {(list.error || tenants.error) && <ErrorBanner className="mb-5">The requests could not be loaded. Reload the page.</ErrorBanner>}

      {waiting.length > 0 && (
        <section aria-labelledby="await" className="mb-8">
          <h2 id="await" className="font-display text-xl">
            Waiting for a decision ({waiting.length})
          </h2>
          <ul className="mt-3 space-y-3">
            {waiting.map((r) => (
              <li key={r.id} className="rounded border border-line bg-white p-4 text-sm">
                <p>
                  <span className="font-medium">{r.requested_by_email ?? "A platform user"}</span> asks to look at{" "}
                  <span className="font-medium">{r.tenant_name}</span> for {r.hours} {r.hours === 1 ? "hour" : "hours"}
                  {r.ticket_number ? ` (ticket ${r.ticket_number})` : ""}.
                </p>
                <p className="mt-1 whitespace-pre-line text-muted">&ldquo;{r.reason}&rdquo;</p>
                {r.mine ? (
                  <p className="mt-2 text-xs text-muted">This is your request: another admin has to decide it.</p>
                ) : (
                  <form action={decideAccess} className="mt-3 flex flex-wrap items-end gap-2">
                    <input type="hidden" name="requestId" value={r.id} />
                    <div>
                      <label htmlFor={`n-${r.id}`} className="block text-xs text-muted">
                        Note (optional)
                      </label>
                      <input id={`n-${r.id}`} name="note" maxLength={MAX_DECISION_NOTE} className={inputClass} />
                    </div>
                    <button type="submit" name="decision" value="approved" className={buttonPrimary}>
                      Approve
                    </button>
                    <button type="submit" name="decision" value="denied" className={buttonQuiet}>
                      Deny
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Ask for access">
        <SectionTitle>Ask to look at a hotel&rsquo;s setup</SectionTitle>
        <form action={requestAccess} className="mt-3 grid max-w-2xl gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="ah" className="block text-sm">
              Hotel
            </label>
            <select id="ah" name="tenantId" required className={`${inputClass} w-full`}>
              <option value="">Choose a hotel</option>
              {hotels.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="ahr" className="block text-sm">
              For how long
            </label>
            <select id="ahr" name="hours" defaultValue="1" className={`${inputClass} w-full`}>
              {ACCESS_HOURS.map((h) => (
                <option key={h} value={h}>
                  {h} {h === 1 ? "hour" : "hours"}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="ar" className="block text-sm">
              Why you need to look ({MIN_REASON} to {MAX_REASON} characters)
            </label>
            <textarea
              id="ar"
              name="reason"
              required
              minLength={MIN_REASON}
              maxLength={MAX_REASON}
              rows={3}
              className={`${inputClass} w-full`}
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="at" className="block text-sm">
              Related ticket (optional, must be for the same hotel)
            </label>
            <select id="at" name="ticketId" className={`${inputClass} w-full`}>
              <option value="">None</option>
              {openTickets.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.number}: {k.tenant_name}, {k.title}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <button type="submit" className={buttonPrimary}>
              Send request
            </button>
          </div>
        </form>
      </section>

      <section aria-label="Requests" className="mt-10">
        <SectionTitle>{admin ? "All requests" : "Your requests"}</SectionTitle>
        {rows.length === 0 ? (
          <EmptyState className="mt-3">{list.error ? "Nothing could be confirmed." : "No requests yet."}</EmptyState>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={headRow}>
                  {["Hotel", "Asked by", "Why", "Status", "Views", ""].map((h) => (
                    <th key={h || "actions"} scope="col" className={thRowHead}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const left = timeLeft(r, now);
                  return (
                    <tr key={r.id} className="border-b border-line align-top">
                      <th scope="row" className="py-2 pr-3 text-left font-normal">
                        {r.tenant_name}
                        <span className="block text-xs text-muted">
                          {shortDate(r.requested_at)}, {r.hours} {r.hours === 1 ? "hour" : "hours"}
                        </span>
                      </th>
                      <td className="py-2 pr-3">{r.mine ? "You" : (r.requested_by_email ?? "")}</td>
                      <td className="max-w-xs py-2 pr-3 text-muted">{r.reason}</td>
                      <td className="py-2 pr-3">
                        {ACCESS_STATUS_LABEL[r.status]}
                        {left ? <span className="block text-xs text-muted">{left}</span> : null}
                        {r.decided_by_email ? (
                          <span className="block text-xs text-muted">
                            by {r.decided_by_email}
                            {r.decision_note ? `: ${r.decision_note}` : ""}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{r.views}</td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-2">
                          {r.status === "approved" && r.mine && left ? (
                            <Link href={`/platform/access/${r.id}`} className={linkClass}>
                              Open setup
                            </Link>
                          ) : null}
                          {(r.status === "pending" && r.mine) || r.status === "approved" ? (
                            <form action={endAccess}>
                              <input type="hidden" name="requestId" value={r.id} />
                              <button type="submit" className={linkClass}>
                                {r.status === "pending" ? "Withdraw" : admin && !r.mine ? "Revoke" : "End now"}
                              </button>
                            </form>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
