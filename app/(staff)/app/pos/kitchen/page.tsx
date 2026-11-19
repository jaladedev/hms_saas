import Link from "next/link";
import { PosNotice } from "@/components/staff/pos-notice";
import { buttonQuiet, cardClass, EmptyState, ErrorBanner, linkClass, PageIntro, PageTitle, SectionTitle } from "@/components/staff/ui";
import { KITCHEN_LABEL, KITCHEN_NEXT, parseKitchen, waitText, type KitchenStatus } from "@/lib/staff/pos";
import { loadPosContext } from "@/lib/staff/pos-access";
import { setPosLineStatus } from "@/lib/staff/pos-actions";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const COLUMNS: KitchenStatus[] = ["new", "preparing", "ready"];

/** What the kitchen still has to make or hand over, oldest first. Orders already paid are included: the table may pay while food is coming. */
export default async function KitchenPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const { supabase, loadFailed, property, can } = await loadPosContext(first(search.property));
  const heading = <PageTitle>Kitchen queue</PageTitle>;
  if (loadFailed || !property)
    return (
      <main className="max-w-5xl">
        {heading}
        {loadFailed ? (
          <ErrorBanner className="mt-4">The hotels could not be loaded. Try again.</ErrorBanner>
        ) : (
          <p className="mt-4 max-w-prose text-muted">You do not have access to the restaurant and bar.</p>
        )}
      </main>
    );
  const queueQ = await supabase.rpc("pos_kitchen_queue", { p_property: property.id });
  const lines = parseKitchen(queueQ.data);
  const now = new Date();

  return (
    <main className="max-w-5xl">
      {heading}
      <PageIntro>Oldest first. Move a line one step at a time as the food is started, ready and handed over.</PageIntro>
      <p className="mt-2 flex gap-4 text-sm">
        <Link href="/app/pos" className={linkClass}>
          ← Restaurant &amp; bar
        </Link>
        <Link href="/app/pos/kitchen" className={linkClass}>
          Refresh
        </Link>
      </p>
      <div className="mt-5">
        <PosNotice search={search} />
      </div>
      {queueQ.error && <ErrorBanner className="mb-5">The queue could not be loaded. Reload the page.</ErrorBanner>}
      {lines.length === 0 && !queueQ.error && (
        <EmptyState>Nothing waiting. New items appear here when they are added to an order.</EmptyState>
      )}
      <div className="grid gap-6 md:grid-cols-3">
        {COLUMNS.map((status) => {
          const column = lines.filter((l) => l.status === status);
          const next = KITCHEN_NEXT[status];
          return (
            <section key={status} aria-label={KITCHEN_LABEL[status]}>
              <SectionTitle>
                {KITCHEN_LABEL[status]} ({column.length})
              </SectionTitle>
              <ul className="mt-3 grid gap-2">
                {column.map((l) => (
                  <li key={l.lineId} className={cardClass}>
                    <p className="font-medium">
                      {l.quantity} × {l.name}
                    </p>
                    {l.note && <p className="text-sm">{l.note}</p>}
                    <p className="text-xs text-muted">
                      {l.placeName} · {l.orderNo} · {waitText(l.createdAt, now)}
                    </p>
                    {can.sell && next && (
                      <form action={setPosLineStatus} className="mt-2">
                        <input type="hidden" name="lineId" value={l.lineId} />
                        <input type="hidden" name="status" value={next.to} />
                        <input type="hidden" name="back" value="kitchen" />
                        <button type="submit" className={buttonQuiet}>
                          {next.button}
                        </button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </main>
  );
}
