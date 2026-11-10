import { buttonPrimary, ErrorBanner, inputClass, Notice, PageIntro, PageTitle } from "@/components/staff/ui";
import { MAX_INTRO } from "@/lib/staff/hotel-profile";
import { saveHotelProfile } from "@/lib/staff/hotel-profile-actions";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Hotel details: the contact phone, contact email and short introduction guests see on the website before they search.
 * Everyone with access to the hotel can read them; only people who may change the hotel setup (property.configure) get the
 * form, and the database makes the final decision.
 */
export default async function HotelDetailsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const propQ = await supabase.from("properties").select("id, name, phone, contact_email, intro").order("name");
  const properties = (propQ.data ?? []) as { id: string; name: string; phone: string | null; contact_email: string | null; intro: string | null }[];
  const canEdit = new Map<string, boolean>();
  await Promise.all(properties.map(async (p) => {
    const { data } = await supabase.rpc("has_permission", { p_property: p.id, p_permission: "property.configure" });
    canEdit.set(p.id, data === true);
  }));
  const many = properties.length > 1;

  return (
    <main className="max-w-3xl">
      <PageTitle>Hotel details</PageTitle>
      <PageIntro>
        What guests see on your website before they search: a phone number, an email address and a short introduction. All three are optional.
        The hotel&rsquo;s name, address and check-in times are set when the hotel is created.
      </PageIntro>

      <div className="mt-6"><Notice search={search} currency="NGN" /></div>
      {propQ.error && <ErrorBanner className="mb-6">The details could not be loaded. Reload the page.</ErrorBanner>}

      {properties.map((p) => (
        <section key={p.id} className="mt-10 first:mt-0" aria-label={p.name}>
          {many && <h2 className="font-display text-2xl">{p.name}</h2>}
          {canEdit.get(p.id) === true ? (
            <form action={saveHotelProfile} className="mt-4 grid gap-4 sm:grid-cols-2">
              <input type="hidden" name="propertyId" value={p.id} />
              <div>
                <label htmlFor={`hp-${p.id}`} className="block text-sm">Phone</label>
                <input id={`hp-${p.id}`} name="phone" type="tel" maxLength={32} defaultValue={p.phone ?? ""} className={inputClass} />
                <p className="mt-1 text-xs text-muted">Digits, spaces and + ( ) - only, for example +234 802 000 0000.</p>
              </div>
              <div>
                <label htmlFor={`he-${p.id}`} className="block text-sm">Email</label>
                <input id={`he-${p.id}`} name="email" type="email" maxLength={254} defaultValue={p.contact_email ?? ""} className={inputClass} />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor={`hi-${p.id}`} className="block text-sm">Introduction</label>
                <textarea id={`hi-${p.id}`} name="intro" rows={4} maxLength={MAX_INTRO} defaultValue={p.intro ?? ""} className={inputClass} />
                <p className="mt-1 text-xs text-muted">Up to {MAX_INTRO} characters. Shown under the hotel name on the booking page.</p>
              </div>
              <div className="sm:col-span-2"><button type="submit" className={buttonPrimary}>Save details</button></div>
            </form>
          ) : (
            <dl className="mt-4 grid grid-cols-[8rem_1fr] gap-2 text-sm">
              <dt className="text-muted">Phone</dt><dd>{p.phone ?? "Not set"}</dd>
              <dt className="text-muted">Email</dt><dd>{p.contact_email ?? "Not set"}</dd>
              <dt className="text-muted">Introduction</dt><dd>{p.intro ?? "Not set"}</dd>
            </dl>
          )}
        </section>
      ))}
    </main>
  );
}
