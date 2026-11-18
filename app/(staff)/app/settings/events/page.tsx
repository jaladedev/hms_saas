import { PendingButton } from "@/components/ui/pending-button";
import { buttonPrimary, ErrorBanner, inputClass, Notice, PageIntro, PageTitle } from "@/components/staff/ui";
import { formatMoney } from "@/lib/guest-site/format";
import { saveEventTerms, saveVenue } from "@/lib/staff/event-actions";
import type { VenueRow } from "@/lib/staff/events";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Terms = { tax_percent: number; service_percent: number; deposit_percent: number; hold_hours: number };
const MAX_VENUES = 12;

/**
 * Venues the hotel hires out and the terms of a hire: tax and service charge, the deposit asked for, and how long a held slot is kept.
 * People who may change the hotel setup (property.configure) save; the database decides on every save. The tax and service
 * percentages start at 0: set them with the hotel's adviser before quoting anyone.
 */
export default async function EventSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const [propQ, venueQ] = await Promise.all([
    supabase.from("properties").select("id, name, currency").order("name"),
    supabase
      .from("hotel_venues")
      .select("id, property_id, name, body, capacity, hourly_rate_minor, day_rate_minor, bookable_online, is_active, sort_order")
      .order("sort_order")
      .order("created_at"),
  ]);
  const properties = (propQ.data ?? []) as { id: string; name: string; currency: string }[];
  const venues = (venueQ.data ?? []) as VenueRow[];
  const terms = await Promise.all(properties.map((p) => supabase.rpc("event_terms_get", { p_property: p.id })));
  const many = properties.length > 1;

  return (
    <main className="max-w-3xl">
      <PageTitle>Events and venues</PageTitle>
      <PageIntro>
        Halls, lawns and meeting rooms that clients can hire for a wedding, a conference or a party, with a price by the hour or by the day.
        A venue switched on for online booking lets a visitor see when it is free and hold it with a deposit; any active venue accepts an
        enquiry. The terms below are copied onto each quote, so changing them later never changes a quote already held or confirmed.
      </PageIntro>
      <div className="mt-6">
        <Notice search={search} currency="NGN" />
      </div>
      {(propQ.error || venueQ.error) && <ErrorBanner className="mb-6">The venues could not be loaded. Reload the page.</ErrorBanner>}

      {properties.map((p, i) => {
        const mine = venues.filter((v) => v.property_id === p.id);
        const t = (terms[i]?.data ?? null) as Terms | null;
        return (
          <section key={p.id} className="mt-10 first:mt-0" aria-label={p.name}>
            {many && <h2 className="font-display text-2xl">{p.name}</h2>}

            <h3 className="mt-4 text-sm font-medium">Terms of a hire</h3>
            <form action={saveEventTerms} className="mt-2 grid gap-3 rounded border border-line bg-white p-4 sm:grid-cols-4">
              <input type="hidden" name="propertyId" value={p.id} />
              <label className="block text-sm" htmlFor={`tax-${p.id}`}>
                Tax %
                <input id={`tax-${p.id}`} name="tax" required inputMode="decimal" defaultValue={String(t?.tax_percent ?? 0)} className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-sm" htmlFor={`svc-${p.id}`}>
                Service charge %
                <input id={`svc-${p.id}`} name="service" required inputMode="decimal" defaultValue={String(t?.service_percent ?? 0)} className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-sm" htmlFor={`dep-${p.id}`}>
                Deposit %
                <input id={`dep-${p.id}`} name="deposit" required inputMode="numeric" defaultValue={String(t?.deposit_percent ?? 30)} className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-sm" htmlFor={`hold-${p.id}`}>
                Hold lasts (hours)
                <input id={`hold-${p.id}`} name="holdHours" required inputMode="numeric" defaultValue={String(t?.hold_hours ?? 48)} className={`${inputClass} mt-1`} />
              </label>
              <p className="text-xs text-muted sm:col-span-4">
                Service charge is added to the price first, then tax is added to the price and the service charge together. Both start at 0.
              </p>
              <div className="sm:col-span-4">
                <PendingButton className={buttonPrimary} pendingLabel="Saving…">
                  Save terms
                </PendingButton>
              </div>
            </form>

            <h3 className="mt-8 text-sm font-medium">Venues</h3>
            <ul className="mt-2 space-y-4">
              {mine.map((v) => (
                <li key={v.id} className="rounded border border-line bg-white p-4">
                  <p className="text-sm text-muted">
                    {v.capacity} people
                    {v.hourly_rate_minor ? ` · ${formatMoney(v.hourly_rate_minor, p.currency)} an hour` : ""}
                    {v.day_rate_minor ? ` · ${formatMoney(v.day_rate_minor, p.currency)} a day` : ""}
                  </p>
                  <VenueForm propertyId={p.id} item={v} />
                </li>
              ))}
            </ul>
            {mine.length === 0 && <p className="mt-2 text-sm text-muted">No venues yet.</p>}
            {mine.length < MAX_VENUES && (
              <div className="mt-6 rounded border border-dashed border-line bg-white p-4">
                <h4 className="text-sm font-medium">Add a venue</h4>
                <VenueForm propertyId={p.id} item={null} />
              </div>
            )}
          </section>
        );
      })}
    </main>
  );
}

