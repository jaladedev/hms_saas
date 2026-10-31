import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { buttonDanger, buttonPrimary, buttonQuiet, inputClass, Notice, PaymentChip, ReservationChip } from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { formatDateTime } from "@/lib/staff/format";
import { cancelReservation, checkInRoom, checkOutRoom, issueInvoice, recordPayment, voidInvoice } from "@/lib/staff/reservation-actions";
import {
  attentionText, detailActions, invoiceActions, type InvoiceRow, nightsBetween, PAYMENT_METHODS, SOURCE_LABEL, todayIn,
} from "@/lib/staff/reservations";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Reservation = {
  id: string; property_id: string; booking_reference: string; primary_guest_id: string; source: string;
  reservation_status: string; payment_status: string; arrival_date: string; departure_date: string; currency: string;
  subtotal_minor: number; tax_minor: number; discount_minor: number; total_minor: number;
  cancellation_charge_minor: number; cancel_reason: string | null; cancelled_at: string | null;
  attention_reason: string | null; created_at: string;
};
type ResRoom = {
  id: string; room_type_id: string; room_status: string; adults: number; children: number;
  checked_in_at: string | null; checked_out_at: string | null;
};
type Night = { reservation_room_id: string; night_date: string; rate_minor: number; tax_minor: number };
type Claim = { reservation_room_id: string; room_id: string; start_date: string; end_date: string };
type Room = { id: string; room_number: string; housekeeping_status: string; operational_status: string };
type Settlement = { applicable: boolean; held_minor: number; charge_minor: number; charge_due_minor: number; settled: boolean };

const HOUSEKEEPING: Record<string, string> = { clean: "clean", dirty: "dirty", in_progress: "being cleaned", inspected: "inspected" };
const ROOM_STATUS: Record<string, string> = { booked: "Not arrived", checked_in: "In house", checked_out: "Checked out", cancelled: "Cancelled" };

