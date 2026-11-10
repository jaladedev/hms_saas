import Link from "next/link";
import { EmptyState, ErrorBanner, headRow, linkClass, PageIntro, PageTitle, thRowHead } from "@/components/staff/ui";
import { PlatformNotice } from "@/components/platform-notice";
import { shortDate } from "@/lib/platform/hotel";
import { createClient } from "@/lib/supabase/server";

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
  const rows = (Array.isArray(data) ? data : []) as Row[];

  return (
    <main className="max-w-5xl">
      <PageTitle>Hotels</PageTitle>
      <PageIntro>Hotel groups on the platform. This area never shows reservations, guests or payments.</PageIntro>
      <div className="mt-6">
        <PlatformNotice search={search} />
      </div>
      {error && <ErrorBanner className="mb-5">The list could not be loaded. Reload the page.</ErrorBanner>}
      {level.data === "admin" && (
        <p className="mb-4 text-sm">
          <Link href="/platform/new" className={linkClass}>
            Add a hotel
          </Link>
        </p>
      )}
      {rows.length === 0 ? (
        <EmptyState>{error ? "Nothing could be confirmed." : "No hotels yet."}</EmptyState>
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
