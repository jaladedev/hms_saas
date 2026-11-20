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
import {
  formatQty,
  ITEM_KIND_LABEL,
  ITEM_KINDS,
  parseItems,
  parseRecipes,
  parseSuppliers,
  RECIPE_LINE_SLOTS,
  type RecipeLine,
  type StockItem,
  type StockSupplier,
} from "@/lib/staff/inventory";
import { loadInventoryContext } from "@/lib/staff/inventory-access";
import { saveStockItem, saveStockRecipe, saveStockSupplier } from "@/lib/staff/inventory-actions";
import { parseMenu } from "@/lib/staff/pos";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function ItemForm({ propertyId, i }: { propertyId: string; i?: StockItem }) {
  const id = i?.id ?? "new";
  return (
    <form action={saveStockItem} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="propertyId" value={propertyId} />
      {i && <input type="hidden" name="itemId" value={i.id} />}
      <label className="block text-xs" htmlFor={`in-${id}`}>
        Item
        <input id={`in-${id}`} name="name" required maxLength={80} defaultValue={i?.name} className={`${inputClass} mt-1 w-44`} />
      </label>
      <label className="block text-xs" htmlFor={`iu-${id}`}>
        Unit
        <input
          id={`iu-${id}`}
          name="unit"
          required
          maxLength={20}
          defaultValue={i?.unit}
          placeholder="kg, l, piece"
          className={`${inputClass} mt-1 w-24`}
        />
      </label>
      <label className="block text-xs" htmlFor={`ik-${id}`}>
        Kind
        <select id={`ik-${id}`} name="kind" defaultValue={i?.kind ?? "food"} className={`${inputClass} mt-1`}>
          {ITEM_KINDS.map((k) => (
            <option key={k} value={k}>
              {ITEM_KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs" htmlFor={`il-${id}`}>
        Low level
        <input
          id={`il-${id}`}
          name="low"
          inputMode="decimal"
          defaultValue={i ? formatQty(i.lowLevel) : "0"}
          className={`${inputClass} mt-1 w-24`}
        />
      </label>
      <label className="flex items-center gap-1 text-sm">
        <input type="checkbox" name="active" defaultChecked={i?.isActive ?? true} /> On
      </label>
      <PendingButton className={buttonPrimary}>{i ? "Save" : "Add item"}</PendingButton>
    </form>
  );
}

function SupplierForm({ propertyId, s }: { propertyId: string; s?: StockSupplier }) {
  const id = s?.id ?? "new";
  return (
    <form action={saveStockSupplier} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="propertyId" value={propertyId} />
      {s && <input type="hidden" name="supplierId" value={s.id} />}
      <label className="block text-xs" htmlFor={`sn-${id}`}>
        Supplier
        <input id={`sn-${id}`} name="name" required maxLength={80} defaultValue={s?.name} className={`${inputClass} mt-1 w-44`} />
      </label>
      <label className="block text-xs" htmlFor={`sp-${id}`}>
        Phone
        <input id={`sp-${id}`} name="phone" maxLength={40} defaultValue={s?.phone ?? ""} className={`${inputClass} mt-1 w-36`} />
      </label>
      <label className="block text-xs" htmlFor={`so-${id}`}>
        Note
        <input id={`so-${id}`} name="note" maxLength={200} defaultValue={s?.note ?? ""} className={`${inputClass} mt-1 w-48`} />
      </label>
      <label className="flex items-center gap-1 text-sm">
        <input type="checkbox" name="active" defaultChecked={s?.isActive ?? true} /> On
      </label>
      <PendingButton className={buttonPrimary}>{s ? "Save" : "Add supplier"}</PendingButton>
    </form>
  );
}

function RecipeForm({ posItemId, name, items, lines }: { posItemId: string; name: string; items: StockItem[]; lines: RecipeLine[] }) {
  const slots = Array.from({ length: RECIPE_LINE_SLOTS }, (_, n) => n);
  return (
    <form action={saveStockRecipe} className={cardClass}>
      <input type="hidden" name="posItemId" value={posItemId} />
      <p className="font-medium">{name}</p>
      <ul className="mt-2 grid gap-2">
        {slots.map((n) => {
          const line = lines[n];
          return (
            <li key={n} className="flex flex-wrap items-end gap-2 text-xs">
              <label className="block" htmlFor={`ri-${posItemId}-${n}`}>
                Stock item
                <select
                  id={`ri-${posItemId}-${n}`}
                  name={`item_${n + 1}`}
                  defaultValue={line?.stockItemId ?? ""}
                  className={`${inputClass} mt-1`}
                >
                  <option value="">—</option>
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} ({i.unit})
                    </option>
                  ))}
                </select>
              </label>
              <label className="block" htmlFor={`rq-${posItemId}-${n}`}>
                Used per portion
                <input
                  id={`rq-${posItemId}-${n}`}
                  name={`qty_${n + 1}`}
                  inputMode="decimal"
                  defaultValue={line ? formatQty(line.quantity) : ""}
                  className={`${inputClass} mt-1 w-24`}
                />
              </label>
            </li>
          );
        })}
      </ul>
      <div className="mt-3">
        <PendingButton className={buttonPrimary}>Save recipe</PendingButton>
      </div>
    </form>
  );
}

