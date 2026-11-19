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
import { minorToInput } from "@/lib/staff/money-input";
import { PLACE_KINDS, PLACE_KIND_LABEL, parseMenu, type Menu } from "@/lib/staff/pos";
import { loadPosContext } from "@/lib/staff/pos-access";
import { savePosCategory, savePosItem, savePosPlace } from "@/lib/staff/pos-actions";

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function CategoryForm({ propertyId, c }: { propertyId: string; c?: Menu["categories"][number] }) {
  const id = c?.id ?? "new";
  return (
    <form action={savePosCategory} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="propertyId" value={propertyId} />
      {c && <input type="hidden" name="categoryId" value={c.id} />}
      <label className="block text-xs" htmlFor={`cn-${id}`}>
        Category
        <input id={`cn-${id}`} name="name" required maxLength={60} defaultValue={c?.name} className={`${inputClass} mt-1 w-44`} />
      </label>
      <label className="block text-xs" htmlFor={`cs-${id}`}>
        Order
        <input
          id={`cs-${id}`}
          name="sort"
          type="number"
          min={0}
          max={1000}
          defaultValue={c?.sortOrder ?? 0}
          className={`${inputClass} mt-1 w-20`}
        />
      </label>
      <label className="flex items-center gap-1 text-sm">
        <input type="checkbox" name="active" defaultChecked={c?.isActive ?? true} /> On
      </label>
      <PendingButton className={buttonPrimary}>{c ? "Save" : "Add category"}</PendingButton>
    </form>
  );
}

function ItemForm({ propertyId, menu, i }: { propertyId: string; menu: Menu; i?: Menu["items"][number] }) {
  const id = i?.id ?? "new";
  return (
    <form action={savePosItem} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="propertyId" value={propertyId} />
      {i && <input type="hidden" name="itemId" value={i.id} />}
      <label className="block text-xs" htmlFor={`in-${id}`}>
        Item
        <input id={`in-${id}`} name="name" required maxLength={80} defaultValue={i?.name} className={`${inputClass} mt-1 w-44`} />
      </label>
      <label className="block text-xs" htmlFor={`ic-${id}`}>
        Category
        <select id={`ic-${id}`} name="categoryId" required defaultValue={i?.categoryId} className={`${inputClass} mt-1`}>
          {menu.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs" htmlFor={`ip-${id}`}>
        Price (₦)
        <input
          id={`ip-${id}`}
          name="price"
          required
          inputMode="decimal"
          defaultValue={i ? minorToInput(i.priceMinor) : ""}
          className={`${inputClass} mt-1 w-28`}
        />
      </label>
      <label className="block text-xs" htmlFor={`is-${id}`}>
        Order
        <input
          id={`is-${id}`}
          name="sort"
          type="number"
          min={0}
          max={1000}
          defaultValue={i?.sortOrder ?? 0}
          className={`${inputClass} mt-1 w-20`}
        />
      </label>
      <label className="flex items-center gap-1 text-sm">
        <input type="checkbox" name="active" defaultChecked={i?.isActive ?? true} /> On
      </label>
      <PendingButton className={buttonPrimary}>{i ? "Save" : "Add item"}</PendingButton>
    </form>
  );
}

function PlaceForm({ propertyId, p }: { propertyId: string; p?: Menu["places"][number] }) {
  const id = p?.id ?? "new";
  return (
    <form action={savePosPlace} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="propertyId" value={propertyId} />
      {p && <input type="hidden" name="placeId" value={p.id} />}
      <label className="block text-xs" htmlFor={`pn-${id}`}>
        Place
        <input id={`pn-${id}`} name="name" required maxLength={40} defaultValue={p?.name} className={`${inputClass} mt-1 w-40`} />
      </label>
      <label className="block text-xs" htmlFor={`pk-${id}`}>
        Kind
        <select id={`pk-${id}`} name="kind" defaultValue={p?.kind ?? "table"} className={`${inputClass} mt-1`}>
          {PLACE_KINDS.map((k) => (
            <option key={k} value={k}>
              {PLACE_KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1 text-sm">
        <input type="checkbox" name="active" defaultChecked={p?.isActive ?? true} /> On
      </label>
      <PendingButton className={buttonPrimary}>{p ? "Save" : "Add place"}</PendingButton>
    </form>
  );
}

/**
 * The menu and the places orders belong to (migration 148). Needs pos.manage. Nothing is deleted: switch a category, item or place off and it
 * leaves the order screen but stays on past orders. A new price applies to new lines only; lines already on an order keep the price they had.
 */
export default async function PosSetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const { supabase, loadFailed, property, can } = await loadPosContext(first(search.property));
  const heading = <PageTitle>Restaurant menu and places</PageTitle>;
  if (loadFailed || !property || !can.manage)
    return (
      <main className="max-w-4xl">
        {heading}
        {loadFailed ? (
          <ErrorBanner className="mt-4">The hotels could not be loaded. Try again.</ErrorBanner>
        ) : (
          <p className="mt-4 max-w-prose text-muted">The menu is set up by the owner or general manager.</p>
        )}
      </main>
    );
  const menuQ = await supabase.rpc("pos_menu", { p_property: property.id });
  const menu = parseMenu(menuQ.data);

  return (
    <main className="max-w-4xl">
      {heading}
      <PageIntro>
        Set up the places orders belong to (tables, the bar, room service) and the menu. Nothing is deleted: switch a row off and it leaves
        the order screen but stays on past orders. A new price applies to new lines only. Restaurant and bar must be in your hotel
        group&rsquo;s plan.
      </PageIntro>
      <p className="mt-2 text-sm">
        <Link href="/app/pos" className={linkClass}>
          ← Restaurant &amp; bar
        </Link>
      </p>
      <div className="mt-5">
        <PosNotice search={search} />
      </div>
      {menuQ.error && <ErrorBanner className="mb-5">The menu could not be loaded. Reload the page.</ErrorBanner>}

      <section className="mt-6" aria-label="Places">
        <SectionTitle>Places</SectionTitle>
        <div className={`${cardClass} mt-3`}>
          <PlaceForm propertyId={property.id} />
        </div>
        <ul className="mt-3 grid gap-2">
          {menu.places.map((p) => (
            <li key={p.id} className={cardClass}>
              <PlaceForm propertyId={property.id} p={p} />
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10" aria-label="Categories">
        <SectionTitle>Categories</SectionTitle>
        <div className={`${cardClass} mt-3`}>
          <CategoryForm propertyId={property.id} />
        </div>
        <ul className="mt-3 grid gap-2">
          {menu.categories.map((c) => (
            <li key={c.id} className={cardClass}>
              <CategoryForm propertyId={property.id} c={c} />
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10" aria-label="Items">
        <SectionTitle>Items</SectionTitle>
        {menu.categories.length === 0 ? (
          <EmptyState className="mt-3">Add a category first, then items inside it.</EmptyState>
        ) : (
          <>
            <div className={`${cardClass} mt-3`}>
              <ItemForm propertyId={property.id} menu={menu} />
            </div>
            <ul className="mt-3 grid gap-2">
              {menu.items.map((i) => (
                <li key={i.id} className={cardClass}>
                  <ItemForm propertyId={property.id} menu={menu} i={i} />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}
