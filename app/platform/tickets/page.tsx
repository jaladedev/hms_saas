import Link from "next/link";
import { z } from "zod";
import { PlatformNotice } from "@/components/platform-notice";
import {
  buttonPrimary,
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
import { openTicket } from "@/lib/platform/actions";
import { shortDate } from "@/lib/platform/hotel";
import {
  openCount,
  PRIORITY_LABEL,
  readTickets,
  STATUS_LABEL,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  isTicketStatus,
} from "@/lib/platform/tickets";
import { createClient } from "@/lib/supabase/server";
import { PendingButton } from "@/components/ui/pending-button";

export const dynamic = "force-dynamic";

export default async function Tickets({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const status = typeof search.status === "string" && isTicketStatus(search.status) ? search.status : "";
  const hotel = typeof search.hotel === "string" && z.guid().safeParse(search.hotel).success ? search.hotel : "";
  const supabase = await createClient();
  const [list, tenants, level] = await Promise.all([
    supabase.rpc("platform_list_tickets", { p_tenant: hotel || undefined, p_status: status || undefined }),
    supabase.rpc("platform_list_tenants"),
    supabase.rpc("platform_level"),
  ]);
  const rows = readTickets(list.data);
  const hotels = ((Array.isArray(tenants.data) ? tenants.data : []) as { id: string; name: string }[]).map((h) => ({
    id: h.id,
    name: h.name,
  }));
  const admin = level.data === "admin";

  return (
    <main className="max-w-5xl">
      <PageTitle>Support tickets</PageTitle>
      <PageIntro>
        What the platform team is handling for each hotel. Tickets are internal: hotels do not see them, and they hold no guest, payment or
        secret.
      </PageIntro>
      <div className="mt-6">
        <PlatformNotice search={search} />
      </div>
      {list.error && <ErrorBanner className="mb-5">The tickets could not be loaded. Reload the page.</ErrorBanner>}

      <form method="get" role="search" className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="th" className="block text-sm">
            Hotel
          </label>
          <select id="th" name="hotel" defaultValue={hotel} className={inputClass}>
            <option value="">All hotels</option>
            {hotels.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="ts" className="block text-sm">
            Status
          </label>
          <select id="ts" name="status" defaultValue={status} className={inputClass}>
            <option value="">Any</option>
            {TICKET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <PendingButton className={buttonPrimary} pendingLabel="Filtering…">
          Filter
        </PendingButton>
        {(hotel || status) && (
          <Link href="/platform/tickets" className={linkClass}>
            Clear
          </Link>
        )}
      </form>

      {rows.length === 0 ? (
        <EmptyState>
          {list.error ? "Nothing could be confirmed." : hotel || status ? "No ticket matches that filter." : "No tickets yet."}
        </EmptyState>
      ) : (
        <>
          <p className="mb-2 text-sm text-muted">
            {rows.length} {rows.length === 1 ? "ticket" : "tickets"}, {openCount(rows)} still open or in progress.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={headRow}>
                  {["Ticket", "Hotel", "Priority", "Status", "Notes", "Opened"].map((h) => (
                    <th key={h} scope="col" className={thRowHead}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((k) => (
                  <tr key={k.id} className="border-b border-line">
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      <Link href={`/platform/tickets/${k.id}`} className={linkClass}>
                        {k.title}
                      </Link>
                      <span className="block font-mono text-xs text-muted">{k.number}</span>
                    </th>
                    <td className="py-2 pr-3">{k.tenant_name}</td>
                    <td className={`py-2 pr-3 ${k.priority === "high" ? "font-medium text-critical" : ""}`}>
                      {PRIORITY_LABEL[k.priority]}
                    </td>
                    <td className="py-2 pr-3">{STATUS_LABEL[k.status]}</td>
                    <td className="py-2 pr-3 tabular-nums">{k.notes}</td>
                    <td className="py-2 pr-3">{shortDate(k.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {admin ? (
        <section aria-labelledby="new" className="mt-10">
          <SectionTitle id="new">Open a ticket</SectionTitle>
          <form action={openTicket} className="mt-3 grid max-w-xl gap-3">
            <div>
              <label htmlFor="nt" className="block text-sm">
                Hotel
              </label>
              <select id="nt" name="tenantId" required defaultValue={hotel} className={inputClass}>
                <option value="" disabled>
                  Choose a hotel
                </option>
                {hotels.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="ni" className="block text-sm">
                Title
              </label>
              <input id="ni" name="title" required minLength={3} maxLength={120} className={inputClass} />
            </div>
            <div>
              <label htmlFor="nd" className="block text-sm">
                Details (optional)
              </label>
              <textarea id="nd" name="details" rows={4} maxLength={2000} className={inputClass} />
              <p className="mt-1 text-xs text-muted">
                What the hotel asked or what is wrong. Do not paste guest details, payment data or secrets.
              </p>
            </div>
            <div>
              <label htmlFor="np" className="block text-sm">
                Priority
              </label>
              <select id="np" name="priority" defaultValue="normal" className={inputClass}>
                {TICKET_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <PendingButton className={buttonPrimary} pendingLabel="Opening…">
                Open ticket
              </PendingButton>
            </div>
          </form>
        </section>
      ) : (
        <p className="mt-8 text-sm text-muted">Support accounts read tickets; a platform admin opens and updates them.</p>
      )}
    </main>
  );
}