function VenueForm({ propertyId, item }: { propertyId: string; item: VenueRow | null }) {
  const id = item?.id ?? "new";
  return (
    <form action={saveVenue} className="mt-3 grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="propertyId" value={propertyId} />
      <input type="hidden" name="venueId" value={item?.id ?? ""} />
      <label className="block text-sm sm:col-span-2" htmlFor={`n-${id}`}>
        Name
        <input id={`n-${id}`} name="name" required maxLength={60} defaultValue={item?.name ?? ""} className={`${inputClass} mt-1`} />
      </label>
      <label className="block text-sm sm:col-span-2" htmlFor={`b-${id}`}>
        Short line (optional)
        <input id={`b-${id}`} name="body" maxLength={200} defaultValue={item?.body ?? ""} className={`${inputClass} mt-1`} />
      </label>
      <label className="block text-sm" htmlFor={`c-${id}`}>
        Capacity (people)
        <input id={`c-${id}`} name="capacity" required inputMode="numeric" defaultValue={item ? String(item.capacity) : ""} className={`${inputClass} mt-1`} />
      </label>
      <label className="block text-sm" htmlFor={`s-${id}`}>
        Order (lower first)
        <input id={`s-${id}`} name="sort" type="number" step={1} defaultValue={item?.sort_order ?? 0} className={`${inputClass} mt-1`} />
      </label>
      <label className="block text-sm" htmlFor={`h-${id}`}>
        Price an hour in naira (optional)
        <input id={`h-${id}`} name="hourly" inputMode="decimal" defaultValue={item?.hourly_rate_minor ? String(item.hourly_rate_minor / 100) : ""} className={`${inputClass} mt-1`} />
      </label>
      <label className="block text-sm" htmlFor={`d-${id}`}>
        Price a day in naira (optional)
        <input id={`d-${id}`} name="day" inputMode="decimal" defaultValue={item?.day_rate_minor ? String(item.day_rate_minor / 100) : ""} className={`${inputClass} mt-1`} />
      </label>
      <p className="text-xs text-muted sm:col-span-2">
        Give an hourly price, a daily price or both. When both are set, a booking is priced at whichever is cheaper for the time asked.
      </p>
      <label className="flex items-center gap-2 text-sm" htmlFor={`o-${id}`}>
        <input id={`o-${id}`} name="online" type="checkbox" defaultChecked={item?.bookable_online ?? false} className="accent-primary" />
        Bookable online with a deposit
      </label>
      <label className="flex items-center gap-2 text-sm" htmlFor={`a-${id}`}>
        <input id={`a-${id}`} name="active" type="checkbox" defaultChecked={item ? item.is_active : true} className="accent-primary" />
        Switched on
      </label>
      <div className="sm:col-span-2">
        <PendingButton className={buttonPrimary} pendingLabel="Saving…">
          {item ? "Save venue" : "Add venue"}
        </PendingButton>
      </div>
    </form>
  );
}