export default async function ReservationPage({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  if (!z.guid().safeParse(id).success) notFound();
  const search = await searchParams;
  const supabase = await createClient();

  const { data: resRow } = await supabase
    .from("reservations")
    .select("id, property_id, booking_reference, primary_guest_id, source, reservation_status, payment_status, arrival_date, departure_date, currency, subtotal_minor, tax_minor, discount_minor, total_minor, cancellation_charge_minor, cancel_reason, cancelled_at, attention_reason, created_at")
    .eq("id", id).maybeSingle();
  if (!resRow) notFound();
  const res = resRow as Reservation;

  const can = (permission: string) => supabase.rpc("has_permission", { p_property: res.property_id, p_permission: permission });
  const [roomsQ, guestQ, propQ, settleQ, cCancel, cIn, cOut, cPay, invQ, cIssue, cVoid] = await Promise.all([
    supabase.from("reservation_rooms").select("id, room_type_id, room_status, adults, children, checked_in_at, checked_out_at").eq("reservation_id", id).order("created_at"),
    supabase.from("guests").select("full_name, email, phone").eq("id", res.primary_guest_id).maybeSingle(),
    supabase.from("properties").select("name, timezone").eq("id", res.property_id).maybeSingle(),
    supabase.rpc("reservation_settlement", { p_reservation_id: id }),
    can("reservation.cancel"), can("reservation.checkin"), can("reservation.checkout"), can("payment.record"),
    supabase.from("invoices").select("id, invoice_number, invoice_status, total_minor").eq("reservation_id", id).order("created_at"),
    can("invoice.issue"), can("invoice.void"),
  ]);

  const resRooms = (roomsQ.data ?? []) as ResRoom[];
  const roomIds = resRooms.map((r) => r.id);

  const [nightsQ, typeQ, claimQ] = await Promise.all([
    roomIds.length ? supabase.from("reservation_nights").select("reservation_room_id, night_date, rate_minor, tax_minor").in("reservation_room_id", roomIds).order("night_date") : { data: [] },
    resRooms.length ? supabase.from("room_types").select("id, name").in("id", [...new Set(resRooms.map((r) => r.room_type_id))]) : { data: [] },
    roomIds.length
      ? supabase.from("room_inventory_claims").select("reservation_room_id, room_id, start_date, end_date").in("reservation_room_id", roomIds).eq("status", "active").in("claim_type", ["stay", "hold"]).order("start_date")
      : { data: [] },
  ]);
  const nights = (nightsQ.data ?? []) as Night[];
  const claims = (claimQ.data ?? []) as Claim[];
  const physicalQ = claims.length ? await supabase.from("rooms").select("id, room_number, housekeeping_status, operational_status").in("id", [...new Set(claims.map((c) => c.room_id))]) : { data: [] };
  const typeNames = new Map(((typeQ.data ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]));
  const physical = new Map(((physicalQ.data ?? []) as Room[]).map((r) => [r.id, r]));

  const guest = guestQ.data as { full_name: string; email: string | null; phone: string | null } | null;
  const tz = (propQ.data as { timezone?: string } | null)?.timezone ?? "UTC";
  const propertyName = (propQ.data as { name?: string } | null)?.name;
  const settlement = (settleQ.error ? null : settleQ.data ?? null) as Settlement | null;
  const held = settlement?.held_minor ?? null;
  const today = todayIn(tz, new Date());
  const act = detailActions(res, {
    cancel: cCancel.data === true, checkin: cIn.data === true, checkout: cOut.data === true, payment: cPay.data === true,
  }, today, held);
  // Invoices are readable only with invoice.issue, payment.record or report.view; without them the list is simply empty.
  const invoices = (invQ.data ?? []) as InvoiceRow[];
  const inv = invoiceActions(res.reservation_status, invoices, { issue: cIssue.data === true, void: cVoid.data === true });
  const money = (m: number) => formatMoney(m, res.currency);
  const stayNights = nightsBetween(res.arrival_date, res.departure_date);
  const cancelled = res.reservation_status === "cancelled";
  const outstanding = held === null ? null : cancelled ? settlement?.charge_due_minor ?? 0 : Math.max(res.total_minor - held, 0);
  const closed = res.reservation_status === "expired" || res.reservation_status === "no_show";
  const errCode = Array.isArray(search.err) ? search.err[0] : search.err;
  const paymentRefused = errCode === "overpayment" || errCode === "amount_invalid" || errCode === "method_invalid";

  return (
    <main className="max-w-4xl">
      <p className="text-sm"><Link href="/app/reservations" className="text-primary-strong underline underline-offset-2">Reservations</Link></p>
      <h1 className="mt-2 font-display text-3xl">{res.booking_reference}</h1>
      <p className="mt-1 text-muted">
        {guest?.full_name ?? "Guest not visible to you"}{propertyName ? `, ${propertyName}` : ""}
      </p>
      <p className="mt-2 flex flex-wrap gap-2"><ReservationChip status={res.reservation_status} /><PaymentChip status={res.payment_status} /></p>

      <div className="mt-6"><Notice search={search} currency={res.currency} /></div>

      {res.attention_reason && (
        <p className="mb-6 border-l-4 border-pending bg-pending/5 px-4 py-3 text-sm">{attentionText(res.attention_reason)}</p>
      )}

      <section aria-labelledby="stay">
        <h2 id="stay" className="font-display text-xl">Stay</h2>
        <dl className="mt-3 grid max-w-xl grid-cols-[9rem_1fr] gap-y-1.5 text-sm">
          <dt className="text-muted">Arrival</dt><dd>{formatDate(res.arrival_date)}</dd>
          <dt className="text-muted">Departure</dt><dd>{formatDate(res.departure_date)} ({stayNights} {stayNights === 1 ? "night" : "nights"})</dd>
          <dt className="text-muted">Booked</dt><dd>{formatDateTime(res.created_at, tz)}, {SOURCE_LABEL[res.source] ?? res.source}</dd>
          {guest?.email && (<><dt className="text-muted">Email</dt><dd className="break-all">{guest.email}</dd></>)}
          {guest?.phone && (<><dt className="text-muted">Phone</dt><dd>{guest.phone}</dd></>)}
          {cancelled && (
            <>
              <dt className="text-muted">Cancelled</dt>
              <dd>{res.cancelled_at ? formatDateTime(res.cancelled_at, tz) : ""}{res.cancel_reason ? `: ${res.cancel_reason}` : ""}</dd>
            </>
          )}
        </dl>
      </section>

      <section className="mt-10" aria-labelledby="rooms">
        <h2 id="rooms" className="font-display text-xl">Rooms</h2>
        {resRooms.length === 0 ? <p className="mt-2 text-muted">No rooms are visible on this booking.</p> : (
          <ul className="mt-2 border-t border-line">
            {resRooms.map((rr, i) => {
              const mine = claims.filter((c) => c.reservation_room_id === rr.id);
              const current = mine.find((c) => c.start_date <= today && c.end_date > today) ?? mine[0];
              const room = current ? physical.get(current.room_id) : undefined;
              const roomNights = nights.filter((n) => n.reservation_room_id === rr.id);
              const roomTotal = roomNights.reduce((s, n) => s + n.rate_minor + n.tax_minor, 0);
              const showReady = rr.room_status === "booked" && room;
              return (
                <li key={rr.id} className="grid gap-x-8 gap-y-3 border-b border-line py-5 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {typeNames.get(rr.room_type_id) ?? "Room"}{resRooms.length > 1 ? ` (room ${i + 1} of ${resRooms.length})` : ""}
                      <span className="ml-3 rounded bg-ink/10 px-2 py-0.5 text-xs font-medium">{ROOM_STATUS[rr.room_status] ?? rr.room_status}</span>
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      {rr.adults} {rr.adults === 1 ? "adult" : "adults"}{rr.children > 0 ? `, ${rr.children} ${rr.children === 1 ? "child" : "children"}` : ""}
                      {roomNights.length > 0 ? `, ${money(roomTotal)} for ${roomNights.length} ${roomNights.length === 1 ? "night" : "nights"} with tax` : ""}
                    </p>
                    {mine.length > 0 && (
                      <p className="mt-1 text-sm">
                        {mine.map((c) => {
                          const p = physical.get(c.room_id);
                          return `Room ${p?.room_number ?? "?"}${mine.length > 1 ? ` (${formatDate(c.start_date)} to ${formatDate(c.end_date)})` : ""}`;
                        }).join(", then ")}
                        {showReady && room.operational_status !== "active" && <span className="text-critical">, out of service</span>}
                        {showReady && room.operational_status === "active" && <span className="text-muted">, currently {HOUSEKEEPING[room.housekeeping_status] ?? room.housekeeping_status}</span>}
                      </p>
                    )}
                    {rr.checked_in_at && <p className="mt-1 text-xs text-muted">Checked in {formatDateTime(rr.checked_in_at, tz)}</p>}
                    {rr.checked_out_at && <p className="mt-1 text-xs text-muted">Checked out {formatDateTime(rr.checked_out_at, tz)}</p>}
                  </div>

                  <div className="space-y-2 md:justify-self-end">
                    {act.checkIn(rr) && (
                      <form action={checkInRoom} className="space-y-2">
                        <input type="hidden" name="reservationId" value={res.id} />
                        <input type="hidden" name="reservationRoomId" value={rr.id} />
                        <button type="submit" className={buttonPrimary}>Check in</button>
                        <details>
                          <summary className="cursor-pointer text-sm text-muted">Room not ready, or payment incomplete?</summary>
                          <label htmlFor={`ov-${rr.id}`} className="mt-2 block text-sm">Override reason</label>
                          <input id={`ov-${rr.id}`} name="overrideReason" maxLength={500} className={inputClass} />
                          <p className="mt-1 text-xs text-muted">Fill this in and press Check in to go ahead anyway. It is recorded against your name.</p>
                        </details>
                      </form>
                    )}
                    {act.checkOut(rr) && (
                      <form action={checkOutRoom} className="space-y-2">
                        <input type="hidden" name="reservationId" value={res.id} />
                        <input type="hidden" name="reservationRoomId" value={rr.id} />
                        <button type="submit" className={buttonQuiet}>Check out</button>
                        {today < res.departure_date && <p className="max-w-xs text-xs text-muted">Leaving before {formatDate(res.departure_date)}: the room is freed for the unused nights.</p>}
                      </form>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-10" aria-labelledby="money">
        <h2 id="money" className="font-display text-xl">Money</h2>
        <dl className="mt-3 max-w-md text-sm">
          {[
            ["Room charges", money(res.subtotal_minor)],
            ["Tax", money(res.tax_minor)],
            ...(res.discount_minor > 0 ? [["Discount", `− ${money(res.discount_minor)}`]] : []),
          ].map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-6 py-1.5">
              <dt className="text-muted">{label}</dt><dd className="tabular-nums">{value}</dd>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-6 border-t-2 border-ink py-2 font-semibold">
            <dt>Total</dt><dd className="tabular-nums">{money(res.total_minor)}</dd>
          </div>
          {cancelled && (
            <div className="flex items-baseline justify-between gap-6 py-1.5">
              <dt className="text-muted">Cancellation charge</dt><dd className="tabular-nums">{money(res.cancellation_charge_minor)}</dd>
            </div>
          )}
          {held !== null && (
            <div className="flex items-baseline justify-between gap-6 py-1.5">
              <dt className="text-muted">Held now (paid in, less refunded)</dt><dd className="tabular-nums">{money(held)}</dd>
            </div>
          )}
          {outstanding !== null && !closed && (
            <div className={`flex items-baseline justify-between gap-6 py-1.5 font-semibold ${outstanding > 0 ? "text-pending" : ""}`}>
              <dt>{cancelled ? "Charge still to collect" : "Still to pay"}</dt><dd className="tabular-nums">{money(outstanding)}</dd>
            </div>
          )}
        </dl>
        {held === null && <p className="mt-2 text-sm text-muted">You do not have access to this reservation's payments.</p>}
        {held !== null && (
          <p className="mt-3 text-sm">
            <Link href={`/app/reservations/${res.id}/settlement`} className="text-primary-strong underline underline-offset-2">
              {cancelled ? "Settlement, payments and refunds" : "Payments and refunds"}
            </Link>
          </p>
        )}

        {act.recordPayment && act.payableCeilingMinor !== null && (
          <details className="mt-4" open={paymentRefused}>
            <summary className="cursor-pointer text-sm font-medium text-primary-strong">Record a payment received at the hotel</summary>
            <form action={recordPayment} className="mt-3 grid max-w-md gap-3">
              <input type="hidden" name="reservationId" value={res.id} />
              <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
              <div>
                <label htmlFor="pay-amount" className="block text-sm">Amount ({res.currency})</label>
                <input id="pay-amount" name="amount" inputMode="decimal" required className={`${inputClass} tabular-nums`} />
                {outstanding !== null && outstanding > 0 && <p className="mt-1 text-xs text-muted">Up to {money(outstanding)}.</p>}
              </div>
              <div>
                <label htmlFor="pay-method" className="block text-sm">Received by</label>
                <select id="pay-method" name="method" required defaultValue="" className={inputClass}>
                  <option value="" disabled>Choose…</option>
                  {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="pay-ref" className="block text-sm">Receipt or transfer number (optional)</label>
                <input id="pay-ref" name="reference" maxLength={200} className={inputClass} />
              </div>
              <div>
                <label htmlFor="pay-note" className="block text-sm">Note (optional)</label>
                <input id="pay-note" name="note" maxLength={500} className={inputClass} />
              </div>
              <div><button type="submit" className={buttonPrimary}>Record payment</button></div>
            </form>
          </details>
        )}
      </section>

      {(invoices.length > 0 || inv.canIssue) && (
        <section className="mt-10" aria-labelledby="invoices">
          <h2 id="invoices" className="font-display text-xl">Invoices</h2>
          {invoices.length > 0 && (
            <ul className="mt-2 border-t border-line">
              {invoices.map((i) => (
                <li key={i.id} className="border-b border-line py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <span><span className="font-medium">{i.invoice_number}</span> <span className="text-sm text-muted">{i.invoice_status.replace("_", " ")}</span></span>
                    <span className="tabular-nums">{money(i.total_minor)}</span>
                  </div>
                  {inv.canVoid(i) && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-sm text-muted">Void this invoice</summary>
                      <form action={voidInvoice} className="mt-2 grid max-w-md gap-2">
                        <input type="hidden" name="reservationId" value={res.id} />
                        <input type="hidden" name="invoiceId" value={i.id} />
                        <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
                        <label htmlFor={`void-${i.id}`} className="block text-sm">Why is it being voided?</label>
                        <textarea id={`void-${i.id}`} name="reason" required maxLength={500} rows={2} className={inputClass} />
                        <p className="text-xs text-muted">An invoice with payments recorded against it cannot be voided until the money has been refunded.</p>
                        <div><button type="submit" className={buttonDanger}>Void invoice</button></div>
                      </form>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
          {inv.canIssue && (
            <form action={issueInvoice} className="mt-3">
              <input type="hidden" name="reservationId" value={res.id} />
              <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
              <button type="submit" className={buttonQuiet}>Issue invoice</button>
              <p className="mt-1 text-xs text-muted">Copies the nights and tax into a numbered invoice. Payments already received are applied to it.</p>
            </form>
          )}
        </section>
      )}

      {act.cancel && (
        <section className="mt-10" aria-labelledby="cancel">
          <h2 id="cancel" className="font-display text-xl">Cancel this reservation</h2>
          <details className="mt-3">
            <summary className={`${buttonDanger} inline-block cursor-pointer list-none`}>Cancel reservation</summary>
            <form action={cancelReservation} className="mt-3 grid max-w-md gap-3">
              <input type="hidden" name="reservationId" value={res.id} />
              <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
              <div>
                <label htmlFor="cancel-reason" className="block text-sm">Why is it being cancelled?</label>
                <textarea id="cancel-reason" name="reason" required maxLength={500} rows={2} className={inputClass} />
              </div>
              <p className="text-xs text-muted">
                The rooms are released at once. A cancellation charge may apply under the booking's policy, and any money held beyond it is queued for refund, which a second person must approve. This cannot be undone.
              </p>
              <div><button type="submit" className={buttonDanger}>Cancel reservation</button></div>
            </form>
          </details>
        </section>
      )}
    </main>
  );
}
