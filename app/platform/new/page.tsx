import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonPrimary, inputClass, linkClass, PageIntro, PageTitle, SectionTitle } from "@/components/staff/ui";
import { PlatformNotice } from "@/components/platform-notice";
import { createHotel } from "@/lib/platform/actions";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export default async function NewHotel({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const level = await supabase.rpc("platform_level");
  if (level.data !== "admin") notFound();

  return (
    <main className="max-w-2xl">
      <p className="text-sm">
        <Link href="/platform" className={linkClass}>
          All hotels
        </Link>
      </p>
      <PageTitle className="mt-2">Add a hotel</PageTitle>
      <PageIntro>
        Creates the hotel group, its first property, its booking address and its owner. The owner is invited by email if they have no login
        yet.
      </PageIntro>
      <div className="mt-6">
        <PlatformNotice search={search} />
      </div>
      <form action={createHotel} className="space-y-8">
        <section className="space-y-4" aria-labelledby="g">
          <SectionTitle id="g">Hotel group</SectionTitle>
          <Field id="name" label="Name">
            <input id="name" name="name" required maxLength={120} className={inputClass} />
          </Field>
          <Field id="slug" label="Short name" hint="Lowercase letters, digits and hyphens. Leave empty to build it from the name.">
            <input id="slug" name="slug" maxLength={63} className={inputClass} />
          </Field>
          <Field id="ownerEmail" label="Owner's email">
            <input id="ownerEmail" name="ownerEmail" type="email" required className={inputClass} />
          </Field>
        </section>
        <section className="space-y-4" aria-labelledby="p">
          <SectionTitle id="p">First property</SectionTitle>
          <Field id="propertyName" label="Property name" hint="Leave empty to use the group's name.">
            <input id="propertyName" name="propertyName" maxLength={120} className={inputClass} />
          </Field>
          <Field id="propertyCode" label="Property code" hint="2 to 12 capital letters, digits or hyphens. Cannot be changed later.">
            <input id="propertyCode" name="propertyCode" required maxLength={12} className={inputClass} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field id="city" label="City">
              <input id="city" name="city" className={inputClass} />
            </Field>
            <Field id="state" label="State">
              <input id="state" name="state" className={inputClass} />
            </Field>
            <Field id="timezone" label="Time zone">
              <input id="timezone" name="timezone" defaultValue="Africa/Lagos" required className={inputClass} />
            </Field>
            <Field id="currency" label="Currency">
              <input id="currency" name="currency" defaultValue="NGN" required maxLength={3} className={inputClass} />
            </Field>
          </div>
        </section>
        <section className="space-y-4" aria-labelledby="d">
          <SectionTitle id="d">Booking address</SectionTitle>
          <Field
            id="host"
            label="Web address"
            hint="For example book.example.com. It starts unverified; guests cannot book there until you verify it."
          >
            <input id="host" name="host" required className={inputClass} />
          </Field>
        </section>
        <section className="space-y-4" aria-labelledby="pay">
          <SectionTitle id="pay">Paystack (optional)</SectionTitle>
          <Field
            id="secretReference"
            label="Secret name"
            hint="The name of the server setting that holds the key, such as env:PAYSTACK_SECRET_HOTEL. Never the key itself. The account starts inactive."
          >
            <input id="secretReference" name="secretReference" className={inputClass} />
          </Field>
          <Field id="paymentMode" label="Mode">
            <select id="paymentMode" name="paymentMode" defaultValue="test" className={inputClass}>
              <option value="test">Test</option>
              <option value="live">Live</option>
            </select>
          </Field>
        </section>
        <button type="submit" className={buttonPrimary}>
          Create hotel
        </button>
      </form>
    </main>
  );
}
