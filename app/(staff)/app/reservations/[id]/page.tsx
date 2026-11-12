import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { FolioSection } from "@/components/staff/folio";
import { StayEdit } from "@/components/staff/stay-edit";
import { Discount } from "@/components/staff/discount";
import { GuestLinkReset } from "@/components/staff/guest-link";
import { discountView } from "@/lib/staff/discount";
import {
  buttonDanger,
  buttonPrimary,
  buttonQuiet,
  inputClass,
  Notice,
  PaymentChip,
  ReservationChip,
  linkClass,
  PageTitle,
  SectionTitle,
} from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { earlyCheckinNote, earlyCheckinWhyNot, parseEarlyCheckinQuote, type EarlyCheckinQuote } from "@/lib/staff/early-checkin";
import { earlyCheckoutNote, parseEarlyQuote, type EarlyQuote } from "@/lib/staff/early-checkout";
import {
  checkoutNote,
  CHARGE_COLUMNS,
  folioIsOpen,
  isFolioResult,
  owingMinor,
  PAYMENT_COLUMNS,
  type ChargeRow,
  type FolioBalance,
  type PaymentRow,
} from "@/lib/staff/folio";
import { availableDocs, documentsPath } from "@/lib/staff/documents";
import { FOLIO_INVOICE_COLUMNS, type FolioInvoiceRow } from "@/lib/staff/folio-invoice";
import { formatDateTime } from "@/lib/staff/format";
import { holdView } from "@/lib/staff/hold";
import { canMarkNoShow, NOTE_MAX } from "@/lib/staff/no-show";
import { stayEditView } from "@/lib/staff/stay-edit";
import {
  cancelReservation,
  checkInRoom,
  earlyCheckInRoom,
  checkOutRoom,
  issueInvoice,
  markNoShow,
  recordPayment,
  transferRoom,
  voidInvoice,
  changeRoomType,
} from "@/lib/staff/reservation-actions";
import {
  attentionText,
  detailActions,
  invoiceActions,
  type InvoiceRow,
  nightsBetween,
  PAYMENT_METHODS,
  SOURCE_LABEL,
  todayIn,
} from "@/lib/staff/reservations";
import { canChangeType, otherTypes, typeChangeWindow, type TypeOption } from "@/lib/staff/room-type-change";
import { candidateRooms, canTransfer, transferWindow, type CandidateRoom, type ClaimSpan } from "@/lib/staff/transfer";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Reservation = {
  id: string;
  property_id: string;
  booking_reference: string;
  primary_guest_id: string;
  source: string;
  reservation_status: string;
  payment_status: string;
  arrival_date: string;
  departure_date: string;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  discount_minor: number;
  discount_percent: number | string | null;
  discount_amount_minor: number | null;
  discount_reason: string | null;
  total_minor: number;
  cancellation_charge_minor: number;
  cancel_reason: string | null;
  cancelled_at: string | null;
  no_show_at: string | null;
  attention_reason: string | null;
  guest_note: string | null;
  created_at: string;
};
type ResRoom = {
  id: string;
  room_type_id: string;
  room_status: string;
  adults: number;
  children: number;
  checked_in_at: string | null;
  checked_out_at: string | null;
};
type Night = { reservation_room_id: string; night_date: string; rate_minor: number; tax_minor: number };
type Claim = {
  reservation_room_id: string;
  room_id: string;
  start_date: string;
  end_date: string;
  claim_type?: string;
  hold_expires_at?: string | null;
};
type Room = { id: string; room_number: string; housekeeping_status: string; operational_status: string };
type Settlement = { applicable: boolean; held_minor: number; charge_minor: number; charge_due_minor: number; settled: boolean };

const HOUSEKEEPING: Record<string, string> = { clean: "clean", dirty: "dirty", in_progress: "being cleaned", inspected: "inspected" };
const ROOM_STATUS: Record<string, string> = {
  booked: "Not arrived",
  checked_in: "In house",
  checked_out: "Checked out",
  cancelled: "Cancelled",
};

