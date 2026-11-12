import { PendingButton } from "@/components/ui/pending-button";
import { buttonPrimary, buttonQuiet, ErrorBanner, inputClass, Notice, PageIntro, PageTitle } from "@/components/staff/ui";
import { deleteHotelPlace, saveHotelPlace } from "@/lib/staff/hotel-profile-actions";
import { MAX_PLACE_BODY, MAX_PLACE_NAME, MAX_PLACES } from "@/lib/staff/hotel-places";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Place = { id: string; property_id: string; name: string; body: string; is_active: boolean; sort_order: number };

/**
 * Places near the hotel for the guest homepage: a name and a line of text each, plain text only. People who may change the hotel
 * setup (property.configure) see the list; the database makes the final decision on every save.
 */
export default async function PlacesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const [propQ, placeQ] = await Promise.all([
    supabase.from("properties").select("id, name").order("name"),
    supabase.from("hotel_places").select("id, property_id, name, body, is_active, sort_order").order("sort_order").order("created_at"),
  ]);
  const properties = (propQ.data ?? []) as { id: string; name: string }[];
  const places = (placeQ.data ?? []) as Place[];
  const many = properties.length > 1;

  return (
    <main className="max-w-3xl">
      <PageTitle>Near the hotel</PageTitle>
      <PageIntro>
        Places a guest might want to visit, such as a hall, gardens or a landmark, shown in a &ldquo;Near the hotel&rdquo; section on your
        website&rsquo;s homepage. A name and a short line each, plain text only. Up to {MAX_PLACES} places; the ones switched on are shown,
        lowest order first.
      </PageIntro>
      <div className="mt-6">
        <Notice search={search} currency="NGN" />
      </div>
      {(propQ.error || placeQ.error) && <ErrorBanner className="mb-6">The places could not be loaded. Reload the page.</ErrorBanner>}

      {properties.map((p) => {
        const mine = places.filter((o) => o.property_id === p.id);
        return (
          <section key={p.id} className="mt-10 first:mt-0" aria-label={p.name}>
            {many && <h2 className="font-display text-2xl">{p.name}</h2>}
            <ul className="mt-4 space-y-4">
              {mine.map((o) => (
                <li key={o.id} className="rounded border border-line bg-white p-4">
                  <PlaceForm propertyId={p.id} place={o} />
                  <form action={deleteHotelPlace} className="mt-2">
                    <input type="hidden" name="placeId" value={o.id} />
                    <PendingButton className={buttonQuiet} pendingLabel="Deleting…">
                      Delete this place
                    </PendingButton>
                  </form>
                </li>
              ))}
            </ul>
            {mine.length === 0 && <p className="mt-4 text-sm text-muted">No places yet.</p>}
            {mine.length < MAX_PLACES && (
              <div className="mt-6 rounded border border-dashed border-line bg-white p-4">
                <h3 className="text-sm font-medium">Add a place</h3>
                <PlaceForm propertyId={p.id} place={null} />
              </div>
            )}
          </section>
        );
      })}
    </main>
  );
}

function PlaceForm({ propertyId, place }: { propertyId: string; place: Place | null }) {
  const id = place?.id ?? "new";
  return (
    <form action={saveHotelPlace} className="mt-3 grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="propertyId" value={propertyId} />
      <input type="hidden" name="placeId" value={place?.id ?? ""} />
      <label className="block text-sm sm:col-span-2" htmlFor={`n-${id}`}>
        Name
        <input
          id={`n-${id}`}
          name="name"
          required
          maxLength={MAX_PLACE_NAME}
          defaultValue={place?.name ?? ""}
          className={`${inputClass} mt-1`}
        />
      </label>
      <label className="block text-sm sm:col-span-2" htmlFor={`b-${id}`}>
        Short line (optional)
        <input id={`b-${id}`} name="body" maxLength={MAX_PLACE_BODY} defaultValue={place?.body ?? ""} className={`${inputClass} mt-1`} />
      </label>
      <label className="block text-sm" htmlFor={`s-${id}`}>
        Order (lower first)
        <input id={`s-${id}`} name="sort" type="number" step={1} defaultValue={place?.sort_order ?? 0} className={`${inputClass} mt-1`} />
      </label>
      <label className="flex items-center gap-2 self-end text-sm" htmlFor={`a-${id}`}>
        <input id={`a-${id}`} name="active" type="checkbox" defaultChecked={place ? place.is_active : true} className="accent-primary" />
        Switched on
      </label>
      <div className="sm:col-span-2">
        <PendingButton className={buttonPrimary} pendingLabel="Working…">
          {place ? "Save place" : "Add place"}
        </PendingButton>
      </div>
    </form>
  );
}
