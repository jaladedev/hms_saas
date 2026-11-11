import { buttonPrimary, buttonQuiet, ErrorBanner, inputClass, Notice, PageIntro, PageTitle } from "@/components/staff/ui";
import { MAX_BADGE, MAX_BODY, MAX_OFFERS, MAX_TITLE, offerWindow } from "@/lib/staff/hotel-offers";
import { deleteHotelOffer, saveHotelOffer } from "@/lib/staff/hotel-profile-actions";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Offer = {
  id: string;
  property_id: string;
  title: string;
  body: string;
  badge: string | null;
  valid_from: string | null;
  valid_to: string | null;
  is_active: boolean;
  sort_order: number;
};

/**
 * Offers shown on the guest homepage: a title, a line of text, an optional badge and an optional window of dates. An offer is a
 * message only; it never changes a price (use Rates or a discount for that). People who may change the hotel setup
 * (property.configure) see the list; the database makes the final decision on every save.
 */
export default async function OffersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const [propQ, offerQ] = await Promise.all([
    supabase.from("properties").select("id, name").order("name"),
    supabase
      .from("hotel_offers")
      .select("id, property_id, title, body, badge, valid_from, valid_to, is_active, sort_order")
      .order("sort_order")
      .order("created_at"),
  ]);
  const properties = (propQ.data ?? []) as { id: string; name: string }[];
  const offers = (offerQ.data ?? []) as Offer[];
  const many = properties.length > 1;

  return (
    <main className="max-w-3xl">
      <PageTitle>Offers</PageTitle>
      <PageIntro>
        Short promotions on your website&rsquo;s homepage, such as a weekend package. An offer is a message only: it does not change any
        price. To change a price, use Rates; to give a guest a discount on a booking, use a discount. Up to {MAX_OFFERS} offers; the
        homepage shows the first six that are switched on and inside their dates.
      </PageIntro>
      <div className="mt-6">
        <Notice search={search} currency="NGN" />
      </div>
      {(propQ.error || offerQ.error) && <ErrorBanner className="mb-6">The offers could not be loaded. Reload the page.</ErrorBanner>}

      {properties.map((p) => {
        const mine = offers.filter((o) => o.property_id === p.id);
        return (
          <section key={p.id} className="mt-10 first:mt-0" aria-label={p.name}>
            {many && <h2 className="font-display text-2xl">{p.name}</h2>}
            <ul className="mt-4 space-y-4">
              {mine.map((o) => (
                <li key={o.id} className="rounded border border-line bg-white p-4">
                  <OfferForm propertyId={p.id} offer={o} />
                  <form action={deleteHotelOffer} className="mt-2">
                    <input type="hidden" name="offerId" value={o.id} />
                    <button type="submit" className={buttonQuiet}>
                      Delete this offer
                    </button>
                  </form>
                </li>
              ))}
            </ul>
            {mine.length === 0 && <p className="mt-4 text-sm text-muted">No offers yet.</p>}
            {mine.length < MAX_OFFERS && (
              <div className="mt-6 rounded border border-dashed border-line bg-white p-4">
                <h3 className="text-sm font-medium">Add an offer</h3>
                <OfferForm propertyId={p.id} offer={null} />
              </div>
            )}
          </section>
        );
      })}
    </main>
  );
}

function OfferForm({ propertyId, offer }: { propertyId: string; offer: Offer | null }) {
  const id = offer?.id ?? "new";
  return (
    <form action={saveHotelOffer} className="mt-3 grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="propertyId" value={propertyId} />
      <input type="hidden" name="offerId" value={offer?.id ?? ""} />
      <label className="block text-sm sm:col-span-2" htmlFor={`t-${id}`}>
        Title
        <input
          id={`t-${id}`}
          name="title"
          required
          maxLength={MAX_TITLE}
          defaultValue={offer?.title ?? ""}
          className={`${inputClass} mt-1`}
        />
      </label>
      <label className="block text-sm sm:col-span-2" htmlFor={`b-${id}`}>
        Text (optional)
        <textarea
          id={`b-${id}`}
          name="body"
          rows={2}
          maxLength={MAX_BODY}
          defaultValue={offer?.body ?? ""}
          className={`${inputClass} mt-1`}
        />
      </label>
      <label className="block text-sm" htmlFor={`g-${id}`}>
        Badge (optional, such as &ldquo;10% off&rdquo;)
        <input id={`g-${id}`} name="badge" maxLength={MAX_BADGE} defaultValue={offer?.badge ?? ""} className={`${inputClass} mt-1`} />
      </label>
      <label className="block text-sm" htmlFor={`s-${id}`}>
        Order (lower first)
        <input id={`s-${id}`} name="sort" type="number" step={1} defaultValue={offer?.sort_order ?? 0} className={`${inputClass} mt-1`} />
      </label>
      <label className="block text-sm" htmlFor={`f-${id}`}>
        Shown from (optional)
        <input id={`f-${id}`} name="validFrom" type="date" defaultValue={offer?.valid_from ?? ""} className={`${inputClass} mt-1`} />
      </label>
      <label className="block text-sm" htmlFor={`u-${id}`}>
        Shown until (optional)
        <input id={`u-${id}`} name="validTo" type="date" defaultValue={offer?.valid_to ?? ""} className={`${inputClass} mt-1`} />
      </label>
      <label className="flex items-center gap-2 text-sm sm:col-span-2" htmlFor={`a-${id}`}>
        <input id={`a-${id}`} name="active" type="checkbox" defaultChecked={offer ? offer.is_active : true} className="accent-primary" />
        Switched on
        {offer && <span className="text-xs text-muted">(showing: {offerWindow(offer.valid_from, offer.valid_to)})</span>}
      </label>
      <div className="sm:col-span-2">
        <button type="submit" className={buttonPrimary}>
          {offer ? "Save offer" : "Add offer"}
        </button>
      </div>
    </form>
  );
}
