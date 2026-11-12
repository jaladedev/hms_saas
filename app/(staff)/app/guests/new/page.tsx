import Link from "next/link";
import { buttonPrimary, EmptyState, inputClass, linkClass, Notice, PageIntro, PageTitle } from "@/components/staff/ui";
import { rememberedProperty } from "@/lib/staff/active-property";
import { createGuest } from "@/lib/staff/guest-actions";
import { pickProperty } from "@/lib/staff/property-choice";
import { createClient } from "@/lib/supabase/server";
import { PendingButton } from "@/components/ui/pending-button";

export const dynamic = "force-dynamic";

export default async function NewGuestPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();

  // A guest belongs to the hotel group, not to one hotel. The hotel picked in the header only says which group.
  const propQ = await supabase.from("properties").select("id, tenant_id").eq("status", "active").order("name");
  const props = (propQ.data ?? []) as { id: string; tenant_id: string }[];
  const property = pickProperty(props, undefined, await rememberedProperty());
  const canAdd = property
    ? (await supabase.rpc("has_tenant_permission", { p_tenant: property.tenant_id, p_permission: "guest.manage" })).data === true
    : false;

  return (
    <main className="max-w-4xl">
      <p className="text-sm">
        <Link href="/app/guests" className={linkClass}>
          Guests
        </Link>
      </p>
      <PageTitle className="mt-2">Add a guest</PageTitle>
      <PageIntro>
        Add someone before they book, for example a regular or a company contact. Guests are also added automatically whenever a booking is
        made, so you rarely need this.
      </PageIntro>

      <div className="mt-6">
        <Notice search={search} currency="NGN" />
      </div>

      {!property || !canAdd ? (
        <EmptyState className="mt-6">Your role cannot add guests. Ask the owner if you need to.</EmptyState>
      ) : (
        <form action={createGuest} className="mt-3 grid max-w-xl gap-4 md:grid-cols-2">
          <input type="hidden" name="propertyId" value={property.id} />
          <div className="md:col-span-2">
            <label htmlFor="full_name" className="block text-sm font-medium">
              Full name
            </label>
            <input id="full_name" name="full_name" required maxLength={200} autoComplete="off" className={inputClass} />
          </div>
          <div>
            <label htmlFor="email" className="block text-sm font-medium">
              Email
            </label>
            <input id="email" name="email" type="email" maxLength={254} autoCapitalize="none" spellCheck={false} className={inputClass} />
          </div>
          <div>
            <label htmlFor="phone" className="block text-sm font-medium">
              Phone
            </label>
            <input id="phone" name="phone" type="tel" maxLength={40} className={inputClass} />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="address" className="block text-sm font-medium">
              Address
            </label>
            <textarea id="address" name="address" rows={2} maxLength={500} className={inputClass} />
          </div>
          <div>
            <label htmlFor="country_code" className="block text-sm font-medium">
              Country code
            </label>
            <input
              id="country_code"
              name="country_code"
              maxLength={2}
              placeholder="NG"
              autoCapitalize="characters"
              className={`${inputClass} uppercase`}
            />
          </div>
          <div className="md:col-span-2">
            <PendingButton className={buttonPrimary} pendingLabel="Adding…">
              Add guest
            </PendingButton>
            <p className="mt-2 max-w-prose text-xs text-muted">
              Only the name is required. If a guest with the same email already exists, you are taken to that guest instead of making a
              second record.
            </p>
          </div>
        </form>
      )}
    </main>
  );
}
