import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonDanger, buttonPrimary, buttonQuiet, cardClass, ErrorBanner, inputClass, linkClass, Notice, PageTitle, SectionTitle } from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { formatMoney } from "@/lib/guest-site/format";
import {
  cancelBooking,
  completeBooking,
  confirmBooking,
  createRoomBlock,
  holdBooking,
  recordEventPayment,
  recordEventRefund,
  releaseRoomBlock,
  saveQuote,
  setStayLink,
} from "@/lib/staff/event-actions";
import { netPaid } from "@/lib/staff/event-page-helpers";
import {
  ATTENTION_LABEL,
  BOOKING_STATUS_LABEL,
  bookingNeed,
  EVENT_TYPE_LABEL,
  formatLocal,
  isUuid,
  LINE_KIND_LABEL,
  LINE_KINDS,
  MAX_QUOTE_LINES,
  PAYMENT_METHODS,
  type BookingRow,
} from "@/lib/staff/events";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
type Search = Record<string, string | string[] | undefined>;
type Line = { id: string; kind: string; description: string; quantity: number; unit_amount_minor: number; line_total_minor: number | null; sort_order: number };
type Pay = { id: string; payment_kind: string; payment_method: string; amount_minor: number; internal_reference: string; provider_reference: string | null; note: string | null; received_at: string };
type Block = { id: string; room_type_id: string; rooms: number; start_date: string; end_date: string; status: string };

