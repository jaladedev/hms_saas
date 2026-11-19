import Link from "next/link";
import { GroupNotice } from "@/components/staff/group-notice";
import {
  buttonPrimary,
  EmptyState,
  ErrorBanner,
  headRow,
  inputClass,
  linkClass,
  PageIntro,
  PageTitle,
  SectionTitle,
  thRowHead,
} from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { formatDate } from "@/lib/guest-site/format";
import { createGroup } from "@/lib/staff/group-actions";
import { GROUP_STATUS_LABEL, parseGroupList } from "@/lib/staff/groups";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Group bookings, step one (migration 149): a group with a contact, rooms held by room type until a release date, and a rooming list.
 * No money here yet. People with group.manage see it; a hotel the person may not manage answers NOT_FOUND and is left out.
 */
export default async function GroupsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const { data: props, error: propError } = await supabase.from("properties").select("id, name").order("name");
  const properties = (props ?? []) as { id: string; name: string }[];
  const { data: types } = await supabase.from("room_types").select("id, name, property_id").eq("status", "active").order("name");
  const roomTypes = (types ?? []) as { id: string; name: string; property_id: string }[];
  const lists = await Promise.all(properties.map((p) => supabase.rpc("group_list", { p_property: p.id })));
  const failed = Boolean(propError) || lists.some((l) => l.error && !/NOT_FOUND|group bookings off/.test(l.error.message));
  const many = properties.length > 1;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <main className="max-w-5xl">
      <PageTitle>Groups</PageTitle>
      <PageIntro>
        A group is one party with a contact: a wedding, a company, a team. Creating it holds rooms by room type for the group&rsquo;s dates
        so they cannot be sold. If the hotel has too few free rooms of a type, nothing is held. On the release date the rooms nobody has
        claimed are freed automatically. Names for the rooming list can be added any time. Prices, a shared bill and company invoices are
        not part of this step.
      </PageIntro>
      <div className="mt-6">
        <GroupNotice search={search} />
      </div>
      {failed && <ErrorBanner className="mb-6">Groups could not be loaded. Reload the page.</ErrorBanner>}

      {properties.map((p, i) => {
        const l = lists[i];
        if (!l || (l.error && /NOT_FOUND/.test(l.error.message))) return null;
        const flagOff = Boolean(l.error && /group bookings off/.test(l.error.message));
        const groups = parseGroupList(l.data);
        const types = roomTypes.filter((t) => t.property_id === p.id);
        return (
          <section key={p.id} className="mt-10 first:mt-0" aria-label={p.name}>
            {many && <h2 className="font-display text-2xl">{p.name}</h2>}
            {groups.length === 0 ? (
              <EmptyState className="mt-4">No groups yet.</EmptyState>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className={headRow}>
                      <th className={thRowHead}>Group</th>
                      <th className={thRowHead}>Stay</th>
                      <th className={thRowHead}>Rooms held</th>
                      <th className={thRowHead}>Release</th>
                      <th className={thRowHead}>Names</th>
                      <th className={thRowHead}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => (
                      <tr key={g.id} className="border-b border-line">
                        <td className="py-2 pr-3">
                          <Link href={`/app/groups/${g.id}`} className={linkClass}>
                            {g.name}
                          </Link>
                          <div className="text-xs text-muted">
                            {g.company ? `${g.company} · ` : ""}
                            {g.contactName}
                          </div>
                        </td>
                        <td className="py-2 pr-3">
                          {formatDate(g.arrival)} to {formatDate(g.departure)}
                        </td>
                        <td className="py-2 pr-3">
                          {g.roomsHeld} of {g.roomsTotal}
                        </td>
                        <td className="py-2 pr-3">{formatDate(g.release)}</td>
                        <td className="py-2 pr-3">{g.rooming}</td>
                        <td className="py-2 pr-3">{GROUP_STATUS_LABEL[g.status]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <SectionTitle>New group</SectionTitle>
            {flagOff ? (
              <ErrorBanner className="mt-3">Group bookings are switched off for your hotel group. Contact the platform.</ErrorBanner>
            ) : (
              <form action={createGroup} className="mt-3 grid gap-3 md:grid-cols-2">
                <input type="hidden" name="propertyId" value={p.id} />
                <input type="hidden" name="key" value={crypto.randomUUID()} />
                <label className="block text-sm">
                  Group name
                  <input name="name" required maxLength={80} className={`${inputClass} mt-1`} />
                </label>
                <label className="block text-sm">
                  Company (optional)
                  <input name="company" maxLength={80} className={`${inputClass} mt-1`} />
                </label>
                <label className="block text-sm">
                  Contact person
                  <input name="contactName" required maxLength={80} className={`${inputClass} mt-1`} />
                </label>
                <label className="block text-sm">
                  Contact phone (optional)
                  <input name="contactPhone" type="tel" maxLength={30} className={`${inputClass} mt-1`} />
                </label>
                <label className="block text-sm md:col-span-2">
                  Contact email (optional)
                  <input name="contactEmail" type="email" maxLength={120} className={`${inputClass} mt-1`} />
                </label>
                <label className="block text-sm">
                  Arrival
                  <input name="arrival" type="date" required min={today} className={`${inputClass} mt-1`} />
                </label>
                <label className="block text-sm">
                  Departure
                  <input name="departure" type="date" required min={today} className={`${inputClass} mt-1`} />
                </label>
                <label className="block text-sm md:col-span-2">
                  Release date (last day the hotel keeps the rooms; on or before arrival)
                  <input name="release" type="date" required min={today} className={`${inputClass} mt-1`} />
                </label>
                <fieldset className="md:col-span-2">
                  <legend className="text-sm">Rooms to hold (leave empty for none)</legend>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {types.map((t) => (
                      <label key={t.id} className="flex items-center justify-between gap-3 text-sm">
                        {t.name}
                        <input name={`qty_${t.id}`} type="number" min={0} max={50} inputMode="numeric" className={`${inputClass} w-20`} />
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label className="block text-sm md:col-span-2">
                  Notes (optional)
                  <textarea name="notes" maxLength={1000} rows={2} className={`${inputClass} mt-1`} />
                </label>
                <div className="md:col-span-2">
                  <PendingButton className={buttonPrimary} pendingLabel="Holding rooms...">
                    Create group and hold rooms
                  </PendingButton>
                </div>
              </form>
            )}
          </section>
        );
      })}
    </main>
  );
}
