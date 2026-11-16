import { PendingButton } from "@/components/ui/pending-button";
import { buttonPrimary, buttonQuiet, ErrorBanner, inputClass, Notice, PageIntro, PageTitle } from "@/components/staff/ui";
import { formatMoney } from "@/lib/guest-site/format";
import {
  deleteHotelExperience,
  removeExperiencePhoto,
  saveHotelExperience,
  uploadExperiencePhoto,
} from "@/lib/staff/hotel-profile-actions";
import { photoUrl } from "@/lib/staff/room-photos";
import { PhotoPicker } from "@/components/ui/photo-picker";
import { MAX_EXPERIENCE_BODY, MAX_EXPERIENCE_NAME, MAX_EXPERIENCES, unitLabel } from "@/lib/staff/experiences";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Experience = {
  id: string;
  property_id: string;
  name: string;
  body: string;
  price_minor: number;
  unit: string;
  is_active: boolean;
  sort_order: number;
  photo_path: string | null;
};

/**
 * Experiences a guest can ask for from their booking page: a name, a line, a price. People who may change the hotel setup
 * (property.configure) see the list; the database makes the final decision on every save.
 */
export default async function ExperiencesSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const supabase = await createClient();
  const [propQ, expQ] = await Promise.all([
    supabase.from("properties").select("id, name, currency").order("name"),
    supabase
      .from("hotel_experiences")
      .select("id, property_id, name, body, price_minor, unit, is_active, sort_order")
      .order("sort_order")
      .order("created_at"),
  ]);
  const properties = (propQ.data ?? []) as { id: string; name: string; currency: string }[];
  const rows = (expQ.data ?? []) as Experience[];
  const many = properties.length > 1;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

  return (
    <main className="max-w-3xl">
      <PageTitle>Experiences</PageTitle>
      <PageIntro>
        Things a guest can ask for, such as a city tour, a dinner or an airport pickup. Guests see them on your website and send a request
        from their booking page; nothing is paid online. You confirm each request under Experiences in the menu, and post it to the
        guest&rsquo;s folio once they are in the house. The price is copied onto each request, so changing it later does not change requests
        already sent. Up to {MAX_EXPERIENCES} experiences.
      </PageIntro>
      <div className="mt-6">
        <Notice search={search} currency="NGN" />
      </div>
      {(propQ.error || expQ.error) && <ErrorBanner className="mb-6">The experiences could not be loaded. Reload the page.</ErrorBanner>}

      {properties.map((p) => {
        const mine = rows.filter((o) => o.property_id === p.id);
        return (
          <section key={p.id} className="mt-10 first:mt-0" aria-label={p.name}>
            {many && <h2 className="font-display text-2xl">{p.name}</h2>}
            <ul className="mt-4 space-y-4">
              {mine.map((o) => (
                <li key={o.id} className="rounded border border-line bg-white p-4">
                  <p className="text-sm text-muted">
                    {formatMoney(o.price_minor, p.currency)} {unitLabel(o.unit)}
                  </p>
                  <ExperienceForm propertyId={p.id} item={o} />
                  <PhotoBlock
                    id={o.id}
                    path={o.photo_path}
                    name={o.name}
                    upload={uploadExperiencePhoto}
                    remove={removeExperiencePhoto}
                    supabaseUrl={supabaseUrl}
                  />
                  <form action={deleteHotelExperience} className="mt-2">
                    <input type="hidden" name="experienceId" value={o.id} />
                    <PendingButton className={buttonQuiet} pendingLabel="Deleting…">
                      Delete this experience
                    </PendingButton>
                  </form>
                </li>
              ))}
            </ul>
            {mine.length === 0 && <p className="mt-4 text-sm text-muted">No experiences yet.</p>}
            {mine.length < MAX_EXPERIENCES && (
              <div className="mt-6 rounded border border-dashed border-line bg-white p-4">
                <h3 className="text-sm font-medium">Add an experience</h3>
                <ExperienceForm propertyId={p.id} item={null} />
              </div>
            )}
          </section>
        );
      })}
    </main>
  );
}

