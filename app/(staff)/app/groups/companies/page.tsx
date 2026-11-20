import Link from "next/link";
import { GroupNotice } from "@/components/staff/group-notice";
import {
  buttonPrimary,
  buttonQuiet,
  EmptyState,
  ErrorBanner,
  inputClass,
  linkClass,
  PageIntro,
  PageTitle,
  SectionTitle,
} from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { createCompany, updateCompany } from "@/lib/staff/group-actions";
import { parseCompanies } from "@/lib/staff/groups";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Company accounts (migration 155): who to bill, credit days and an agreed discount. Owner and general manager change them. */
export default async function CompaniesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const { data: props, error: propError } = await supabase.from("properties").select("id, name").order("name");
  const properties = (props ?? []) as { id: string; name: string }[];
  const lists = await Promise.all(properties.map((p) => supabase.rpc("company_list", { p_property: p.id })));
  const many = properties.length > 1;

  return (
    <main className="max-w-4xl">
      <p className="text-sm">
        <Link href="/app/groups" className={linkClass}>
          All groups
        </Link>
      </p>
      <PageTitle>Company accounts</PageTitle>
      <PageIntro>
        A company account holds who to bill, the days the company has to pay (credit days) and an agreed discount. Attach one to a group:
        the group invoice is made out to the company and suggests a due date from the credit days, and the agreed discount can be applied to
        the group&rsquo;s linked bookings. Credit days only suggest a due date; nothing is blocked when a company is late. Changing a
        discount later does not change bookings that already have it.
      </PageIntro>
      <div className="mt-6">
        <GroupNotice search={search} />
      </div>
      {propError && <ErrorBanner className="mb-6">Companies could not be loaded. Reload the page.</ErrorBanner>}

      {properties.map((p, i) => {
        const l = lists[i];
        if (!l || l.error) return null;
        const companies = parseCompanies(l.data);
        return (
          <section key={p.id} className="mt-10 first:mt-0" aria-label={p.name}>
            {many && <h2 className="font-display text-2xl">{p.name}</h2>}
            {companies.length === 0 ? (
              <EmptyState className="mt-4">No company accounts yet.</EmptyState>
            ) : (
              companies.map((c) => (
                <form key={c.id} action={updateCompany} className="mt-4 grid gap-3 border border-line p-4 md:grid-cols-3">
                  <input type="hidden" name="companyId" value={c.id} />
                  <p className="text-sm md:col-span-3">
                    <strong>{c.name}</strong> · {c.groups} group(s){c.status === "archived" ? " · archived" : ""}
                  </p>
                  <label className="block text-sm">
                    Billing contact
                    <input name="contact" required maxLength={80} defaultValue={c.contact} className={`${inputClass} mt-1`} />
                  </label>
                  <label className="block text-sm">
                    Email
                    <input name="email" type="email" maxLength={120} defaultValue={c.email ?? ""} className={`${inputClass} mt-1`} />
                  </label>
                  <label className="block text-sm">
                    Phone
                    <input name="phone" type="tel" maxLength={30} defaultValue={c.phone ?? ""} className={`${inputClass} mt-1`} />
                  </label>
                  <label className="block text-sm">
                    Credit days (0 to 90)
                    <input name="creditDays" type="number" min={0} max={90} defaultValue={c.creditDays} className={`${inputClass} mt-1`} />
                  </label>
                  <label className="block text-sm">
                    Agreed discount % (0 to 50)
                    <input
                      name="percent"
                      type="number"
                      min={0}
                      max={50}
                      step="0.01"
                      defaultValue={c.percent}
                      className={`${inputClass} mt-1`}
                    />
                  </label>
                  <label className="block text-sm">
                    Status
                    <select name="status" defaultValue={c.status} className={`${inputClass} mt-1`}>
                      <option value="active">Active</option>
                      <option value="archived">Archived</option>
                    </select>
                  </label>
                  <label className="block text-sm md:col-span-3">
                    Notes
                    <input name="notes" maxLength={500} defaultValue={c.notes ?? ""} className={`${inputClass} mt-1`} />
                  </label>
                  <div className="md:col-span-3">
                    <PendingButton className={buttonQuiet} pendingLabel="Saving...">
                      Save
                    </PendingButton>
                  </div>
                </form>
              ))
            )}

            <SectionTitle>New company</SectionTitle>
            <form action={createCompany} className="mt-3 grid gap-3 md:grid-cols-3">
              <input type="hidden" name="propertyId" value={p.id} />
              <label className="block text-sm md:col-span-3">
                Company name
                <input name="name" required maxLength={80} className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-sm">
                Billing contact
                <input name="contact" required maxLength={80} className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-sm">
                Email (optional)
                <input name="email" type="email" maxLength={120} className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-sm">
                Phone (optional)
                <input name="phone" type="tel" maxLength={30} className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-sm">
                Credit days (0 to 90)
                <input name="creditDays" type="number" min={0} max={90} defaultValue={0} className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-sm">
                Agreed discount % (0 to 50)
                <input name="percent" type="number" min={0} max={50} step="0.01" defaultValue={0} className={`${inputClass} mt-1`} />
              </label>
              <label className="block text-sm md:col-span-3">
                Notes (optional)
                <input name="notes" maxLength={500} className={`${inputClass} mt-1`} />
              </label>
              <div className="md:col-span-3">
                <PendingButton className={buttonPrimary} pendingLabel="Creating...">
                  Create company
                </PendingButton>
              </div>
            </form>
          </section>
        );
      })}
    </main>
  );
}
