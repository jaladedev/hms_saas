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
  applyCompanyRate,
  cancelGroup,
  setGroupCompany,
  issueGroupInvoice,
  markGroupInvoicePaid,
  voidGroupInvoice,
  linkRoomingBooking,
  removeRoomingEntry,
  unlinkRoomingBooking,
  updateGroup,
  useGroupRoom,
} from "@/lib/staff/group-actions";
import {
  GROUP_STATUS_LABEL,
  heldSummary,
  PAY_METHODS,
  PAY_METHOD_LABEL,
  suggestedDueDate,
  parseCompanies,
  parseGroupDetail,
  parseGroupInvoices,
  parseGroupStatement,
} from "@/lib/staff/groups";
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
  const invQ = await supabase.rpc("group_invoice_list", { p_group: id });
  const seeInvoices = !invQ.error;
  const invoices = parseGroupInvoices(invQ.data);
  const coQ = await supabase.rpc("company_list", { p_property: g.propertyId });
  const companies = parseCompanies(coQ.data).filter((c) => c.status === "active" || c.id === g.companyId);
  const company = companies.find((c) => c.id === g.companyId) ?? null;
  const today = new Date().toISOString().slice(0, 10);
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

      <SectionTitle>Company account</SectionTitle>
      <form action={setGroupCompany} className="mt-3 flex flex-wrap items-end gap-3">
        <input type="hidden" name="groupId" value={g.id} />
        <label className="block text-sm">
          Company
          <select name="companyId" defaultValue={g.companyId ?? ""} className={`${inputClass} mt-1 w-64`}>
            <option value="">None</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.percent > 0 ? ` (${c.percent}% off)` : ""}
              </option>
            ))}
          </select>
        </label>
        <PendingButton className={buttonQuiet} pendingLabel="Saving...">
          Save company
        </PendingButton>
        <Link href="/app/groups/companies" className={linkClass}>
          Company accounts
        </Link>
      </form>
      {company && company.percent > 0 && g.status !== "cancelled" && (
        <form action={applyCompanyRate} className="mt-3">
          <input type="hidden" name="groupId" value={g.id} />
          <input type="hidden" name="key" value={crypto.randomUUID()} />
          <PendingButton className={buttonQuiet} pendingLabel="Applying...">
            Apply the {company.percent}% company rate to linked bookings
          </PendingButton>
          <p className="mt-1 text-xs text-muted">
            Only confirmed bookings with no discount, payment or invoice yet. Others are skipped, never changed.
          </p>
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

      {seeInvoices && (
        <>
          <SectionTitle>Company invoice</SectionTitle>
          <p className="mt-2 text-xs text-muted">
            A numbered invoice to {g.companyAccount ?? g.company ?? g.contactName} for the linked bookings that are confirmed, checked in or
            checked out, one line per booking at its total. Extras keep their own invoices. &ldquo;Mark paid&rdquo; only records that the
            company paid this invoice; it does not post a payment to the bookings.
          </p>
          {invoices.map((i) => (
            <div key={i.id} className="mt-4 border border-line p-4 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="flex flex-wrap items-baseline gap-3">
                  <strong>{i.number}</strong>
                  <Link href={`/app/groups/${g.id}/invoice/${i.id}`} className={linkClass}>
                    Open to print
                  </Link>
                </span>
                <span className="text-muted">
                  {i.status === "paid"
                    ? `Paid ${i.paidAt ? formatDate(i.paidAt.slice(0, 10)) : ""} · ${PAY_METHOD_LABEL[i.paidMethod ?? ""] ?? ""}${i.paidReference ? ` · ${i.paidReference}` : ""}`
                    : i.status === "void"
                      ? `Void · ${i.voidReason ?? ""}`
                      : `Due ${formatDate(i.dueDate)}`}
                </span>
              </div>
              <p className="mt-1 text-muted">
                To {i.billTo} · {formatMoney(i.totalMinor, i.currency)} ({formatMoney(i.subtotalMinor, i.currency)} +{" "}
                {formatMoney(i.taxMinor, i.currency)} tax)
              </p>
              <ul className="mt-2 divide-y divide-line border-y border-line">
                {i.lines.map((l) => (
                  <li key={l.reference} className="flex flex-wrap justify-between gap-2 py-1.5">
                    <span>
                      {l.guest} · {l.reference} · {formatDate(l.arrival)} to {formatDate(l.departure)}
                    </span>
                    <span>{formatMoney(l.totalMinor, i.currency)}</span>
                  </li>
                ))}
              </ul>
              {i.status === "issued" && (
                <div className="mt-3 flex flex-wrap gap-4">
                  <form action={markGroupInvoicePaid} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="groupId" value={g.id} />
                    <input type="hidden" name="invoiceId" value={i.id} />
                    <select name="method" aria-label="How it was paid" className={`${inputClass} w-40`} defaultValue="bank_transfer">
                      {PAY_METHODS.map((m) => (
                        <option key={m} value={m}>
                          {PAY_METHOD_LABEL[m]}
                        </option>
                      ))}
                    </select>
                    <input
                      name="reference"
                      maxLength={60}
                      placeholder="Reference (optional)"
                      aria-label="Payment reference"
                      className={`${inputClass} w-44`}
                    />
                    <PendingButton className={buttonQuiet} pendingLabel="Saving...">
                      Mark paid
                    </PendingButton>
                  </form>
                  <form action={voidGroupInvoice} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="groupId" value={g.id} />
                    <input type="hidden" name="invoiceId" value={i.id} />
                    <input
                      name="reason"
                      required
                      maxLength={200}
                      placeholder="Reason to void"
                      aria-label="Reason to void"
                      className={`${inputClass} w-52`}
                    />
                    <PendingButton className={buttonDanger} pendingLabel="Voiding...">
                      Void
                    </PendingButton>
                  </form>
                </div>
              )}
            </div>
          ))}
          {g.status !== "cancelled" && (
            <form action={issueGroupInvoice} className="mt-4 flex flex-wrap items-end gap-3">
              <input type="hidden" name="groupId" value={g.id} />
              <input type="hidden" name="key" value={crypto.randomUUID()} />
              <label className="block text-sm">
                Due date
                <input
                  name="due"
                  type="date"
                  required
                  min={today}
                  defaultValue={suggestedDueDate(today, company?.creditDays ?? 0)}
                  className={`${inputClass} mt-1`}
                />
              </label>
              <PendingButton className={buttonPrimary} pendingLabel="Issuing...">
                Issue invoice for linked bookings
              </PendingButton>
            </form>
          )}
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