function ExperienceForm({ propertyId, item }: { propertyId: string; item: Experience | null }) {
  const id = item?.id ?? "new";
  return (
    <form action={saveHotelExperience} className="mt-3 grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="propertyId" value={propertyId} />
      <input type="hidden" name="experienceId" value={item?.id ?? ""} />
      <label className="block text-sm sm:col-span-2" htmlFor={`n-${id}`}>
        Name
        <input
          id={`n-${id}`}
          name="name"
          required
          maxLength={MAX_EXPERIENCE_NAME}
          defaultValue={item?.name ?? ""}
          className={`${inputClass} mt-1`}
        />
      </label>
      <label className="block text-sm sm:col-span-2" htmlFor={`b-${id}`}>
        Short line (optional)
        <input
          id={`b-${id}`}
          name="body"
          maxLength={MAX_EXPERIENCE_BODY}
          defaultValue={item?.body ?? ""}
          className={`${inputClass} mt-1`}
        />
      </label>
      <label className="block text-sm" htmlFor={`p-${id}`}>
        Price in naira
        <input
          id={`p-${id}`}
          name="price"
          required
          inputMode="decimal"
          defaultValue={item ? String(item.price_minor / 100) : ""}
          className={`${inputClass} mt-1`}
        />
      </label>
      <label className="block text-sm" htmlFor={`u-${id}`}>
        Charged
        <select id={`u-${id}`} name="unit" defaultValue={item?.unit ?? "person"} className={`${inputClass} mt-1`}>
          <option value="person">Per person</option>
          <option value="booking">Once per booking</option>
        </select>
      </label>
      <label className="block text-sm" htmlFor={`s-${id}`}>
        Order (lower first)
        <input id={`s-${id}`} name="sort" type="number" step={1} defaultValue={item?.sort_order ?? 0} className={`${inputClass} mt-1`} />
      </label>
      <label className="flex items-center gap-2 self-end text-sm" htmlFor={`a-${id}`}>
        <input id={`a-${id}`} name="active" type="checkbox" defaultChecked={item ? item.is_active : true} className="accent-primary" />
        Switched on
      </label>
      <div className="sm:col-span-2">
        <PendingButton className={buttonPrimary} pendingLabel="Working…">
          {item ? "Save experience" : "Add experience"}
        </PendingButton>
      </div>
    </form>
  );
}

function PhotoBlock({
  id,
  path,
  name,
  upload,
  remove,
  supabaseUrl,
}: {
  id: string;
  path: string | null;
  name: string;
  upload: (formData: FormData) => Promise<void>;
  remove: (formData: FormData) => Promise<void>;
  supabaseUrl: string;
}) {
  return (
    <div className="mt-3 border-t border-line pt-3">
      {path ? (
        <div className="flex items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photoUrl(supabaseUrl, path)} alt={`${name} picture`} className="h-16 w-24 rounded border border-line object-cover" />
          <form action={remove}>
            <input type="hidden" name="id" value={id} />
            <PendingButton className={buttonQuiet} pendingLabel="Removing…">
              Remove picture
            </PendingButton>
          </form>
        </div>
      ) : (
        <p className="text-sm text-muted">No picture yet.</p>
      )}
      <form action={upload} className="mt-2 flex flex-wrap items-end gap-3">
        <input type="hidden" name="id" value={id} />
        <div>
          <label htmlFor={`ph-${id}`} className="block text-sm">
            {path ? "Replace the picture" : "Add a picture"} (JPEG, PNG or WebP, up to 2 MB)
          </label>
          <PhotoPicker id={`ph-${id}`} name="photo" required className={inputClass} previewClassName="h-16 w-24 !object-cover" />
        </div>
        <PendingButton className={buttonPrimary} pendingLabel="Uploading…">
          Save picture
        </PendingButton>
      </form>
    </div>
  );
}
