import Link from "next/link";
import { PosNotice } from "@/components/staff/pos-notice";
import {
  buttonPrimary,
  cardClass,
  EmptyState,
  ErrorBanner,
  inputClass,
  linkClass,
  PageIntro,
  PageTitle,
  SectionTitle,
} from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { formatMoney } from "@/lib/guest-site/format";
import { openPosOrder } from "@/lib/staff/pos-actions";
import { loadPosContext } from "@/lib/staff/pos-access";
import { PLACE_KIND_LABEL, parseMenu, parseOpenOrders, waitText } from "@/lib/staff/pos";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Open orders and a new-order form (migration 148). The database decides who may see or do what; the buttons here only follow it. */
export default async function PosDeskPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const { supabase, loadFailed, property, can } = await loadPosContext(first(search.property));
  const heading = <PageTitle>Restaurant &amp; bar</PageTitle>;
  if (loadFailed)
    return (
      <main className="max-w-4xl">
        {heading}
        <ErrorBanner className="mt-4">The hotels could not be loaded. Try again.</ErrorBanner>
      </main>
    );
  if (!property)
    return (
      <main className="max-w-4xl">
        {heading}
        <p className="mt-4 max-w-prose text-muted">
          You do not have access to the restaurant and bar. Ask the owner or general manager to give you a role that includes it.
        </p>
      </main>
    );

  const [menuQ, ordersQ] = await Promise.all([
    supabase.rpc("pos_menu", { p_property: property.id }),
    supabase.rpc("pos_open_orders", { p_property: property.id }),
  ]);
  const menu = parseMenu(menuQ.data);
  const orders = parseOpenOrders(ordersQ.data);
  const places = menu.places.filter((p) => p.isActive);
  const now = new Date();
  const money = (m: number) => formatMoney(m, property.currency);
  const key = crypto.randomUUID();

  return (
    <main className="max-w-4xl">
      {heading}
      <PageIntro>
        Open an order for a table, the bar or room service, add items, and settle it: paid at the table, or put on a checked-in
        guest&rsquo;s room bill.
      </PageIntro>
      <nav className="mt-3 flex flex-wrap gap-4 text-sm" aria-label="Restaurant sections">
        <Link href="/app/pos/kitchen" className={linkClass}>
          Kitchen queue
        </Link>
        {can.report && (
          <Link href="/app/pos/sales" className={linkClass}>
            Sales
          </Link>
        )}
        {can.manage && (
          <Link href="/app/settings/pos" className={linkClass}>
            Menu and places
          </Link>
        )}
      </nav>
      <div className="mt-6">
        <PosNotice search={search} />
      </div>
      {(menuQ.error || ordersQ.error) && <ErrorBanner className="mb-6">The orders could not be loaded. Reload the page.</ErrorBanner>}

      {can.sell && (
        <section className="mt-2" aria-label="New order">
          <SectionTitle>New order</SectionTitle>
          {places.length === 0 ? (
            <EmptyState className="mt-3">
              No places yet.{" "}
              {can.manage ? (
                <>
                  Add tables, the bar or room service under{" "}
                  <Link href="/app/settings/pos" className={linkClass}>
                    menu and places
                  </Link>
                  .
                </>
              ) : (
                "Ask a manager to add them."
              )}
            </EmptyState>
          ) : (
            <form action={openPosOrder} className="mt-3 flex flex-wrap items-end gap-3">
              <input type="hidden" name="propertyId" value={property.id} />
              <input type="hidden" name="key" value={key} />
              <label className="block text-sm" htmlFor="place">
                Place
                <select id="place" name="placeId" required className={`${inputClass} mt-1`}>
                  {places.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({PLACE_KIND_LABEL[p.kind]})
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm" htmlFor="label">
                Name or note (optional)
                <input id="label" name="label" maxLength={60} className={`${inputClass} mt-1`} />
              </label>
              <PendingButton className={buttonPrimary} pendingLabel="Opening…">
                Open order
              </PendingButton>
            </form>
          )}
        </section>
      )}

      <section className="mt-8" aria-label="Open orders">
        <SectionTitle>Open orders ({orders.length})</SectionTitle>
        {orders.length === 0 ? (
          <EmptyState className="mt-3">No open orders.</EmptyState>
        ) : (
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {orders.map((o) => (
              <li key={o.id} className={cardClass}>
                <Link href={`/app/pos/orders/${o.id}`} className="block">
                  <p className="font-medium">
                    {o.placeName}
                    {o.guestLabel ? ` · ${o.guestLabel}` : ""}
                  </p>
                  <p className="text-sm text-muted">
                    {o.orderNo} · {o.lines} {o.lines === 1 ? "line" : "lines"} · open {waitText(o.openedAt, now)}
                  </p>
                  <p className="mt-1 font-semibold tabular-nums">{money(o.subtotalMinor)}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