export default async function BookingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const { id } = await params;
  const search = await searchParams;
  if (!isUuid(id)) notFound();
  const supabase = await createClient();
  const { data: b } = await supabase.from("venue_bookings").select("*").eq("id", id).maybeSingle();
  if (!b) notFound();
  const booking = b as BookingRow;
  const [venueQ, linesQ, payQ, blockQ, linkQ, typeQ, manageQ, moneyQ, payPermQ, refundPermQ, blockPermQ] = await Promise.all([
    supabase.from("hotel_venues").select("name").eq("id", booking.venue_id).maybeSingle(),
    supabase.from("venue_booking_lines").select("*").eq("booking_id", id).order("sort_order"),
    supabase.from("event_payments").select("*").eq("venue_booking_id", id).order("received_at"),
    supabase.from("event_room_blocks").select("*").eq("booking_id", id).order("created_at"),
    supabase.from("event_reservation_links").select("reservation_id").eq("booking_id", id),
    supabase.from("room_types").select("id, name").eq("property_id", booking.property_id).order("name"),
    supabase.rpc("has_permission", { p_property: booking.property_id, p_permission: "event.manage" }),
    supabase.rpc("has_permission", { p_property: booking.property_id, p_permission: "payment.record" }),
    supabase.rpc("has_permission", { p_property: booking.property_id, p_permission: "payment.record" }),
    supabase.rpc("has_permission", { p_property: booking.property_id, p_permission: "refund.approve" }),
    supabase.rpc("has_permission", { p_property: booking.property_id, p_permission: "room.block" }),
  ]);
  const mayManage = manageQ.data === true;
  const mayPay = payPermQ.data === true && mayManage;
  const mayRefund = refundPermQ.data === true;
  const mayBlock = blockPermQ.data === true && mayManage;
  void moneyQ;
  const lines = (linesQ.data ?? []) as Line[];
  const pays = (payQ.data ?? []) as Pay[];
  const blocks = (blockQ.data ?? []) as Block[];
  const roomTypes = (typeQ.data ?? []) as { id: string; name: string }[];
  const typeName = new Map(roomTypes.map((t) => [t.id, t.name]));
  const linkIds = ((linkQ.data ?? []) as { reservation_id: string }[]).map((l) => l.reservation_id);
  const resQ = linkIds.length ? await supabase.from("reservations").select("id, booking_reference").in("id", linkIds) : { data: [] };
  const stays = (resQ.data ?? []) as { id: string; booking_reference: string }[];

  const paid = netPaid(pays);
  const money = (n: number) => formatMoney(n, booking.currency);
  const need = bookingNeed(booking, paid);
  const live = booking.status === "enquiry" || booking.status === "tentative" || booking.status === "confirmed";
  const quotable = booking.status === "enquiry" || booking.status === "tentative";
  const here = `/app/events/${id}`;
  const rowsCount = Math.min(MAX_QUOTE_LINES, Math.max(lines.length + 2, 4));
  const note = booking.attention_reason ? (ATTENTION_LABEL[booking.attention_reason] ?? booking.attention_reason) : null;

  return (
    <main className="max-w-4xl">
      <p className="text-sm">
        <Link href={`/app/events?property=${booking.property_id}`} className={linkClass}>
          All bookings
        </Link>
      </p>
      <PageTitle className="mt-2">
        {booking.reference} · {booking.title || EVENT_TYPE_LABEL[booking.event_type] || booking.event_type}
      </PageTitle>
      <div className="mt-3">
        <Notice search={search} currency={booking.currency} />
      </div>
      {note && <ErrorBanner className="mb-4">{note}</ErrorBanner>}

      <section className={cardClass} aria-label="Booking">
        <p className="text-sm">
          <strong>{BOOKING_STATUS_LABEL[booking.status] ?? booking.status}</strong>
          {need ? ` · ${need}` : ""}
          {booking.status === "tentative" && booking.hold_expires_at ? ` · held until ${formatLocal(booking.hold_expires_at)}` : ""}
        </p>
        <p className="mt-1 text-sm">
          {venueQ.data ? (venueQ.data as { name: string }).name : "Venue"} · {formatLocal(booking.starts_at)} to {formatLocal(booking.ends_at)} · {booking.attendees} people
        </p>
        <p className="mt-1 text-sm">
          {booking.contact_name}
          {booking.contact_email ? ` · ${booking.contact_email}` : ""}
          {booking.contact_phone ? ` · ${booking.contact_phone}` : ""}
        </p>
        {booking.note && <p className="mt-1 text-sm text-muted">{booking.note}</p>}
        {booking.cancel_reason && <p className="mt-1 text-sm text-muted">Reason: {booking.cancel_reason}</p>}
      </section>

      <SectionTitle>Quote</SectionTitle>
      {quotable && mayManage ? (
        <form action={saveQuote} className="mt-2 space-y-2">
          <input type="hidden" name="bookingId" value={id} />
          {Array.from({ length: rowsCount }, (_, i) => {
            const l = lines[i];
            return (
              <div key={i} className="grid gap-2 sm:grid-cols-[8rem_1fr_5rem_9rem]">
                <select name={`kind_${i}`} defaultValue={l?.kind ?? "venue"} aria-label="Kind" className={inputClass}>
                  {LINE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {LINE_KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
                <input name={`desc_${i}`} defaultValue={l?.description ?? ""} maxLength={120} placeholder="Description" aria-label="Description" className={inputClass} />
                <input name={`qty_${i}`} defaultValue={l ? String(l.quantity) : "1"} inputMode="numeric" aria-label="Quantity" className={inputClass} />
                <input name={`price_${i}`} defaultValue={l ? String(l.unit_amount_minor / 100) : ""} inputMode="decimal" placeholder="Price (naira)" aria-label="Unit price in naira" className={inputClass} />
              </div>
            );
          })}
          <p className="text-xs text-muted">Leave a row empty to skip it. Saving replaces the quote and recalculates service charge, tax and deposit from the hotel&rsquo;s terms.</p>
          <PendingButton className={buttonPrimary} pendingLabel="Saving…">
            Save quote
          </PendingButton>
        </form>
      ) : lines.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No quote lines.</p>
      ) : null}
      {lines.length > 0 && (
        <table className="mt-4 w-full text-sm">
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-b border-line">
                <td className="py-1 pr-2">{LINE_KIND_LABEL[l.kind] ?? l.kind}</td>
                <td className="px-2 py-1">{l.description}</td>
                <td className="px-2 py-1 text-right">{l.quantity} × {money(l.unit_amount_minor)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{money(l.line_total_minor ?? l.quantity * l.unit_amount_minor)}</td>
              </tr>
            ))}
            <tr><td colSpan={3} className="px-2 py-1 text-right text-muted">Subtotal</td><td className="px-2 py-1 text-right tabular-nums">{money(booking.subtotal_minor)}</td></tr>
            <tr><td colSpan={3} className="px-2 py-1 text-right text-muted">Service charge ({booking.service_percent}%)</td><td className="px-2 py-1 text-right tabular-nums">{money(booking.service_minor)}</td></tr>
            <tr><td colSpan={3} className="px-2 py-1 text-right text-muted">Tax ({booking.tax_percent}%)</td><td className="px-2 py-1 text-right tabular-nums">{money(booking.tax_minor)}</td></tr>
            <tr className="font-semibold"><td colSpan={3} className="px-2 py-1 text-right">Total</td><td className="px-2 py-1 text-right tabular-nums">{money(booking.total_minor)}</td></tr>
            <tr><td colSpan={3} className="px-2 py-1 text-right text-muted">Deposit ({booking.deposit_percent}%){booking.deposit_waived ? " waived" : ""}</td><td className="px-2 py-1 text-right tabular-nums">{money(booking.deposit_minor)}</td></tr>
          </tbody>
        </table>
      )}

      {mayManage && live && (
        <div className="mt-6 flex flex-wrap items-start gap-3">
          {booking.status === "enquiry" && (
            <form action={holdBooking}>
              <input type="hidden" name="bookingId" value={id} />
              <PendingButton className={buttonQuiet} pendingLabel="Holding…">Hold the slot</PendingButton>
            </form>
          )}
          {(booking.status === "enquiry" || booking.status === "tentative") && (
            <form action={confirmBooking} className="flex items-center gap-2">
              <input type="hidden" name="bookingId" value={id} />
              <PendingButton className={buttonPrimary} pendingLabel="Confirming…">Confirm</PendingButton>
              <label className="text-sm"><input type="checkbox" name="waive" className="mr-1 accent-primary" />Waive the deposit</label>
            </form>
          )}
          {booking.status === "confirmed" && (
            <form action={completeBooking}>
              <input type="hidden" name="bookingId" value={id} />
              <PendingButton className={buttonQuiet} pendingLabel="Saving…">Mark as completed</PendingButton>
            </form>
          )}
          <form action={cancelBooking} className="flex items-center gap-2">
            <input type="hidden" name="bookingId" value={id} />
            <input name="reason" required maxLength={200} placeholder="Reason" aria-label="Reason" className={inputClass} />
            <PendingButton className={buttonDanger} pendingLabel="Saving…">{booking.status === "enquiry" ? "Decline" : "Cancel booking"}</PendingButton>
          </form>
        </div>
      )}

      <SectionTitle>Payments</SectionTitle>
      <p className="mt-2 text-sm">Received {money(paid)} of {money(booking.total_minor)}.</p>
      {pays.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm">
          {pays.map((p) => (
            <li key={p.id}>
              {formatLocal(p.received_at)} · {p.payment_kind === "refund" ? "Refund" : "Payment"} {money(p.amount_minor)} · {p.payment_method}
              {p.provider_reference ? ` · ${p.provider_reference}` : ""}{p.note ? ` · ${p.note}` : ""}
            </li>
          ))}
        </ul>
      )}
      {mayPay && live && <MoneyForm action={recordEventPayment} bookingId={id} returnTo={here} label="Record a payment" />}
      {mayRefund && pays.length > 0 && <MoneyForm action={recordEventRefund} bookingId={id} returnTo={here} label="Record a refund" refund />}

      <SectionTitle>Rooms for the event&rsquo;s guests</SectionTitle>
      {blocks.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm">
          {blocks.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-2">
              {k.rooms} × {typeName.get(k.room_type_id) ?? "room"} · {k.start_date} to {k.end_date} · {k.status === "active" ? "held" : "released"}
              {k.status === "active" && mayBlock && (
                <form action={releaseRoomBlock}>
                  <input type="hidden" name="bookingId" value={id} />
                  <input type="hidden" name="blockId" value={k.id} />
                  <PendingButton className={buttonQuiet} pendingLabel="Releasing…">Release</PendingButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {mayBlock && live && roomTypes.length > 0 && (
        <form action={createRoomBlock} className="mt-3 grid gap-2 sm:grid-cols-5">
          <input type="hidden" name="bookingId" value={id} />
          <select name="roomTypeId" aria-label="Room type" className={inputClass}>
            {roomTypes.map((t) => (<option key={t.id} value={t.id}>{t.name}</option>))}
          </select>
          <input name="rooms" inputMode="numeric" defaultValue="1" aria-label="Rooms" className={inputClass} />
          <input type="date" name="start" required aria-label="From" className={inputClass} />
          <input type="date" name="end" required aria-label="To (check-out)" className={inputClass} />
          <PendingButton className={buttonQuiet} pendingLabel="Holding…">Hold rooms</PendingButton>
        </form>
      )}
      <h3 className="mt-6 text-sm font-medium">Linked stays</h3>
      {stays.length === 0 ? (
        <p className="mt-1 text-sm text-muted">No stays linked.</p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm">
          {stays.map((s) => (
            <li key={s.id} className="flex items-center gap-2">
              <Link href={`/app/reservations/${s.id}`} className={linkClass}>{s.booking_reference}</Link>
              {mayManage && (
                <form action={setStayLink}>
                  <input type="hidden" name="bookingId" value={id} />
                  <input type="hidden" name="mode" value="unlink" />
                  <input type="hidden" name="reservationId" value={s.id} />
                  <PendingButton className={buttonQuiet} pendingLabel="Removing…">Remove</PendingButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {mayManage && live && (
        <form action={setStayLink} className="mt-2 flex items-center gap-2">
          <input type="hidden" name="bookingId" value={id} />
          <input type="hidden" name="mode" value="link" />
          <input name="reference" required placeholder="Booking reference" aria-label="Booking reference" className={inputClass} />
          <PendingButton className={buttonQuiet} pendingLabel="Linking…">Link a stay</PendingButton>
        </form>
      )}
    </main>
  );
}

function MoneyForm({ action, bookingId, returnTo, label, refund }: { action: (f: FormData) => Promise<void>; bookingId: string; returnTo: string; label: string; refund?: boolean }) {
  const methods = PAYMENT_METHODS;
  return (
    <form action={action} className="mt-3 grid gap-2 sm:grid-cols-5">
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <input type="hidden" name="key" value={crypto.randomUUID()} />
      <input name="amount" required inputMode="decimal" placeholder="Amount (naira)" aria-label="Amount in naira" className={inputClass} />
      <select name="method" aria-label="Method" className={inputClass}>
        {methods.map((m) => (<option key={m[0]} value={m[0]}>{m[1]}</option>))}
      </select>
      <input name="reference" maxLength={80} placeholder="Reference" aria-label="Reference" className={inputClass} />
      <input name="note" maxLength={200} placeholder="Note" aria-label="Note" className={inputClass} />
      <PendingButton className={refund ? buttonDanger : buttonQuiet} pendingLabel="Saving…">{label}</PendingButton>
    </form>
  );
}
