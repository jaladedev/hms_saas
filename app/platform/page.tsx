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
import { PlatformNotice } from "@/components/platform-notice";
import { filterHotels, monthlyCounts, shortDate } from "@/lib/platform/hotel";
import { createClient } from "@/lib/supabase/server";
import { PendingButton } from "@/components/ui/pending-button";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  name: string;
  slug: string;
  status: string;
  created_at: string;
  properties: number;
  domains: number;
  domains_verified: number;
  active_owners: number;
  plan_code: string | null;
  subscription_status: string | null;
};

export default async function Hotels({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const [{ data, error }, level] = await Promise.all([supabase.rpc("platform_list_tenants"), supabase.rpc("platform_level")]);
  const all = (Array.isArray(data) ? data : []) as Row[];
  const q = typeof search.q === "string" ? search.q.trim().slice(0, 80) : "";
  const status = typeof search.status === "string" ? search.status : "";
  const rows = filterHotels(all, q, status);
  const statuses = [...new Set(all.map((r) => r.status))].sort();
  const growth = monthlyCounts(all, new Date());
  const peak = Math.max(1, ...growth.map((m) => m.count));
  // The overview tiles count every hotel, not just the ones a search shows.
  const tiles = [
    { label: "Total hotels", value: all.length },
    { label: "Active", value: all.filter((r) => r.status === "active").length },
    { label: "Suspended", value: all.filter((r) => r.status === "suspended").length },
    { label: "Properties", value: all.reduce((n, r) => n + r.properties, 0) },
  ];

  return (
    <main className="max-w-5xl">
      <PageTitle>Hotels</PageTitle>
      <PageIntro>Hotel groups on the platform. This area never shows reservations, guests or payments.</PageIntro>
      <div className="mt-6">
        <PlatformNotice search={search} />
      </div>
      {!error && all.length > 0 && (
        <dl aria-label="Platform totals" className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-2xl bg-navy-800 p-4 text-white">
              <dt className="text-sm text-white/80">{t.label}</dt>
              <dd className="mt-1 text-3xl font-semibold tabular-nums">{t.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {!error && all.length > 0 && (
        <section aria-labelledby="growth-title" className="mb-6 rounded-2xl border border-line bg-white p-5">
          <h2 id="growth-title" className="font-display text-lg">
            Hotels added per month
          </h2>
          <ul className="mt-4 grid grid-cols-6 items-end gap-3">
            {growth.map((m) => (
              <li key={m.key} className="flex flex-col items-center gap-1">
                <span className="text-xs tabular-nums text-muted">{m.count}</span>
                <span
                  aria-hidden="true"
                  className="block w-full rounded-t bg-navy-800"
                  style={{ height: `${Math.max(4, Math.round((m.count / peak) * 96))}px` }}
                />
                <span className="text-xs text-muted">
                  {m.label}
                  <span className="sr-only">
                    : {m.count} {m.count === 1 ? "hotel" : "hotels"} added
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {error && <ErrorBanner className="mb-5">The list could not be loaded. Reload the page.</ErrorBanner>}
      {level.data === "admin" && (
        <p className="mb-4 text-sm">
          <Link href="/platform/new" className={linkClass}>
            Add a hotel
          </Link>
        </p>
      )}
      {all.length > 0 && (
        <form method="get" role="search" className="mb-4 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="hq" className="block text-sm">
              Find a hotel
            </label>
            <input
              id="hq"
              name="q"
              type="search"
              defaultValue={q}
              maxLength={80}
              placeholder="Name, short name or plan"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="hs" className="block text-sm">
              Status
            </label>
            <select id="hs" name="status" defaultValue={status} className={inputClass}>
              <option value="">Any</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <PendingButton className={buttonPrimary} pendingLabel="Searching…">
            Search
          </PendingButton>
          {(q || status) && (
            <Link href="/platform" className={linkClass}>
              Clear
            </Link>
          )}
        </form>
      )}
      {rows.length === 0 ? (
        <EmptyState>
          {error ? "Nothing could be confirmed." : all.length > 0 ? "No hotel matches that search." : "No hotels yet."}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className={headRow}>
                <th scope="col" className={thRowHead}>
                  Hotel
                </th>
                <th scope="col" className={thRowHead}>
                  Status
                </th>
                <th scope="col" className={thRowHead}>
                  Properties
                </th>
                <th scope="col" className={thRowHead}>
                  Domains verified
                </th>
                <th scope="col" className={thRowHead}>
                  Owners
                </th>
                <th scope="col" className={thRowHead}>
                  Plan
                </th>
                <th scope="col" className={thRowHead}>
                  Created
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="border-b border-line">
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    <Link href={`/platform/${t.id}`} className={linkClass}>
                      {t.name}
                    </Link>
                    <span className="block text-xs text-muted">{t.slug}</span>
                  </th>
                  <td className="py-2 pr-3">{t.status}</td>
                  <td className="py-2 pr-3 tabular-nums">{t.properties}</td>
                  <td className="py-2 pr-3 tabular-nums">
                    {t.domains_verified} of {t.domains}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{t.active_owners}</td>
                  <td className="py-2 pr-3">
                    {t.plan_code ? `${t.plan_code}${t.subscription_status ? ` (${t.subscription_status})` : ""}` : "None"}
                  </td>
                  <td className="py-2 pr-3">{shortDate(t.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
