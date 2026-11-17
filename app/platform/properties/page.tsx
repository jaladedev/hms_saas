import type { Metadata } from "next";
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
import { filterProperties, readProperties } from "@/lib/platform/hotel";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Properties" };

/** Every property of every hotel group, read only. Like the rest of /platform it never shows reservations, guests or payments. */
export default async function Properties({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_list_properties");
  const all = readProperties(data);
  const q = typeof search.q === "string" ? search.q.trim().slice(0, 80) : "";
  const status = typeof search.status === "string" ? search.status : "";
  const rows = filterProperties(all, q, status);
  const statuses = [...new Set(all.map((r) => r.status))].sort();

  return (
    <main className="max-w-6xl">
      <PageTitle>Properties</PageTitle>
      <PageIntro>Every property on the platform, with the hotel group it belongs to. Open a hotel to change anything.</PageIntro>
      {error && <ErrorBanner className="mt-6">The list could not be loaded. Reload the page.</ErrorBanner>}
      {all.length > 0 && (
        <form method="get" role="search" className="mb-4 mt-6 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="pq" className="block text-sm">
              Find a property
            </label>
            <input
              id="pq"
              name="q"
              type="search"
              defaultValue={q}
              maxLength={80}
              placeholder="Name, code, hotel, town or host"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="ps" className="block text-sm">
              Status
            </label>
            <select id="ps" name="status" defaultValue={status} className={inputClass}>
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
            <Link href="/platform/properties" className={linkClass}>
              Clear
            </Link>
          )}
        </form>
      )}
      {rows.length === 0 ? (
        <EmptyState>
          {error ? "Nothing could be confirmed." : all.length > 0 ? "No property matches that search." : "No properties yet."}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className={headRow}>
                <th scope="col" className={thRowHead}>
                  Property
                </th>
                <th scope="col" className={thRowHead}>
                  Hotel group
                </th>
                <th scope="col" className={thRowHead}>
                  Place
                </th>
                <th scope="col" className={thRowHead}>
                  Time zone
                </th>
                <th scope="col" className={thRowHead}>
                  Currency
                </th>
                <th scope="col" className={thRowHead}>
                  Status
                </th>
                <th scope="col" className={thRowHead}>
                  Guest site
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-b border-line">
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    {p.name}
                    <span className="block text-xs text-muted">{p.code}</span>
                  </th>
                  <td className="py-2 pr-3">
                    <Link href={`/platform/${p.tenant_id}`} className={linkClass}>
                      {p.tenant_name}
                    </Link>
                    {p.tenant_status !== "active" ? <span className="block text-xs text-muted">{p.tenant_status}</span> : null}
                  </td>
                  <td className="py-2 pr-3">
                    {p.city}, {p.state}
                  </td>
                  <td className="py-2 pr-3">{p.timezone}</td>
                  <td className="py-2 pr-3">{p.currency}</td>
                  <td className="py-2 pr-3">{p.status}</td>
                  <td className="py-2 pr-3 break-all">{p.host ?? "None"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
