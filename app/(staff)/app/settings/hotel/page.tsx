import { ThemePicker } from "@/components/staff/theme-picker";
import { buttonPrimary, buttonQuiet, ErrorBanner, inputClass, Notice, PageIntro, PageTitle } from "@/components/staff/ui";
import { MAX_FACILITIES, MAX_FACILITY_LENGTH } from "@/lib/staff/hotel-extras";
import { MAX_INTRO, timeInput } from "@/lib/staff/hotel-profile";
import { removeHotelLogo, saveHotelBasics, saveHotelExtras, saveHotelProfile, uploadHotelLogo } from "@/lib/staff/hotel-profile-actions";
import { photoUrl } from "@/lib/staff/room-photos";
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
  const propQ = await supabase
    .from("properties")
    .select(
      "id, name, address, city, state, check_in_time, check_out_time, phone, contact_email, intro, logo_path, theme, theme_primary, theme_font_display, theme_font_body, facilities, social_instagram, social_facebook",
    )
    .order("name");
  const properties = (propQ.data ?? []) as {
    id: string;
    name: string;
    address: string | null;
    city: string;
    state: string;
    check_in_time: string;
    check_out_time: string;
    phone: string | null;
    contact_email: string | null;
    intro: string | null;
    logo_path: string | null;
    theme: string | null;
    theme_primary: string | null;
    theme_font_display: string | null;
    theme_font_body: string | null;
    facilities: string[];
    social_instagram: string | null;
    social_facebook: string | null;
  }[];
  const canEdit = new Map<string, boolean>();
  await Promise.all(
    properties.map(async (p) => {
      const { data } = await supabase.rpc("has_permission", { p_property: p.id, p_permission: "property.configure" });
      canEdit.set(p.id, data === true);
    }),
  );
  const many = properties.length > 1;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

  return (
    <main className="max-w-3xl">
      <PageTitle>Hotel details</PageTitle>
      <PageIntro>
        What guests see on your website before they search: the hotel&rsquo;s name, address and check-in and check-out times, and an
        optional phone number, email address, short introduction, facilities and links to your Instagram and Facebook.
      </PageIntro>

      <div className="mt-6">
        <Notice search={search} currency="NGN" />
      </div>
      {propQ.error && <ErrorBanner className="mb-6">The details could not be loaded. Reload the page.</ErrorBanner>}

      {properties.map((p) => (
        <section key={p.id} className="mt-10 first:mt-0" aria-label={p.name}>
          {many && <h2 className="font-display text-2xl">{p.name}</h2>}
          {canEdit.get(p.id) === true ? (
            <>
              <div className="mt-4">
                <h3 className="text-sm font-medium">Logo</h3>
                {p.logo_path ? (
                  <div className="mt-2 flex items-center gap-4">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={photoUrl(supabaseUrl, p.logo_path)} alt={`${p.name} logo`} className="h-12 max-w-48 object-contain" />
                    <form action={removeHotelLogo}>
                      <input type="hidden" name="propertyId" value={p.id} />
                      <button type="submit" className={buttonQuiet}>
                        Remove logo
                      </button>
                    </form>
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-muted">No logo yet. Guests see the hotel name in the header.</p>
                )}
                <form action={uploadHotelLogo} className="mt-3 flex flex-wrap items-end gap-3">
                  <input type="hidden" name="propertyId" value={p.id} />
                  <div>
                    <label htmlFor={`bl-${p.id}`} className="block text-sm">
                      {p.logo_path ? "Replace the logo" : "Upload a logo"}
                    </label>
                    <input
                      id={`bl-${p.id}`}
                      name="logo"
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      required
                      className={inputClass}
                    />
                    <p className="mt-1 text-xs text-muted">
                      JPEG, PNG or WebP, up to 2 MB. A wide logo with a plain background works best.
                    </p>
                  </div>
                  <button type="submit" className={buttonPrimary}>
                    Upload
                  </button>
                </form>
              </div>
              <ThemePicker
                propertyId={p.id}
                name={p.name}
                current={p.theme}
                primary={p.theme_primary}
                fontDisplay={p.theme_font_display}
                fontBody={p.theme_font_body}
              />
              <form action={saveHotelBasics} className="mt-8 grid gap-4 sm:grid-cols-2">
                <input type="hidden" name="propertyId" value={p.id} />
                <div className="sm:col-span-2">
                  <label htmlFor={`bn-${p.id}`} className="block text-sm">
                    Hotel name
                  </label>
                  <input id={`bn-${p.id}`} name="name" required maxLength={120} defaultValue={p.name} className={inputClass} />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor={`ba-${p.id}`} className="block text-sm">
                    Address (optional)
                  </label>
                  <input id={`ba-${p.id}`} name="address" maxLength={200} defaultValue={p.address ?? ""} className={inputClass} />
                </div>
                <div>
                  <label htmlFor={`bc-${p.id}`} className="block text-sm">
                    Town
                  </label>
                  <input id={`bc-${p.id}`} name="city" required maxLength={80} defaultValue={p.city} className={inputClass} />
                </div>
                <div>
                  <label htmlFor={`bs-${p.id}`} className="block text-sm">
                    State
                  </label>
                  <input id={`bs-${p.id}`} name="state" required maxLength={80} defaultValue={p.state} className={inputClass} />
                </div>
                <div>
                  <label htmlFor={`bi-${p.id}`} className="block text-sm">
                    Check-in from
                  </label>
                  <input
                    id={`bi-${p.id}`}
                    name="checkIn"
                    type="time"
                    required
                    defaultValue={timeInput(p.check_in_time)}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor={`bo-${p.id}`} className="block text-sm">
                    Check-out by
                  </label>
                  <input
                    id={`bo-${p.id}`}
                    name="checkOut"
                    type="time"
                    required
                    defaultValue={timeInput(p.check_out_time)}
                    className={inputClass}
                  />
                </div>
                <div className="sm:col-span-2">
                  <button type="submit" className={buttonPrimary}>
                    Save name, address and times
                  </button>
                </div>
              </form>
              <form action={saveHotelProfile} className="mt-8 grid gap-4 sm:grid-cols-2">
                <input type="hidden" name="propertyId" value={p.id} />
                <div>
                  <label htmlFor={`hp-${p.id}`} className="block text-sm">
                    Phone
                  </label>
                  <input id={`hp-${p.id}`} name="phone" type="tel" maxLength={32} defaultValue={p.phone ?? ""} className={inputClass} />
                  <p className="mt-1 text-xs text-muted">Digits, spaces and + ( ) - only, for example +234 802 000 0000.</p>
                </div>
                <div>
                  <label htmlFor={`he-${p.id}`} className="block text-sm">
                    Email
                  </label>
                  <input
                    id={`he-${p.id}`}
                    name="email"
                    type="email"
                    maxLength={254}
                    defaultValue={p.contact_email ?? ""}
                    className={inputClass}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor={`hi-${p.id}`} className="block text-sm">
                    Introduction
                  </label>
                  <textarea
                    id={`hi-${p.id}`}
                    name="intro"
                    rows={4}
                    maxLength={MAX_INTRO}
                    defaultValue={p.intro ?? ""}
                    className={inputClass}
                  />
                  <p className="mt-1 text-xs text-muted">Up to {MAX_INTRO} characters. Shown under the hotel name on the booking page.</p>
                </div>
                <div className="sm:col-span-2">
                  <button type="submit" className={buttonPrimary}>
                    Save contact details
                  </button>
                </div>
              </form>
              <form action={saveHotelExtras} className="mt-8 grid gap-4 sm:grid-cols-2">
                <input type="hidden" name="propertyId" value={p.id} />
                <div className="sm:col-span-2">
                  <label htmlFor={`hf-${p.id}`} className="block text-sm">
                    Hotel facilities
                  </label>
                  <textarea
                    id={`hf-${p.id}`}
                    name="facilities"
                    rows={4}
                    defaultValue={p.facilities.join("\n")}
                    aria-describedby={`hf-note-${p.id}`}
                    className={inputClass}
                  />
                  <p id={`hf-note-${p.id}`} className="mt-1 text-xs text-muted">
                    What the hotel as a whole offers, such as Pool, Restaurant, Bar, Gym or Conference room. One per line, up to{" "}
                    {MAX_FACILITIES}, {MAX_FACILITY_LENGTH} characters each. Room amenities are set on each room type.
                  </p>
                </div>
                <div>
                  <label htmlFor={`hig-${p.id}`} className="block text-sm">
                    Instagram
                  </label>
                  <input
                    id={`hig-${p.id}`}
                    name="instagram"
                    maxLength={120}
                    defaultValue={p.social_instagram ?? ""}
                    placeholder="@yourhotel"
                    autoCapitalize="none"
                    spellCheck={false}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor={`hfb-${p.id}`} className="block text-sm">
                    Facebook
                  </label>
                  <input
                    id={`hfb-${p.id}`}
                    name="facebook"
                    maxLength={120}
                    defaultValue={p.social_facebook ?? ""}
                    placeholder="yourhotel"
                    autoCapitalize="none"
                    spellCheck={false}
                    className={inputClass}
                  />
                </div>
                <p className="text-xs text-muted sm:col-span-2">
                  Type the name or paste the page address. Only Instagram and Facebook pages are accepted, and they open in a new tab for
                  guests.
                </p>
                <div className="sm:col-span-2">
                  <button type="submit" className={buttonPrimary}>
                    Save facilities and links
                  </button>
                </div>
              </form>
            </>
          ) : (
            <dl className="mt-4 grid grid-cols-[8rem_1fr] gap-2 text-sm">
              <dt className="text-muted">Name</dt>
              <dd>{p.name}</dd>
              <dt className="text-muted">Address</dt>
              <dd>{[p.address, p.city, p.state].filter(Boolean).join(", ")}</dd>
              <dt className="text-muted">Check in / out</dt>
              <dd>
                {timeInput(p.check_in_time)} / {timeInput(p.check_out_time)}
              </dd>
              <dt className="text-muted">Phone</dt>
              <dd>{p.phone ?? "Not set"}</dd>
              <dt className="text-muted">Email</dt>
              <dd>{p.contact_email ?? "Not set"}</dd>
              <dt className="text-muted">Introduction</dt>
              <dd>{p.intro ?? "Not set"}</dd>
              <dt className="text-muted">Facilities</dt>
              <dd>{p.facilities.length > 0 ? p.facilities.join(", ") : "Not set"}</dd>
              <dt className="text-muted">Instagram</dt>
              <dd>{p.social_instagram ?? "Not set"}</dd>
              <dt className="text-muted">Facebook</dt>
              <dd>{p.social_facebook ?? "Not set"}</dd>
            </dl>
          )}
        </section>
      ))}
    </main>
  );
}