/**
 * Stock items, suppliers and the recipe of each menu item (migration 150). Needs inventory.manage. Nothing is deleted: switch an item off and
 * it leaves the lists but its history stays. A recipe says how much of each stock item one portion of a menu item takes; leave all rows empty
 * to stop a menu item taking stock.
 */
export default async function InventorySetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const { supabase, loadFailed, property, can } = await loadInventoryContext(first(search.property));
  const heading = <PageTitle>Stock items, suppliers and recipes</PageTitle>;
  if (loadFailed || !property || !can.manage)
    return (
      <main className="max-w-4xl">
        {heading}
        {loadFailed ? (
          <ErrorBanner className="mt-4">The hotels could not be loaded. Try again.</ErrorBanner>
        ) : (
          <p className="mt-4 max-w-prose text-muted">Stock is set up by the owner or general manager.</p>
        )}
      </main>
    );
  const [itemsQ, suppliersQ, recipesQ, menuQ] = await Promise.all([
    supabase
      .from("stock_items")
      .select("id, name, unit, kind, low_level, quantity, is_active")
      .eq("property_id", property.id)
      .order("name"),
    supabase.from("stock_suppliers").select("id, name, phone, note, is_active").eq("property_id", property.id).order("name"),
    supabase.from("pos_item_stock").select("pos_item_id, stock_item_id, quantity").eq("property_id", property.id),
    supabase.rpc("pos_menu", { p_property: property.id }),
  ]);
  const items = parseItems(itemsQ.data);
  const activeItems = items.filter((i) => i.isActive);
  const suppliers = parseSuppliers(suppliersQ.data);
  const recipes = parseRecipes(recipesQ.data);
  const menu = parseMenu(menuQ.data);
  const posItems = menu.items.filter((i) => i.isActive);

  return (
    <main className="max-w-4xl">
      {heading}
      <PageIntro>
        Add what the hotel keeps in stock, the people it buys from, and what each menu item uses. Nothing is deleted: switch a row off and
        it leaves the lists but its history stays. Stock and purchasing must be in your hotel group&rsquo;s plan.
      </PageIntro>
      <p className="mt-2 text-sm">
        <Link href="/app/inventory" className={linkClass}>
          ← Stock
        </Link>
      </p>
      <div className="mt-5">
        <InventoryNotice search={search} />
      </div>
      {(itemsQ.error || suppliersQ.error || recipesQ.error) && (
        <ErrorBanner className="mb-5">Some details could not be loaded. Reload the page.</ErrorBanner>
      )}

      <section className="mt-6" aria-label="Items">
        <SectionTitle>Items</SectionTitle>
        <div className={`${cardClass} mt-3`}>
          <ItemForm propertyId={property.id} />
        </div>
        <ul className="mt-3 grid gap-2">
          {items.map((i) => (
            <li key={i.id} className={cardClass}>
              <ItemForm propertyId={property.id} i={i} />
              <p className="mt-1 text-xs text-muted">
                On hand: {formatQty(i.quantity)} {i.unit}. Change it with a count, not here.
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10" aria-label="Suppliers">
        <SectionTitle>Suppliers</SectionTitle>
        <div className={`${cardClass} mt-3`}>
          <SupplierForm propertyId={property.id} />
        </div>
        <ul className="mt-3 grid gap-2">
          {suppliers.map((s) => (
            <li key={s.id} className={cardClass}>
              <SupplierForm propertyId={property.id} s={s} />
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10" aria-label="Recipes">
        <SectionTitle>Recipes for menu items</SectionTitle>
        {posItems.length === 0 || activeItems.length === 0 ? (
          <EmptyState className="mt-3">Add stock items and restaurant menu items first, then say what each portion uses.</EmptyState>
        ) : (
          <ul className="mt-3 grid gap-2">
            {posItems.map((p) => (
              <li key={p.id}>
                <RecipeForm posItemId={p.id} name={p.name} items={activeItems} lines={recipes.filter((r) => r.posItemId === p.id)} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
