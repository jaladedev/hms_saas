import Link from "next/link";
import { InventoryNotice } from "@/components/staff/inventory-notice";
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
import { formatDateTime } from "@/lib/staff/format";
import {
  formatQty,
  ITEM_KIND_LABEL,
  MOVEMENT_LABEL,
  parseItems,
  parseMovements,
  USAGE_REASONS,
  WASTE_REASONS,
  type StockItem,
} from "@/lib/staff/inventory";
import { loadInventoryContext } from "@/lib/staff/inventory-access";
import { recordStockOut } from "@/lib/staff/inventory-actions";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function OutForm({ item }: { item: StockItem }) {
  return (
    <form action={recordStockOut} className="mt-3 flex flex-wrap items-end gap-2 text-xs">
      <input type="hidden" name="itemId" value={item.id} />
      <input type="hidden" name="key" value={crypto.randomUUID()} />
      <label className="block" htmlFor={`k-${item.id}`}>
        Take out
        <select id={`k-${item.id}`} name="kind" className={`${inputClass} mt-1`}>
          <option value="usage">Used</option>
          <option value="waste">Wasted</option>
        </select>
      </label>
      <label className="block" htmlFor={`q-${item.id}`}>
        Quantity ({item.unit})
        <input id={`q-${item.id}`} name="quantity" required inputMode="decimal" className={`${inputClass} mt-1 w-24`} />
      </label>
      <label className="block" htmlFor={`r-${item.id}`}>
        Reason
        <select id={`r-${item.id}`} name="reason" className={`${inputClass} mt-1`}>
          <optgroup label="If used">
            {USAGE_REASONS.map((r) => (
              <option key={`u-${r}`} value={r}>
                {r}
              </option>
            ))}
          </optgroup>
          <optgroup label="If wasted">
            {WASTE_REASONS.map((r) => (
              <option key={`w-${r}`} value={r}>
                {r}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      <label className="block" htmlFor={`n-${item.id}`}>
        Note
        <input id={`n-${item.id}`} name="note" maxLength={200} className={`${inputClass} mt-1 w-40`} />
      </label>
      <PendingButton className={buttonPrimary}>Record</PendingButton>
    </form>
  );
}

/**
 * What is on the shelf (migration 150). Anyone with stock access reads it; people who may use stock record what was used or wasted. Sales from
 * the restaurant take stock off by themselves, and a sale may take the balance below zero (shown in red until a count corrects it).
 */
export default async function InventoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const { supabase, loadFailed, property, can } = await loadInventoryContext(first(search.property));
  const heading = <PageTitle>Stock</PageTitle>;
  if (loadFailed || !property)
    return (
      <main className="max-w-4xl">
        {heading}
        {loadFailed ? (
          <ErrorBanner className="mt-4">The hotels could not be loaded. Try again.</ErrorBanner>
        ) : (
          <p className="mt-4 max-w-prose text-muted">Stock is for the owner, general manager, front desk, housekeeping and accountant.</p>
        )}
      </main>
    );
  const [itemsQ, movesQ] = await Promise.all([
    supabase
      .from("stock_items")
      .select("id, name, unit, kind, low_level, quantity, is_active")
      .eq("property_id", property.id)
      .order("name"),
    supabase
      .from("stock_movements")
      .select("id, item_id, kind, change, balance_after, reason, created_at")
      .eq("property_id", property.id)
      .order("created_at", { ascending: false })
      .limit(25),
  ]);
  const items = parseItems(itemsQ.data);
  const active = items.filter((i) => i.isActive);
  const names = new Map(items.map((i) => [i.id, i]));
  const moves = parseMovements(movesQ.data);
  const lowCount = active.filter((i) => i.low).length;

  return (
    <main className="max-w-4xl">
      {heading}
      <PageIntro>
        What is in stock now. Restaurant sales take stock off by themselves using each menu item&rsquo;s recipe. Record what housekeeping,
        the minibar or the kitchen used, and anything wasted. A count sets the real figure when the shelf and the system disagree.
      </PageIntro>
      <p className="mt-2 flex flex-wrap gap-4 text-sm">
        {can.manage && (
          <Link href="/app/inventory/purchases" className={linkClass}>
            Purchases
          </Link>
        )}
        {can.use && (
          <Link href="/app/inventory/count" className={linkClass}>
            Stock count
          </Link>
        )}
        {can.report && (
          <Link href="/app/inventory/report" className={linkClass}>
            Stock report
          </Link>
        )}
        {can.manage && (
          <Link href="/app/settings/inventory" className={linkClass}>
            Items, suppliers and recipes
          </Link>
        )}
      </p>
      <div className="mt-5">
        <InventoryNotice search={search} />
      </div>
      {(itemsQ.error || movesQ.error) && <ErrorBanner className="mb-5">Stock could not be loaded. Reload the page.</ErrorBanner>}
      {lowCount > 0 && (
        <p role="status" className="mb-5 border-l-4 border-amber-500 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {lowCount} {lowCount === 1 ? "item is" : "items are"} at or below the low level.
        </p>
      )}

      <section aria-label="Items">
        <SectionTitle>Items</SectionTitle>
        {active.length === 0 ? (
          <EmptyState className="mt-3">
            No items yet.{" "}
            {can.manage ? (
              <Link href="/app/settings/inventory" className={linkClass}>
                Add the first one.
              </Link>
            ) : (
              "The owner or general manager adds them."
            )}
          </EmptyState>
        ) : (
          <ul className="mt-3 grid gap-2">
            {active.map((i) => (
              <li key={i.id} className={cardClass}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">
                    {i.name} <span className="text-xs font-normal text-muted">{ITEM_KIND_LABEL[i.kind]}</span>
                  </p>
                  <p className={`text-sm ${i.quantity < 0 ? "text-red-700" : ""}`}>
                    <strong>{formatQty(i.quantity)}</strong> {i.unit}
                    {i.low && (
                      <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
                        {i.quantity < 0 ? "Below zero, count it" : "Low"}
                      </span>
                    )}
                  </p>
                </div>
                {i.lowLevel > 0 && (
                  <p className="text-xs text-muted">
                    Low at {formatQty(i.lowLevel)} {i.unit}
                  </p>
                )}
                {can.use && <OutForm item={i} />}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10" aria-label="Recent movements">
        <SectionTitle>Recent movements</SectionTitle>
        {moves.length === 0 ? (
          <EmptyState className="mt-3">Nothing has moved yet.</EmptyState>
        ) : (
          <ul className="mt-3 grid gap-1 text-sm">
            {moves.map((m) => (
              <li key={m.id} className="flex flex-wrap justify-between gap-2 border-b border-line py-1">
                <span>
                  {MOVEMENT_LABEL[m.kind] ?? m.kind}: {names.get(m.itemId)?.name ?? "Item"}
                  {m.reason ? ` (${m.reason})` : ""}
                </span>
                <span className="text-muted">
                  {m.change > 0 ? "+" : ""}
                  {formatQty(m.change)} → {formatQty(m.balanceAfter)} · {formatDateTime(m.createdAt, property.timezone)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
