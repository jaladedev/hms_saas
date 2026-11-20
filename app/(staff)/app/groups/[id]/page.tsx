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
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import {
  addRoomingEntry,
  cancelGroup,
  linkRoomingBooking,
  removeRoomingEntry,
  unlinkRoomingBooking,
  updateGroup,
  useGroupRoom,
} from "@/lib/staff/group-actions";
import { GROUP_STATUS_LABEL, heldSummary, parseGroupDetail, parseGroupStatement } from "@/lib/staff/groups";
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
  const st = parseGroupStatement((await supabase.rpc("group_statement", { p_group: id })).data);
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
                {r.bookingId ? (
                  <>
                    {" · "}
                    <Link href={`/app/reservations/${r.bookingId}`} className={linkClass}>
                      {r.bookingReference}
                    </Link>
                  </>
                ) : null}
              </span>
              <span className="flex flex-wrap items-center gap-2">
                {g.status !== "cancelled" && !r.bookingId && (
                  <form action={linkRoomingBooking} className="flex items-center gap-2">
                    <input type="hidden" name="groupId" value={g.id} />
                    <input type="hidden" name="entryId" value={r.id} />
                    <input
                      name="reference"
                      required
                      minLength={3}
                      maxLength={40}
                      placeholder="Booking reference"
                      aria-label={`Booking reference for ${r.guest}`}
                      className={`${inputClass} w-44`}
                    />
                    <PendingButton className={buttonQuiet} pendingLabel="Linking...">
                      Link booking
                    </PendingButton>
                  </form>
                )}
                {r.bookingId && (
                  <form action={unlinkRoomingBooking}>
                    <input type="hidden" name="groupId" value={g.id} />
                    <input type="hidden" name="entryId" value={r.id} />
                    <PendingButton className={buttonQuiet} pendingLabel="Unlinking...">
                      Unlink
                    </PendingButton>
                  </form>
                )}
                <form action={removeRoomingEntry}>
                  <input type="hidden" name="groupId" value={g.id} />
                  <input type="hidden" name="entryId" value={r.id} />
                  <PendingButton className={buttonQuiet} pendingLabel="Removing...">
                    Remove
                  </PendingButton>
                </form>
              </span>
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

      <SectionTitle>Statement</SectionTitle>
      {!st || st.bookings.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          No bookings linked yet. Book a freed room from Reservations, then link its reference to the guest&rsquo;s name above.
        </p>
      ) : (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={headRow}>
                  <th className={thRowHead}>Guest</th>
                  <th className={thRowHead}>Booking</th>
                  <th className={thRowHead}>Status</th>
                  <th className={thRowHead}>Payment</th>
                  {st.moneyVisible && <th className={thRowHead}>Booking total</th>}
                  {st.moneyVisible && <th className={thRowHead}>Extras</th>}
                </tr>
              </thead>
              <tbody>
                {st.bookings.map((b) => (
                  <tr key={b.entryId} className="border-b border-line">
                    <td className="py-2 pr-3">{b.guest}</td>
                    <td className="py-2 pr-3">
                      <Link href={`/app/reservations/${b.bookingId}`} className={linkClass}>
                        {b.reference}
                      </Link>
                    </td>
                    <td className="py-2 pr-3">{b.status.replace("_", " ")}</td>
                    <td className="py-2 pr-3">{b.paymentStatus.replace("_", " ")}</td>
                    {st.moneyVisible && <td className="py-2 pr-3">{formatMoney(b.totalMinor ?? 0, st.currency)}</td>}
                    {st.moneyVisible && <td className="py-2 pr-3">{formatMoney(b.extrasMinor ?? 0, st.currency)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {st.moneyVisible && (
            <p className="mt-3 text-sm">
              Bookings that are not cancelled: <strong>{formatMoney(st.totalMinor ?? 0, st.currency)}</strong> in booking totals and{" "}
              <strong>{formatMoney(st.extrasMinor ?? 0, st.currency)}</strong> in extras.
            </p>
          )}
          <p className="mt-2 text-xs text-muted">
            Each booking keeps its own bill and payments; this page only adds them up.{" "}
            {st.namesWithoutBooking > 0 ? `${st.namesWithoutBooking} name(s) have no booking yet. ` : ""}A shared company bill is not part
            of this step.
          </p>
        </>
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
