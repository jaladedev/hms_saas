import Link from "next/link";
import { notFound } from "next/navigation";
import { GroupNotice } from "@/components/staff/group-notice";
import {
  buttonDanger,
  buttonPrimary,
  buttonQuiet,
  ErrorBanner,
  headRow,
  inputClass,
  linkClass,
  PageTitle,
  SectionTitle,
  thRowHead,
} from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { formatDate } from "@/lib/guest-site/format";
import { addRoomingEntry, cancelGroup, removeRoomingEntry, updateGroup, useGroupRoom } from "@/lib/staff/group-actions";
import { GROUP_STATUS_LABEL, heldSummary, parseGroupDetail } from "@/lib/staff/groups";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function GroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const search = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const q = await supabase.rpc("group_detail", { p_group: id });
  if (q.error && /NOT_FOUND/.test(q.error.message)) notFound();
  const g = parseGroupDetail(q.data);
  if (!g) {
    return (
      <main className="max-w-4xl">
        <ErrorBanner>This group could not be loaded. Reload the page.</ErrorBanner>
      </main>
    );
  }
  const open = g.status === "open";
  const held = heldSummary(g.rooms);
  const { data: types } = await supabase
    .from("room_types")
    .select("id, name")
    .eq("property_id", g.propertyId)
    .eq("status", "active")
    .order("name");
  const roomTypes = (types ?? []) as { id: string; name: string }[];

  return (
    <main className="max-w-4xl">
      <p className="text-sm">
        <Link href="/app/groups" className={linkClass}>
          All groups
        </Link>
      </p>
      <PageTitle>{g.name}</PageTitle>
      <p className="mt-1 text-sm text-muted">
        {GROUP_STATUS_LABEL[g.status]} · {formatDate(g.arrival)} to {formatDate(g.departure)} · rooms kept until {formatDate(g.release)}
      </p>
      <div className="mt-5">
        <GroupNotice search={search} />
      </div>

      <SectionTitle>Rooms</SectionTitle>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className={headRow}>
              <th className={thRowHead}>Room type</th>
              <th className={thRowHead}>Held</th>
              <th className={thRowHead}>Given to a guest</th>
              <th className={thRowHead}>Freed</th>
              <th className={thRowHead} />
            </tr>
          </thead>
          <tbody>
            {g.rooms.map((r) => (
              <tr key={r.roomTypeId} className="border-b border-line">
                <td className="py-2 pr-3">{r.name}</td>
                <td className="py-2 pr-3">{r.held}</td>
                <td className="py-2 pr-3">{r.used}</td>
                <td className="py-2 pr-3">{r.released}</td>
                <td className="py-2 pr-3">
                  {open && r.held > 0 && (
                    <form action={useGroupRoom}>
                      <input type="hidden" name="groupId" value={g.id} />
                      <input type="hidden" name="roomTypeId" value={r.roomTypeId} />
                      <PendingButton className={buttonQuiet} pendingLabel="Freeing...">
                        Free one to book
                      </PendingButton>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && (
        <p className="mt-2 text-xs text-muted">
          &ldquo;Free one to book&rdquo; releases one held room so you can book it for a named guest from{" "}
          <Link href="/app/reservations/new" className={linkClass}>
            Reservations
          </Link>
          . Still held: {held || "nothing"}.
        </p>
      )}

      <SectionTitle>Rooming list</SectionTitle>
      {g.rooming.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No names yet. Add them as the group sends them.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line border-y border-line text-sm">
          {g.rooming.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                {r.guest}
                {r.roomTypeName ? ` · ${r.roomTypeName}` : ""}
                {r.notes ? <span className="text-muted"> · {r.notes}</span> : null}
              </span>
              <form action={removeRoomingEntry}>
                <input type="hidden" name="groupId" value={g.id} />
                <input type="hidden" name="entryId" value={r.id} />
                <PendingButton className={buttonQuiet} pendingLabel="Removing...">
                  Remove
                </PendingButton>
              </form>
            </li>
          ))}
        </ul>
      )}
      {g.status !== "cancelled" && (
        <form action={addRoomingEntry} className="mt-4 grid gap-3 sm:grid-cols-3">
          <input type="hidden" name="groupId" value={g.id} />
          <label className="block text-sm">
            Guest name
            <input name="guest" required maxLength={80} className={`${inputClass} mt-1`} />
          </label>
          <label className="block text-sm">
            Room type (optional)
            <select name="roomTypeId" defaultValue="" className={`${inputClass} mt-1`}>
              <option value="">Not decided</option>
              {roomTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            Note (optional)
            <input name="notes" maxLength={200} className={`${inputClass} mt-1`} />
          </label>
          <div className="sm:col-span-3">
            <PendingButton className={buttonPrimary} pendingLabel="Adding...">
              Add to rooming list
            </PendingButton>
          </div>
        </form>
      )}

      <SectionTitle>Contact and release date</SectionTitle>
      {open ? (
        <form action={updateGroup} className="mt-3 grid gap-3 md:grid-cols-2">
          <input type="hidden" name="groupId" value={g.id} />
          <label className="block text-sm">
            Contact person
            <input name="contactName" required maxLength={80} defaultValue={g.contactName} className={`${inputClass} mt-1`} />
          </label>
          <label className="block text-sm">
            Company
            <input name="company" maxLength={80} defaultValue={g.company ?? ""} className={`${inputClass} mt-1`} />
          </label>
          <label className="block text-sm">
            Phone
            <input name="contactPhone" type="tel" maxLength={30} defaultValue={g.contactPhone ?? ""} className={`${inputClass} mt-1`} />
          </label>
          <label className="block text-sm">
            Email
            <input name="contactEmail" type="email" maxLength={120} defaultValue={g.contactEmail ?? ""} className={`${inputClass} mt-1`} />
          </label>
          <label className="block text-sm">
            Release date
            <input name="release" type="date" required max={g.arrival} defaultValue={g.release} className={`${inputClass} mt-1`} />
          </label>
          <label className="block text-sm md:col-span-2">
            Notes
            <textarea name="notes" maxLength={1000} rows={2} defaultValue={g.notes ?? ""} className={`${inputClass} mt-1`} />
          </label>
          <div className="md:col-span-2">
            <PendingButton className={buttonPrimary} pendingLabel="Saving...">
              Save
            </PendingButton>
          </div>
        </form>
      ) : (
        <p className="mt-3 text-sm text-muted">
          {g.contactName}
          {g.company ? ` · ${g.company}` : ""}
          {g.contactPhone ? ` · ${g.contactPhone}` : ""}
          {g.contactEmail ? ` · ${g.contactEmail}` : ""}
        </p>
      )}

      {open && (
        <form action={cancelGroup} className="mt-8">
          <input type="hidden" name="groupId" value={g.id} />
          <PendingButton className={buttonDanger} pendingLabel="Cancelling...">
            Cancel group and free the rooms
          </PendingButton>
        </form>
      )}
    </main>
  );
}
