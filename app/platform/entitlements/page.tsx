import Link from "next/link";
import { EmptyState, ErrorBanner, headRow, linkClass, PageIntro, PageTitle, thRowHead } from "@/components/staff/ui";
import { flagCell, gridKeys, readOverview, type FlagCell } from "@/lib/platform/hotel";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const CELL: Record<FlagCell, { text: string; className: string }> = {
  on: { text: "On", className: "text-ink" },
  off: { text: "Off", className: "font-medium text-critical" },
  "default-on": { text: "On (default)", className: "text-muted" },
  unset: { text: "Not set", className: "text-muted" },
};

/** Which hotel has which feature flag, in one grid. Read only: a flag is changed on the hotel's own page, by an admin. */
export default async function Entitlements() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_entitlements_overview");
  const overview = readOverview(data);
  const keys = gridKeys(overview);

  return (
    <main className="max-w-6xl">
      <PageTitle>Entitlements</PageTitle>
      <PageIntro>
        Every hotel against every feature flag. An enforced flag with no setting works, shown as &ldquo;On (default)&rdquo;; an
        &ldquo;Off&rdquo; has switched that feature off for the hotel. Flags that are not enforced are only recorded and switch nothing. To
        change one, open the hotel.
      </PageIntro>
      {error && <ErrorBanner className="my-5">The grid could not be loaded. Reload the page.</ErrorBanner>}
      {overview.hotels.length === 0 ? (
        <EmptyState className="mt-6">{error ? "Nothing could be confirmed." : "No hotels yet."}</EmptyState>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className={headRow}>
                <th scope="col" className={thRowHead}>
                  Hotel
                </th>
                <th scope="col" className={thRowHead}>
                  Plan
                </th>
                {keys.map((k) => (
                  <th key={k} scope="col" className={thRowHead}>
                    <span className="font-mono text-xs">{k}</span>
                    {!overview.enforced.includes(k) && <span className="block text-xs font-normal text-muted">not enforced</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {overview.hotels.map((h) => (
                <tr key={h.id} className="border-b border-line">
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    <Link href={`/platform/${h.id}`} className={linkClass}>
                      {h.name}
                    </Link>
                    <span className="block text-xs text-muted">{h.status === "active" ? h.slug : `${h.slug} (${h.status})`}</span>
                  </th>
                  <td className="py-2 pr-3">
                    {h.plan_code ? `${h.plan_code}${h.subscription_status ? ` (${h.subscription_status})` : ""}` : "None"}
                  </td>
                  {keys.map((k) => {
                    const c = CELL[flagCell(h.entitlements, k, overview.enforced)];
                    return (
                      <td key={k} className={`py-2 pr-3 ${c.className}`}>
                        {c.text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
