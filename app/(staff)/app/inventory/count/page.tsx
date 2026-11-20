import Link from "next/link";
import { InventoryNotice } from "@/components/staff/inventory-notice";
import { buttonPrimary, cardClass, EmptyState, ErrorBanner, inputClass, linkClass, PageIntro, PageTitle } from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { formatQty, parseItems } from "@/lib/staff/inventory";
import { loadInventoryContext } from "@/lib/staff/inventory-access";
import { saveStockCount } from "@/lib/staff/inventory-actions";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * A stock count (migration 150). Needs inventory.use. Type what is really on the shelf; leave a box empty to skip an item. Each difference is
 * written to the history and the system figure is set to what was counted.
 */
export default async function CountPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const { supabase, loadFailed, property, can } = await loadInventoryContext(first(search.property));
  const heading = <PageTitle>Stock count</PageTitle>;
  if (loadFailed || !property || !can.use)
    return (
      <main className="max-w-4xl">
        {heading}
        {loadFailed ? (
          <ErrorBanner className="mt-4">The hotels could not be loaded. Try again.</ErrorBanner>
        ) : (
          <p className="mt-4 max-w-prose text-muted">Counts are done by people who may use stock.</p>
        )}
      </main>
    );
  const itemsQ = await supabase
    .from("stock_items")
    .select("id, name, unit, kind, low_level, quantity, is_active")
    .eq("property_id", property.id)
    .eq("is_active", true)
    .order("name");
  const items = parseItems(itemsQ.data);

  return (
    <main className="max-w-4xl">
      {heading}
      <PageIntro>
        Type what is really on the shelf for each item you counted. Empty boxes are skipped. The system figure is changed to what you typed
        and every difference is kept in the history.
      </PageIntro>
      <p className="mt-2 text-sm">
        <Link href="/app/inventory" className={linkClass}>
          ← Stock
        </Link>
      </p>
      <div className="mt-5">
        <InventoryNotice search={search} />
      </div>
      {itemsQ.error && <ErrorBanner className="mb-5">Items could not be loaded. Reload the page.</ErrorBanner>}
      {items.length === 0 ? (
        <EmptyState>There are no items to count.</EmptyState>
      ) : (
        <form action={saveStockCount} className={cardClass}>
          <input type="hidden" name="propertyId" value={property.id} />
          <input type="hidden" name="key" value={crypto.randomUUID()} />
          <ul className="grid gap-2">
            {items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <label htmlFor={`count_${i.id}`}>
                  {i.name}{" "}
                  <span className="text-xs text-muted">
                    system: {formatQty(i.quantity)} {i.unit}
                  </span>
                </label>
                <input
                  id={`count_${i.id}`}
                  name={`count_${i.id}`}
                  inputMode="decimal"
                  placeholder={i.unit}
                  className={`${inputClass} w-28`}
                />
              </li>
            ))}
          </ul>
          <label className="mt-4 block text-xs" htmlFor="note">
            Note
            <input id="note" name="note" maxLength={200} className={`${inputClass} mt-1 w-full max-w-md`} />
          </label>
          <div className="mt-4">
            <PendingButton className={buttonPrimary}>Save count</PendingButton>
          </div>
        </form>
      )}
    </main>
  );
}
