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
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { parseItems, parsePurchases, parseSuppliers, PURCHASE_LINE_SLOTS } from "@/lib/staff/inventory";
import { loadInventoryContext } from "@/lib/staff/inventory-access";
import { recordStockPurchase } from "@/lib/staff/inventory-actions";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Recording a delivery (migration 150). Needs inventory.manage. A purchase adds to stock and is final: it is never edited or deleted, so a
 * mistake is put right with a count. What it cost is shown only to people who may see money.
 */
export default async function PurchasesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const { supabase, loadFailed, property, can } = await loadInventoryContext(first(search.property));
  const heading = <PageTitle>Purchases</PageTitle>;
  if (loadFailed || !property || !can.manage)
    return (
      <main className="max-w-4xl">
        {heading}
        {loadFailed ? (
          <ErrorBanner className="mt-4">The hotels could not be loaded. Try again.</ErrorBanner>
        ) : (
          <p className="mt-4 max-w-prose text-muted">Purchases are recorded by the owner or general manager.</p>
        )}
      </main>
    );
  const [itemsQ, suppliersQ, purchasesQ] = await Promise.all([
    supabase
      .from("stock_items")
      .select("id, name, unit, kind, low_level, quantity, is_active")
      .eq("property_id", property.id)
      .order("name"),
    supabase.from("stock_suppliers").select("id, name, phone, note, is_active").eq("property_id", property.id).order("name"),
    can.money
      ? supabase
          .from("stock_purchases")
          .select("id, supplier_id, reference, purchased_on, total_minor")
          .eq("property_id", property.id)
          .order("created_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const items = parseItems(itemsQ.data).filter((i) => i.isActive);
  const suppliers = parseSuppliers(suppliersQ.data);
  const purchases = parsePurchases(purchasesQ.data);
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  const money = (m: number) => formatMoney(m, property.currency);
  const slots = Array.from({ length: PURCHASE_LINE_SLOTS }, (_, n) => n + 1);

  return (
    <main className="max-w-4xl">
      {heading}
      <PageIntro>
        Record what was delivered. Stock goes up by the quantities, and the cost is kept. A purchase cannot be edited or deleted afterwards;
        put a mistake right with a stock count. Leave unused rows empty.
      </PageIntro>
      <p className="mt-2 text-sm">
        <Link href="/app/inventory" className={linkClass}>
          ← Stock
        </Link>
      </p>
      <div className="mt-5">
        <InventoryNotice search={search} />
      </div>
      {(itemsQ.error || suppliersQ.error || purchasesQ.error) && (
        <ErrorBanner className="mb-5">Some details could not be loaded. Reload the page.</ErrorBanner>
      )}

      {items.length === 0 ? (
        <EmptyState>
          Add items first in{" "}
          <Link href="/app/settings/inventory" className={linkClass}>
            Items, suppliers and recipes
          </Link>
          .
        </EmptyState>
      ) : (
        <form action={recordStockPurchase} className={cardClass}>
          <input type="hidden" name="propertyId" value={property.id} />
          <input type="hidden" name="key" value={crypto.randomUUID()} />
          <div className="flex flex-wrap gap-3">
            <label className="block text-xs" htmlFor="supplierId">
              Supplier
              <select id="supplierId" name="supplierId" defaultValue="" className={`${inputClass} mt-1`}>
                <option value="">No supplier</option>
                {suppliers
                  .filter((s) => s.isActive)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="block text-xs" htmlFor="reference">
              Invoice or reference
              <input id="reference" name="reference" maxLength={60} className={`${inputClass} mt-1 w-44`} />
            </label>
            <label className="block text-xs" htmlFor="note">
              Note
              <input id="note" name="note" maxLength={200} className={`${inputClass} mt-1 w-56`} />
            </label>
          </div>
          <ul className="mt-4 grid gap-2">
            {slots.map((n) => (
              <li key={n} className="flex flex-wrap items-end gap-2 text-xs">
                <label className="block" htmlFor={`item_${n}`}>
                  Item {n}
                  <select id={`item_${n}`} name={`item_${n}`} defaultValue="" className={`${inputClass} mt-1`}>
                    <option value="">—</option>
                    {items.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name} ({i.unit})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block" htmlFor={`qty_${n}`}>
                  Quantity
                  <input id={`qty_${n}`} name={`qty_${n}`} inputMode="decimal" className={`${inputClass} mt-1 w-24`} />
                </label>
                <label className="block" htmlFor={`cost_${n}`}>
                  Cost each (₦, blank if unknown)
                  <input id={`cost_${n}`} name={`cost_${n}`} inputMode="decimal" className={`${inputClass} mt-1 w-28`} />
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-4">
            <PendingButton className={buttonPrimary}>Record purchase</PendingButton>
          </div>
        </form>
      )}

      {can.money && (
        <section className="mt-10" aria-label="Recent purchases">
          <SectionTitle>Recent purchases</SectionTitle>
          {purchases.length === 0 ? (
            <EmptyState className="mt-3">No purchases recorded yet.</EmptyState>
          ) : (
            <ul className="mt-3 grid gap-1 text-sm">
              {purchases.map((p) => (
                <li key={p.id} className="flex flex-wrap justify-between gap-2 border-b border-line py-1">
                  <span>
                    {formatDate(p.purchasedOn)} · {p.supplierId ? (supplierName.get(p.supplierId) ?? "Supplier") : "No supplier"}
                    {p.reference ? ` · ${p.reference}` : ""}
                  </span>
                  <span>{money(p.totalMinor)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
