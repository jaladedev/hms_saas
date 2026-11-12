import { EmptyState, ErrorBanner, PageIntro, PageTitle, SectionTitle } from "@/components/staff/ui";
import { readWindows, stateLabel, viewsLabel, type AccessWindow } from "@/lib/staff/platform-access";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function when(iso: string): string {
  return iso.slice(0, 16).replace("T", " ") + " UTC";
}

/**
 * When someone from the platform opened this hotel's setup. A notice, read-only: each window was approved by a platform admin, ran
 * for a set time and is on record. Only people who may change the hotel setup (property.configure) can read it; the database answers
 * nobody else. Who asked, who approved and why stay inside the platform.
 */
export default async function PlatformAccessPage() {
  const supabase = await createClient();
  const propQ = await supabase.from("properties").select("id, name").order("name");
  const properties = (propQ.data ?? []) as { id: string; name: string }[];
  // Access belongs to the hotel group, so a group with several hotels would repeat it: read it once, from the first hotel that answers.
  let windows: AccessWindow[] | null = null;
  for (const p of properties) {
    const { data, error } = await supabase.rpc("hotel_platform_access", { p_property: p.id });
    if (!error) {
      windows = readWindows(data);
      break;
    }
  }
  const open = (windows ?? []).filter((w) => w.state === "open");
  const openUntil = open[0]?.until;

  return (
    <main className="max-w-3xl">
      <PageTitle>Platform access</PageTitle>
      <PageIntro>
        Now and then someone from the platform team may need to look at how your hotel is set up in order to help you. Each time, another
        platform administrator approves it first, it lasts for a set time (1, 4 or 24 hours) and it is recorded. They can read your setup
        only: room types, rates, tax rules, features and domains. They cannot sign in as you, and they never see guests, bookings, payments,
        invoices, emails, staff names or passwords. This page lists each time it happened.
      </PageIntro>
      {propQ.error && <ErrorBanner className="mt-6">The list could not be loaded. Reload the page.</ErrorBanner>}
      {!propQ.error && windows === null && (
        <EmptyState className="mt-6">This list is shown to the hotel&rsquo;s owner and general manager.</EmptyState>
      )}
      {windows !== null && (
        <section className="mt-8" aria-label="Platform access windows">
          <SectionTitle>{open.length > 0 ? "Open now" : "History"}</SectionTitle>
          {openUntil && <p className="mt-2 text-sm">The platform can read your setup until {when(openUntil)}.</p>}
          {windows.length === 0 ? (
            <EmptyState className="mt-3">The platform has not opened your setup.</EmptyState>
          ) : (
            <ul className="mt-3 border-t border-line">
              {windows.map((w) => (
                <li key={w.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line py-3 text-sm">
                  <span className="font-medium">{when(w.approved_at)}</span>
                  <span className={w.state === "open" ? "font-medium" : "text-muted"}>{stateLabel(w.state)}</span>
                  <span className="text-muted">
                    {w.state === "ended_early" && w.ended_at ? `Ended ${when(w.ended_at)}` : `Until ${when(w.until)}`}
                  </span>
                  <span className="text-muted">
                    {viewsLabel(w.views)}
                    {w.last_viewed_at ? `, last ${when(w.last_viewed_at)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