export default async function ReservationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  if (!z.guid().safeParse(id).success) notFound();
  const search = await searchParams;
  const supabase = await createClient();

  const { data: resRow } = await supabase
    .from("reservations")
    .select(
      "id, property_id, booking_reference, primary_guest_id, source, reservation_status, payment_status, arrival_date, departure_date, currency, subtotal_minor, tax_minor, discount_minor, discount_percent, discount_amount_minor, discount_reason, total_minor, cancellation_charge_minor, cancel_reason, cancelled_at, no_show_at, attention_reason, guest_note, created_at, policy_snapshot",
    )
    .eq("id", id)
    .maybeSingle();
  if (!resRow) notFound();
  const res = resRow as Reservation;

  const can = (permission: string) => supabase.rpc("has_permission", { p_property: res.property_id, p_permission: permission });
  // A guest who has not arrived has no folio, so nothing is read for one. A person who may not see it gets an error from
  // folio_balance (the database answers "not found"), and then the whole section is left out.
  const showFolio = folioIsOpen(res.reservation_status);
  const [
    roomsQ,
    guestQ,
    propQ,
    settleQ,
    cCancel,
    cIn,
    cOut,
    cPay,
    invQ,
    cIssue,
    cVoid,
    cAssign,
    folioBalQ,
    folioChargesQ,
    folioPaymentsQ,
    cFolio,
    cReverse,
    folioInvQ,
    cModify,
    cDiscount,
  ] = await Promise.all([
    supabase
      .from("reservation_rooms")
      .select("id, room_type_id, room_status, adults, children, checked_in_at, checked_out_at")
      .eq("reservation_id", id)
      .order("created_at"),
    supabase.from("guests").select("full_name, email, phone, address").eq("id", res.primary_guest_id).maybeSingle(),
    supabase.from("properties").select("name, timezone").eq("id", res.property_id).maybeSingle(),
    supabase.rpc("reservation_settlement", { p_reservation_id: id }),
    can("reservation.cancel"),
    can("reservation.checkin"),
    can("reservation.checkout"),
    can("payment.record"),
    supabase.from("invoices").select("id, invoice_number, invoice_status, total_minor").eq("reservation_id", id).order("created_at"),
    can("invoice.issue"),
    can("invoice.void"),
    can("room.assign"),
    showFolio ? supabase.rpc("folio_balance", { p_reservation_id: id }) : null,
    showFolio ? supabase.from("folio_charges").select(CHARGE_COLUMNS).eq("reservation_id", id) : null,
    showFolio ? supabase.from("folio_payments").select(PAYMENT_COLUMNS).eq("reservation_id", id) : null,
    showFolio ? can("folio.charge") : null,
    showFolio ? can("refund.approve") : null,
    showFolio ? supabase.from("folio_invoices").select(FOLIO_INVOICE_COLUMNS).eq("reservation_id", id) : null,
    // Editing dates and guests: only a confirmed booking can be edited, so nothing is read for any other.
    res.reservation_status === "confirmed" ? can("reservation.modify") : null,
    res.reservation_status === "confirmed" ? can("discount.apply") : null,
  ]);

  const resRooms = (roomsQ.data ?? []) as ResRoom[];
  const roomIds = resRooms.map((r) => r.id);

  const [nightsQ, typeQ, claimQ] = await Promise.all([
    roomIds.length
      ? supabase
          .from("reservation_nights")
          .select("reservation_room_id, night_date, rate_minor, tax_minor")
          .in("reservation_room_id", roomIds)
          .order("night_date")
      : { data: [] },
    resRooms.length
      ? supabase
          .from("room_types")
          .select("id, name, max_adults, max_children")
          .in("id", [...new Set(resRooms.map((r) => r.room_type_id))])
      : { data: [] },
    roomIds.length
      ? supabase
          .from("room_inventory_claims")
          .select("reservation_room_id, room_id, start_date, end_date, claim_type, hold_expires_at")
          .in("reservation_room_id", roomIds)
          .eq("status", "active")
          .in("claim_type", ["stay", "hold"])
          .order("start_date")
      : { data: [] },
  ]);
  const nights = (nightsQ.data ?? []) as Night[];
  const claims = (claimQ.data ?? []) as Claim[];
  const physicalQ = claims.length
    ? await supabase
        .from("rooms")
        .select("id, room_number, housekeeping_status, operational_status")
        .in("id", [...new Set(claims.map((c) => c.room_id))])
    : { data: [] };
  // Rooms a guest could be moved to, and what is already claimed on them. Only read when a move can be offered.
  const mayMove = cAssign.data === true && resRooms.some((r) => canTransfer(r.room_status, res.reservation_status, true));
  const moveTypes = mayMove ? [...new Set(resRooms.map((r) => r.room_type_id))] : [];
  const sameTypeQ = moveTypes.length
    ? await supabase
        .from("rooms")
        .select("id, room_number, room_type_id, operational_status")
        .eq("property_id", res.property_id)
        .in("room_type_id", moveTypes)
        .eq("operational_status", "active")
    : { data: [] };
  const sameTypeRooms = (sameTypeQ.data ?? []) as CandidateRoom[];
  // Room types a guest could be moved to (migration 083). Only read when the change can be offered.
  const mayChangeType = resRooms.some((r) =>
    canChangeType(r.room_status, res.reservation_status, cAssign.data === true, res.discount_minor > 0),
  );
  const typeOptionsQ = mayChangeType
    ? await supabase.from("room_types").select("id, name, status").eq("property_id", res.property_id)
    : { data: [] };
  const allTypes = (typeOptionsQ.data ?? []) as TypeOption[];
  const claimSpansQ = sameTypeRooms.length
    ? await supabase
        .from("room_inventory_claims")
        .select("room_id, start_date, end_date")
        .in(
          "room_id",
          sameTypeRooms.map((r) => r.id),
        )
        .eq("status", "active")
        .gt("end_date", res.arrival_date)
        .lt("start_date", res.departure_date)
    : { data: [] };
  const spans = (claimSpansQ.data ?? []) as ClaimSpan[];
  const typeRows = (typeQ.data ?? []) as { id: string; name: string; max_adults: number; max_children: number }[];
  const typeNames = new Map(typeRows.map((t) => [t.id, t.name]));
  const physical = new Map(((physicalQ.data ?? []) as Room[]).map((r) => [r.id, r]));

  const guest = guestQ.data as { full_name: string; email: string | null; phone: string | null; address: string | null } | null;
  const tz = (propQ.data as { timezone?: string } | null)?.timezone ?? "UTC";
  const propertyName = (propQ.data as { name?: string } | null)?.name;
  const settlement = (settleQ.error ? null : (settleQ.data ?? null)) as Settlement | null;
  const held = settlement?.held_minor ?? null;
  const today = todayIn(tz, new Date());
  const act = detailActions(
    res,
    {
      cancel: cCancel.data === true,
      checkin: cIn.data === true,
      checkout: cOut.data === true,
      payment: cPay.data === true,
    },
    today,
    held,
  );
  // Invoices are readable only with invoice.issue, payment.record or report.view; without them the list is simply empty.
  const invoices = (invQ.data ?? []) as InvoiceRow[];
  const inv = invoiceActions(res.reservation_status, invoices, { issue: cIssue.data === true, void: cVoid.data === true });
  const money = (m: number) => formatMoney(m, res.currency);
  // What check-out would do for each guest in the house who is leaving early, under the hotel's policy (migration 060).
  // And, for a booking whose guest turns up before the arrival date, what an early check-in would do (migration 061).
  const earlyInQuotes = new Map<string, EarlyCheckinQuote>();
  if (cIn.data === true && res.reservation_status === "confirmed" && today < res.arrival_date) {
    const waiting = resRooms.filter((x) => x.room_status === "booked");
    const answers = await Promise.all(waiting.map((x) => supabase.rpc("early_checkin_quote", { p_reservation_room_id: x.id })));
    answers.forEach((a, i) => {
      const q = parseEarlyCheckinQuote(a.data);
      if (q) earlyInQuotes.set(waiting[i]!.id, q);
    });
  }
  const earlyQuotes = new Map<string, EarlyQuote>();
  if (cOut.data === true && today < res.departure_date) {
    const inHouse = resRooms.filter((x) => x.room_status === "checked_in");
    const answers = await Promise.all(inHouse.map((x) => supabase.rpc("early_checkout_quote", { p_reservation_room_id: x.id })));
    answers.forEach((a, i) => {
      const q = parseEarlyQuote(a.data);
      if (q) earlyQuotes.set(inHouse[i]!.id, q);
    });
  }
  const holdTimes = claims
    .filter((c) => c.claim_type === "hold" && c.hold_expires_at)
    .map((c) => c.hold_expires_at as string)
    .sort();
  const hold = holdView(
    res.reservation_status,
    holdTimes[0] ?? null,
    new Date(),
    res.total_minor,
    (res as { policy_snapshot?: unknown }).policy_snapshot as Parameters<typeof holdView>[4],
    held,
  );
  const stayNights = nightsBetween(res.arrival_date, res.departure_date);
  const cancelled = res.reservation_status === "cancelled";
  const noShowOffered = canMarkNoShow({
    reservationStatus: res.reservation_status,
    rooms: resRooms,
    canCancel: act.cancel,
    today,
    arrival: res.arrival_date,
  });
  const outstanding = held === null ? null : cancelled ? (settlement?.charge_due_minor ?? 0) : Math.max(res.total_minor - held, 0);
  const closed = res.reservation_status === "expired" || res.reservation_status === "no_show";
  const errCode = Array.isArray(search.err) ? search.err[0] : search.err;
  const paymentRefused = errCode === "overpayment" || errCode === "amount_invalid" || errCode === "method_invalid";

  // The folio: extras charged during the stay, kept beside the booking's own money. No balance means no access.
  const folio = folioBalQ && !folioBalQ.error ? (folioBalQ.data as FolioBalance | null) : null;
  const folioCheckoutNote = checkoutNote(owingMinor(folio), money);
  const folioRooms =
    resRooms.length > 1
      ? resRooms.map((rr, i) => {
          const mine = claims.filter((c) => c.reservation_room_id === rr.id);
          const current = mine.find((c) => c.start_date <= today && c.end_date > today) ?? mine[0];
          const number = current ? physical.get(current.room_id)?.room_number : undefined;
          const type = typeNames.get(rr.room_type_id) ?? "Room";
          return { id: rr.id, label: number ? `Room ${number} (${type})` : `${type} (room ${i + 1} of ${resRooms.length})` };
        })
      : [];

  // Edit dates and guests (migration 033; with money on the booking since 070).
  const stayView = stayEditView({
    reservationStatus: res.reservation_status,
    rooms: resRooms,
    canModify: cModify?.data === true,
  });
  const liveInvoices = invoices.filter((i) => i.invoice_status !== "void").length;
  const discountState = discountView({
    canApply: cDiscount?.data === true,
    reservationStatus: res.reservation_status,
    liveInvoiceCount: liveInvoices,
    current:
      res.discount_amount_minor !== null
        ? { kind: "amount", amountMinor: res.discount_amount_minor }
        : res.discount_percent !== null
          ? { kind: "percent", percent: Number(res.discount_percent) }
          : { kind: "none" },
  });
  const stayRooms = resRooms.map((rr, i) => {
    const t = typeRows.find((x) => x.id === rr.room_type_id);
    return {
      id: rr.id,
      label: `${typeNames.get(rr.room_type_id) ?? "Room"}${resRooms.length > 1 ? ` (room ${i + 1} of ${resRooms.length})` : ""}`,
      adults: rr.adults,
      children: rr.children,
      maxAdults: t?.max_adults ?? 20,
      maxChildren: t?.max_children ?? 20,
    };
  });

  return (
    <main className="max-w-4xl">
      <p className="flex flex-wrap gap-x-4 text-sm">
        <Link href="/app/reservations" className={linkClass}>
          Reservations
        </Link>
        {availableDocs({ status: res.reservation_status, invoices: invoices.length, succeededPayments: Math.min(held ?? 0, 1) }).length >
          0 && (
          <Link href={documentsPath(res.id)} className={linkClass}>
            Documents
          </Link>
        )}
      </p>
      <PageTitle className="mt-2">{res.booking_reference}</PageTitle>
      <p className="mt-1 text-muted">
        {guest ? (
          <Link href={`/app/guests/${res.primary_guest_id}`} className="underline underline-offset-2">
            {guest.full_name}
          </Link>
        ) : (
          "Guest not visible to you"
        )}
        {propertyName ? `, ${propertyName}` : ""}
      </p>
      <p className="mt-2 flex flex-wrap gap-2">
        <ReservationChip status={res.reservation_status} />
        <PaymentChip status={res.payment_status} />
      </p>

      <div className="mt-6">{!(folio && isFolioResult(search)) && <Notice search={search} currency={res.currency} />}</div>

      {res.attention_reason && (
        <p className="mb-6 border-l-4 border-pending bg-pending/5 px-4 py-3 text-sm">{attentionText(res.attention_reason)}</p>
      )}

      {hold.kind === "live" && (
        <p className="mb-6 border-l-4 border-pending bg-pending/5 px-4 py-3 text-sm">
          Room held until {formatDateTime(hold.until, tz)}. Record a payment of at least {money(hold.stillNeededMinor)} to confirm the
          booking; if the time runs out the room is released.
        </p>
      )}
      {hold.kind === "lapsed" && (
        <p className="mb-6 border-l-4 border-pending bg-pending/5 px-4 py-3 text-sm">
          The hold on this room has run out, so the room is no longer held and no payment can be taken. Book the room again if it is still
          free.
        </p>
      )}

      <section aria-labelledby="stay">
        <SectionTitle id="stay">Stay</SectionTitle>
        <dl className="mt-3 grid max-w-xl grid-cols-[9rem_1fr] gap-y-1.5 text-sm">
          <dt className="text-muted">Arrival</dt>
          <dd>{formatDate(res.arrival_date)}</dd>
          <dt className="text-muted">Departure</dt>
          <dd>
            {formatDate(res.departure_date)} ({stayNights} {stayNights === 1 ? "night" : "nights"})
          </dd>
          <dt className="text-muted">Booked</dt>
          <dd>
            {formatDateTime(res.created_at, tz)}, {SOURCE_LABEL[res.source] ?? res.source}
          </dd>
          {guest?.email && (
            <>
              <dt className="text-muted">Email</dt>
              <dd className="break-all">{guest.email}</dd>
            </>
          )}
          {guest?.phone && (
            <>
              <dt className="text-muted">Phone</dt>
              <dd>{guest.phone}</dd>
            </>
          )}
          {guest?.address && (
            <>
              <dt className="text-muted">Address</dt>
              <dd>{guest.address}</dd>
            </>
          )}
          {res.guest_note && (
            <>
              <dt className="text-muted">Guest requests</dt>
              <dd className="whitespace-pre-line">{res.guest_note}</dd>
            </>
          )}
          {cancelled && (
            <>
              <dt className="text-muted">{res.no_show_at ? "No-show" : "Cancelled"}</dt>
              <dd>
                {res.cancelled_at ? formatDateTime(res.cancelled_at, tz) : ""}
                {res.cancel_reason ? `: ${res.cancel_reason}` : ""}
              </dd>
            </>
          )}
        </dl>
        {stayView.kind !== "hidden" && (
          <StayEdit reservationId={res.id} arrival={res.arrival_date} departure={res.departure_date} today={today} rooms={stayRooms} />
        )}
      </section>

      <section className="mt-10" aria-labelledby="rooms">
        <SectionTitle id="rooms">Rooms</SectionTitle>
        {resRooms.length === 0 ? (
          <p className="mt-2 text-muted">No rooms are visible on this booking.</p>
        ) : (
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
                      {typeNames.get(rr.room_type_id) ?? "Room"}
                      {resRooms.length > 1 ? ` (room ${i + 1} of ${resRooms.length})` : ""}
                      <span className="ml-3 rounded bg-ink/10 px-2 py-0.5 text-xs font-medium">
                        {ROOM_STATUS[rr.room_status] ?? rr.room_status}
                      </span>
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      {rr.adults} {rr.adults === 1 ? "adult" : "adults"}
                      {rr.children > 0 ? `, ${rr.children} ${rr.children === 1 ? "child" : "children"}` : ""}
                      {roomNights.length > 0
                        ? `, ${money(roomTotal)} for ${roomNights.length} ${roomNights.length === 1 ? "night" : "nights"} with tax`
                        : ""}
                    </p>
                    {mine.length > 0 && (
                      <p className="mt-1 text-sm">
                        {mine
                          .map((c) => {
                            const p = physical.get(c.room_id);
                            return `Room ${p?.room_number ?? "?"}${mine.length > 1 ? ` (${formatDate(c.start_date)} to ${formatDate(c.end_date)})` : ""}`;
                          })
                          .join(", then ")}
                        {showReady && room.operational_status !== "active" && <span className="text-critical">, out of service</span>}
                        {showReady && room.operational_status === "active" && (
                          <span className="text-muted">
                            , currently {HOUSEKEEPING[room.housekeeping_status] ?? room.housekeeping_status}
                          </span>
                        )}
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
                        <button type="submit" className={buttonPrimary}>
                          Check in
                        </button>
                        <details>
                          <summary className="cursor-pointer text-sm text-muted">Room not ready, or payment incomplete?</summary>
                          <label htmlFor={`ov-${rr.id}`} className="mt-2 block text-sm">
                            Override reason
                          </label>
                          <input id={`ov-${rr.id}`} name="overrideReason" maxLength={500} className={inputClass} />
                          <p className="mt-1 text-xs text-muted">
                            Fill this in and press Check in to go ahead anyway. It is recorded against your name.
                          </p>
                        </details>
                      </form>
                    )}
                    {(() => {
                      const eq = earlyInQuotes.get(rr.id);
                      if (!eq) return null;
                      if (!eq.allowed) {
                        const why = earlyCheckinWhyNot(eq);
                        return why ? <p className="max-w-xs text-xs text-muted">{why}</p> : null;
                      }
                      return (
                        <form action={earlyCheckInRoom} className="max-w-xs space-y-2">
                          <input type="hidden" name="reservationId" value={res.id} />
                          <input type="hidden" name="reservationRoomId" value={rr.id} />
                          <p className="text-xs text-muted">{earlyCheckinNote(eq, money)}</p>
                          <label htmlFor={`eci-${rr.id}`} className="block text-sm">
                            Reason for checking in early
                          </label>
                          <input id={`eci-${rr.id}`} name="reason" required maxLength={200} className={inputClass} />
                          {cDiscount?.data === true && res.discount_minor === 0 && (
                            <label className="flex items-start gap-2 text-sm">
                              <input type="checkbox" name="waive" className="mt-1" /> Waive the charge for the earlier nights (a discount,
                              within your limit)
                            </label>
                          )}
                          <button type="submit" className={buttonPrimary}>
                            Check in early
                          </button>
                        </form>
                      );
                    })()}
                    {(() => {
                      const win = canTransfer(rr.room_status, res.reservation_status, cAssign.data === true)
                        ? transferWindow(res.arrival_date, res.departure_date, today)
                        : null;
                      if (!win) return null;
                      const here = mine.find((c) => c.start_date <= win.initial && c.end_date > win.initial);
                      const options = candidateRooms(
                        sameTypeRooms,
                        rr.room_type_id,
                        new Set(here ? [here.room_id] : []),
                        win.initial,
                        res.departure_date,
                        spans,
                      );
                      return (
                        <details>
                          <summary className="cursor-pointer text-sm font-medium text-primary-strong">Move to another room</summary>
                          <form action={transferRoom} className="mt-3 space-y-3">
                            <input type="hidden" name="reservationId" value={res.id} />
                            <input type="hidden" name="reservationRoomId" value={rr.id} />
                            <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
                            <div>
                              <label htmlFor={`to-${rr.id}`} className="block text-sm">
                                New room
                              </label>
                              <select id={`to-${rr.id}`} name="newRoomId" defaultValue="" className={inputClass}>
                                <option value="">Any free room of this type</option>
                                {options.map((o) => (
                                  <option key={o.id} value={o.id}>
                                    Room {o.room_number}
                                    {o.busy ? " (taken for part of this stay)" : ""}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label htmlFor={`on-${rr.id}`} className="block text-sm">
                                Move on
                              </label>
                              <input
                                id={`on-${rr.id}`}
                                name="effective"
                                type="date"
                                required
                                min={win.min}
                                max={win.max}
                                defaultValue={win.initial}
                                className={inputClass}
                              />
                            </div>
                            <div>
                              <label htmlFor={`why-${rr.id}`} className="block text-sm">
                                Reason
                              </label>
                              <textarea id={`why-${rr.id}`} name="reason" required maxLength={500} rows={2} className={inputClass} />
                            </div>
                            <button type="submit" className={buttonQuiet}>
                              Move guest
                            </button>
                            <p className="max-w-xs text-xs text-muted">
                              Same room type only, so the price stays the same. The stay from that date to {formatDate(res.departure_date)}{" "}
                              moves; earlier nights stay in the current room. If the new room is taken, nothing changes.
                            </p>
                          </form>
                        </details>
                      );
                    })()}
                    {(() => {
                      const win = canChangeType(rr.room_status, res.reservation_status, cAssign.data === true, res.discount_minor > 0)
                        ? typeChangeWindow(res.arrival_date, res.departure_date, today)
                        : null;
                      const types = otherTypes(allTypes, rr.room_type_id);
                      if (!win || types.length === 0) return null;
                      return (
                        <details>
                          <summary className="cursor-pointer text-sm font-medium text-primary-strong">Change room type</summary>
                          <form action={changeRoomType} className="mt-3 space-y-3">
                            <input type="hidden" name="reservationId" value={res.id} />
                            <input type="hidden" name="reservationRoomId" value={rr.id} />
                            <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
                            <div>
                              <label htmlFor={`ty-${rr.id}`} className="block text-sm">
                                New room type
                              </label>
                              <select id={`ty-${rr.id}`} name="newTypeId" required defaultValue="" className={inputClass}>
                                <option value="" disabled>
                                  Choose a type
                                </option>
                                {types.map((t) => (
                                  <option key={t.id} value={t.id}>
                                    {t.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label htmlFor={`tyon-${rr.id}`} className="block text-sm">
                                First night in the new type
                              </label>
                              <input
                                id={`tyon-${rr.id}`}
                                name="effective"
                                type="date"
                                required
                                min={win.min}
                                max={win.max}
                                defaultValue={win.initial}
                                className={inputClass}
                              />
                            </div>
                            <div>
                              <label htmlFor={`tywhy-${rr.id}`} className="block text-sm">
                                Reason
                              </label>
                              <textarea id={`tywhy-${rr.id}`} name="reason" required maxLength={200} rows={2} className={inputClass} />
                            </div>
                            <button type="submit" className={buttonQuiet}>
                              Change room type
                            </button>
                            <p className="max-w-xs text-xs text-muted">
                              The nights from that date to {formatDate(res.departure_date)} are priced at the new type&rsquo;s rate; earlier
                              nights keep their price. A free room of the new type is chosen for you. An invoice already issued is replaced.
                              If the new type costs less than the guest has paid, a refund is flagged for you to request. If no room is
                              free, nothing changes.
                            </p>
                          </form>
                        </details>
                      );
                    })()}
                    {act.checkOut(rr) && (
                      <form action={checkOutRoom} className="space-y-2">
                        <input type="hidden" name="reservationId" value={res.id} />
                        <input type="hidden" name="reservationRoomId" value={rr.id} />
                        <button type="submit" className={buttonQuiet}>
                          Check out
                        </button>
                        {today < res.departure_date && (
                          <p className="max-w-xs text-xs text-muted">
                            {(earlyQuotes.get(rr.id) &&
                              earlyCheckoutNote(earlyQuotes.get(rr.id)!, formatDate(res.departure_date), money)) ??
                              `Leaving before ${formatDate(res.departure_date)}: the room is freed for the unused nights.`}
                          </p>
                        )}
                        {folioCheckoutNote && (
                          <p className="max-w-xs text-xs text-pending">
                            {folioCheckoutNote}{" "}
                            <a href="#folio" className="underline underline-offset-2">
                              See folio
                            </a>
                          </p>
                        )}
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
        <SectionTitle id="money">Money</SectionTitle>
        <dl className="mt-3 max-w-md text-sm">
          {[
            ["Room charges", money(res.subtotal_minor)],
            ["Tax", money(res.tax_minor)],
            ...(res.discount_minor > 0
              ? [
                  [
                    `Discount${res.discount_percent !== null ? ` (${Number(res.discount_percent)}%)` : ""}`,
                    `− ${money(res.discount_minor)}`,
                  ],
                ]
              : []),
          ].map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-6 py-1.5">
              <dt className="text-muted">{label}</dt>
              <dd className="tabular-nums">{value}</dd>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-6 border-t-2 border-ink py-2 font-semibold">
            <dt>Total</dt>
            <dd className="tabular-nums">{money(res.total_minor)}</dd>
          </div>
          {cancelled && (
            <div className="flex items-baseline justify-between gap-6 py-1.5">
              <dt className="text-muted">Cancellation charge</dt>
              <dd className="tabular-nums">{money(res.cancellation_charge_minor)}</dd>
            </div>
          )}
          {held !== null && (
            <div className="flex items-baseline justify-between gap-6 py-1.5">
              <dt className="text-muted">Held now (paid in, less refunded)</dt>
              <dd className="tabular-nums">{money(held)}</dd>
            </div>
          )}
          {outstanding !== null && !closed && (
            <div className={`flex items-baseline justify-between gap-6 py-1.5 font-semibold ${outstanding > 0 ? "text-pending" : ""}`}>
              <dt>{cancelled ? "Charge still to collect" : "Still to pay"}</dt>
              <dd className="tabular-nums">{money(outstanding)}</dd>
            </div>
          )}
        </dl>
        {res.discount_reason && res.discount_minor > 0 && (
          <p className="mt-1 max-w-md text-sm text-muted">Discount reason: {res.discount_reason}</p>
        )}
        {discountState.kind !== "hidden" && <Discount reservationId={res.id} view={discountState} />}
        {cModify?.data === true && <GuestLinkReset reservationId={res.id} />}
        {held === null && <p className="mt-2 text-sm text-muted">You do not have access to this reservation's payments.</p>}
        {held !== null && (
          <p className="mt-3 text-sm">
            <Link href={`/app/reservations/${res.id}/settlement`} className={linkClass}>
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
                <label htmlFor="pay-amount" className="block text-sm">
                  Amount ({res.currency})
                </label>
                <input id="pay-amount" name="amount" inputMode="decimal" required className={`${inputClass} tabular-nums`} />
                {outstanding !== null && outstanding > 0 && <p className="mt-1 text-xs text-muted">Up to {money(outstanding)}.</p>}
              </div>
              <div>
                <label htmlFor="pay-method" className="block text-sm">
                  Received by
                </label>
                <select id="pay-method" name="method" required defaultValue="" className={inputClass}>
                  <option value="" disabled>
                    Choose…
                  </option>
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="pay-ref" className="block text-sm">
                  Receipt or transfer number (optional)
                </label>
                <input id="pay-ref" name="reference" maxLength={200} className={inputClass} />
              </div>
              <div>
                <label htmlFor="pay-note" className="block text-sm">
                  Note (optional)
                </label>
                <input id="pay-note" name="note" maxLength={500} className={inputClass} />
              </div>
              <div>
                <button type="submit" className={buttonPrimary}>
                  Record payment
                </button>
              </div>
            </form>
          </details>
        )}
      </section>

      {folio && (
        <FolioSection
          reservationId={res.id}
          currency={res.currency}
          reservationStatus={res.reservation_status}
          arrival={res.arrival_date}
          today={today}
          timeZone={tz}
          balance={folio}
          charges={(folioChargesQ?.data ?? []) as ChargeRow[]}
          payments={(folioPaymentsQ?.data ?? []) as PaymentRow[]}
          rooms={folioRooms}
          viewer={{ charge: cFolio?.data === true, record: cPay.data === true, reverse: cReverse?.data === true }}
          invoices={(folioInvQ?.data ?? []) as FolioInvoiceRow[]}
          invoiceViewer={{ issue: cIssue.data === true, void: cVoid.data === true }}
          guestEmail={guest ? guest.email?.trim() || null : undefined}
          search={search}
        />
      )}

      {(invoices.length > 0 || inv.canIssue) && (
        <section className="mt-10" aria-labelledby="invoices">
          <SectionTitle id="invoices">Invoices</SectionTitle>
          {invoices.length > 0 && (
            <ul className="mt-2 border-t border-line">
              {invoices.map((i) => (
                <li key={i.id} className="border-b border-line py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <span>
                      <span className="font-medium">{i.invoice_number}</span>{" "}
                      <span className="text-sm text-muted">{i.invoice_status.replace("_", " ")}</span>
                    </span>
                    <span className="tabular-nums">{money(i.total_minor)}</span>
                  </div>
                  {inv.canVoid(i) && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-sm text-muted">Void this invoice</summary>
                      <form action={voidInvoice} className="mt-2 grid max-w-md gap-2">
                        <input type="hidden" name="reservationId" value={res.id} />
                        <input type="hidden" name="invoiceId" value={i.id} />
                        <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
                        <label htmlFor={`void-${i.id}`} className="block text-sm">
                          Why is it being voided?
                        </label>
                        <textarea id={`void-${i.id}`} name="reason" required maxLength={500} rows={2} className={inputClass} />
                        <p className="text-xs text-muted">
                          An invoice with payments recorded against it cannot be voided until the money has been refunded.
                        </p>
                        <div>
                          <button type="submit" className={buttonDanger}>
                            Void invoice
                          </button>
                        </div>
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
              <button type="submit" className={buttonQuiet}>
                Issue invoice
              </button>
              <p className="mt-1 text-xs text-muted">
                Copies the nights and tax into a numbered invoice. Payments already received are applied to it.
              </p>
            </form>
          )}
        </section>
      )}

      {noShowOffered && (
        <section className="mt-10" aria-labelledby="no-show">
          <SectionTitle id="no-show">Guest did not arrive</SectionTitle>
          <details className="mt-3">
            <summary className={`${buttonDanger} inline-block cursor-pointer list-none`}>Mark as no-show</summary>
            <form action={markNoShow} className="mt-3 grid max-w-md gap-3">
              <input type="hidden" name="reservationId" value={res.id} />
              <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
              <div>
                <label htmlFor="noshow-note" className="block text-sm">
                  Note (optional)
                </label>
                <textarea id="noshow-note" name="note" maxLength={NOTE_MAX} rows={2} className={inputClass} />
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="waive" className="mt-1" />
                <span>Waive the charge, so the guest is not charged for the missed stay</span>
              </label>
              <p className="text-xs text-muted">
                This is allowed once check-in time on the arrival day has passed. The rooms are released at once and the booking is settled
                like a cancellation: the charge in the booking&rsquo;s policy is invoiced, and any money held beyond it is queued for
                refund, which a second person must approve. This cannot be undone.
              </p>
              <div>
                <button type="submit" className={buttonDanger}>
                  Mark as no-show
                </button>
              </div>
            </form>
          </details>
        </section>
      )}

      {act.cancel && (
        <section className="mt-10" aria-labelledby="cancel">
          <SectionTitle id="cancel">Cancel this reservation</SectionTitle>
          <details className="mt-3">
            <summary className={`${buttonDanger} inline-block cursor-pointer list-none`}>Cancel reservation</summary>
            <form action={cancelReservation} className="mt-3 grid max-w-md gap-3">
              <input type="hidden" name="reservationId" value={res.id} />
              <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
              <div>
                <label htmlFor="cancel-reason" className="block text-sm">
                  Why is it being cancelled?
                </label>
                <textarea id="cancel-reason" name="reason" required maxLength={500} rows={2} className={inputClass} />
              </div>
              <p className="text-xs text-muted">
                The rooms are released at once. A cancellation charge may apply under the booking's policy, and any money held beyond it is
                queued for refund, which a second person must approve. This cannot be undone.
              </p>
              <div>
                <button type="submit" className={buttonDanger}>
                  Cancel reservation
                </button>
              </div>
            </form>
          </details>
        </section>
      )}
    </main>
  );
}
