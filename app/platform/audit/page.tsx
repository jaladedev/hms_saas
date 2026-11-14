import Link from "next/link";
import {
  buttonPrimary,
  EmptyState,
  ErrorBanner,
  headRow,
  inputClass,
  linkClass,
  PageIntro,
  PageTitle,
  thRowHead,
} from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import {
  AUDIT_PAGE_SIZE,
  auditTime,
  describeAction,
  describeFields,
  filterQuery,
  nextPageQuery,
  parseAuditFilter,
  readAuditPage,
} from "@/lib/platform/audit";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function PlatformAudit({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filter = parseAuditFilter(await searchParams);
  const supabase = await createClient();
  const [list, tenants] = await Promise.all([
    supabase.rpc("platform_audit_events", {
      p_tenant: filter.hotel || undefined,
      p_search: filter.search || undefined,
      p_from: filter.from || undefined,
      p_to: filter.to || undefined,
      p_before_at: filter.beforeAt || undefined,
      p_before_id: filter.beforeId || undefined,
      p_limit: AUDIT_PAGE_SIZE,
    }),
    supabase.rpc("platform_list_tenants"),
  ]);
  const page = readAuditPage(list.data);
  const hotels = ((Array.isArray(tenants.data) ? tenants.data : []) as { id: string; name: string }[]).map((h) => ({
    id: h.id,
    name: h.name,
  }));
  const filtered = Boolean(filter.hotel || filter.search || filter.from || filter.to);
  const last = page.events[page.events.length - 1];

  return (
    <main className="max-w-5xl">
      <PageTitle>Platform audit log</PageTitle>
      <PageIntro>
        What the platform team did, newest first: hotel groups, web addresses, payment accounts, invoices, tickets and access requests. A
        hotel&apos;s own staff work is on that hotel&apos;s setup history. Times are UTC. Ticket text and reasons are not shown here.
      </PageIntro>
      {list.error && <ErrorBanner className="mb-5">The log could not be loaded. Reload the page.</ErrorBanner>}

      <form method="get" role="search" className="mb-4 mt-6 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="ah" className="block text-sm">
            Hotel
          </label>
          <select id="ah" name="hotel" defaultValue={filter.hotel} className={inputClass}>
            <option value="">All hotels</option>
            {hotels.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="aq" className="block text-sm">
            Action contains
          </label>
          <input id="aq" name="q" defaultValue={filter.search} maxLength={60} placeholder="ticket, invoice…" className={inputClass} />
        </div>
        <div>
          <label htmlFor="af" className="block text-sm">
            From
          </label>
          <input id="af" name="from" type="date" defaultValue={filter.from} className={inputClass} />
        </div>
        <div>
          <label htmlFor="at" className="block text-sm">
            To
          </label>
          <input id="at" name="to" type="date" defaultValue={filter.to} className={inputClass} />
        </div>
        <PendingButton className={buttonPrimary} pendingLabel="Filtering…">
          Filter
        </PendingButton>
        {(filtered || filter.beforeAt) && (
          <Link href="/platform/audit" className={linkClass}>
            Clear
          </Link>
        )}
      </form>

      {page.events.length === 0 ? (
        <EmptyState>
          {list.error ? "Nothing could be confirmed." : filtered ? "No platform action matches that filter." : "No platform actions yet."}
        </EmptyState>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={headRow}>
                  {["When", "Who", "Action", "Hotel", "Changed"].map((h) => (
                    <th key={h} scope="col" className={thRowHead}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.events.map((e) => (
                  <tr key={e.id} className="border-b border-line align-top">
                    <th scope="row" className="py-2 pr-3 text-left font-normal tabular-nums">
                      {auditTime(e.at)}
                    </th>
                    <td className="py-2 pr-3">{e.actor ?? "System"}</td>
                    <td className="py-2 pr-3">
                      {describeAction(e.action)}
                      <span className="block font-mono text-xs text-muted">{e.action}</span>
                    </td>
                    <td className="py-2 pr-3">
                      {e.tenant_id && e.tenant_name ? (
                        <Link href={`/platform/${e.tenant_id}`} className={linkClass}>
                          {e.tenant_name}
                        </Link>
                      ) : (
                        <span className="text-muted">Platform</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-muted">{describeFields(e.fields) || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav aria-label="Pages" className="mt-4 flex gap-4 text-sm">
            {filter.beforeAt && (
              <Link href={filterQuery(filter) ? `/platform/audit?${filterQuery(filter)}` : "/platform/audit"} className={linkClass}>
                Back to newest
              </Link>
            )}
            {page.has_more && last && (
              <Link href={`/platform/audit?${nextPageQuery(filter, last)}`} className={linkClass}>
                Older
              </Link>
            )}
          </nav>
        </>
      )}
    </main>
  );
}
