import Link from "next/link";
import { notFound } from "next/navigation";
import { EventForm } from "@/components/staff/event-form";
import { buttonDanger, buttonPrimary, buttonQuiet, cardClass, ErrorBanner, inputClass, linkClass, Notice, PageTitle, SectionTitle } from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { formatMoney } from "@/lib/guest-site/format";
import {
  cancelTicketOrder,
  checkInTicket,
  deleteEvent,
  deleteTicketType,
  recordEventRefund,
  saveTicketType,
  sellTickets,
  setEventStatus,
} from "@/lib/staff/event-actions";
import { ATTENTION_LABEL, EVENT_STATUS_LABEL, formatLocal, isUuid, PAYMENT_METHODS } from "@/lib/staff/events";
import { netPaid } from "@/lib/staff/event-page-helpers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
type TType = { id: string; name: string; price_minor: number; quantity_total: number; is_active: boolean; sort_order: number };
type Order = { id: string; reference: string; status: string; source: string; buyer_name: string; buyer_email: string | null; buyer_phone: string | null; total_minor: number; attention_reason: string | null; created_at: string };
type Ticket = { id: string; order_id: string; ticket_type_id: string; code: string; status: string };

const DOOR_MESSAGE: Record<string, string> = {
  unknown: "That code is not a ticket for this hotel.",
  used: "Already used. This ticket was checked in before.",
  void: "This ticket is void (its order was cancelled).",
  wrong_event: "This ticket is for a different event.",
  forbidden: "You cannot check tickets in for this hotel.",
  other: "The ticket could not be checked in. Try again.",
};

export default async function TicketEventPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const { id } = await params;
  const search = await searchParams;
  if (!isUuid(id)) notFound();
  const supabase = await createClient();
  const { data: ev } = await supabase.from("hotel_events").select("*").eq("id", id).maybeSingle();
  if (!ev) notFound();
  const pid = ev.property_id;
  const [propQ, typeQ, orderQ, tixQ, venueQ, manageQ, refundQ] = await Promise.all([
    supabase.from("properties").select("currency").eq("id", pid).maybeSingle(),
    supabase.from("event_ticket_types").select("*").eq("event_id", id).order("sort_order"),
    supabase.from("ticket_orders").select("*").eq("event_id", id).order("created_at", { ascending: false }).limit(200),
    supabase.from("tickets").select("id, order_id, ticket_type_id, code, status").eq("event_id", id),
    supabase.from("hotel_venues").select("id, name").eq("property_id", pid).eq("is_active", true).order("sort_order"),
    supabase.rpc("has_permission", { p_property: pid, p_permission: "event.manage" }),
    supabase.rpc("has_permission", { p_property: pid, p_permission: "refund.approve" }),
  ]);
  const currency = (propQ.data as { currency: string } | null)?.currency ?? "NGN";
  const money = (n: number) => formatMoney(n, currency);
  const mayManage = manageQ.data === true;
  const mayRefund = refundQ.data === true;
  const types = (typeQ.data ?? []) as TType[];
  const orders = (orderQ.data ?? []) as Order[];
  const tickets = (tixQ.data ?? []) as Ticket[];
  const typeName = new Map(types.map((t) => [t.id, t.name]));
  const ids = orders.map((o) => o.id);
  const payQ = ids.length ? await supabase.from("event_payments").select("ticket_order_id, payment_kind, amount_minor").in("ticket_order_id", ids) : { data: [] };
  const paidBy = new Map<string, number>();
  for (const p of (payQ.data ?? []) as { ticket_order_id: string; payment_kind: string; amount_minor: number }[]) {
    paidBy.set(p.ticket_order_id, netPaid([p]) + (paidBy.get(p.ticket_order_id) ?? 0));
  }
  const soldBy = new Map<string, number>();
  for (const t of tickets) if (t.status !== "void") soldBy.set(t.ticket_type_id, (soldBy.get(t.ticket_type_id) ?? 0) + 1);
  const used = tickets.filter((t) => t.status === "used").length;
  const sold = tickets.filter((t) => t.status !== "void").length;
  const venues = (venueQ.data ?? []) as { id: string; name: string }[];
  const here = `/app/events/tickets/${id}`;
  const door = one(search.door);
  const soldRef = one(search.sold);
  const soldOrder = soldRef ? orders.find((o) => o.reference === soldRef) : undefined;

  return (
    <main className="max-w-4xl">
      <p className="text-sm"><Link href={`/app/events/tickets?property=${pid}`} className={linkClass}>All ticketed events</Link></p>
      <PageTitle className="mt-2">{ev.title}</PageTitle>
      <p className="text-sm">{EVENT_STATUS_LABEL[ev.status] ?? ev.status} · {formatLocal(ev.starts_at)} to {formatLocal(ev.ends_at)} · {sold} sold, {used} checked in</p>
      <div className="mt-3"><Notice search={search} currency={currency} /></div>
      {soldOrder && (
        <p role="status" className="mb-4 border-l-4 border-primary bg-primary/5 px-4 py-3 text-sm">
          Order {soldOrder.reference}: {tickets.filter((t) => t.order_id === soldOrder.id).map((t) => t.code).join(", ")}
        </p>
      )}

      <SectionTitle>Door check-in</SectionTitle>
      {door === "ok" && (
        <p role="status" className="mt-2 border-l-4 border-primary bg-primary/5 px-4 py-3 text-sm">
          Welcome, {one(search.buyer)} · {one(search.type)} · {one(search.inn)} of {one(search.of)} from this order are in.
        </p>
      )}
      {door && door !== "ok" && <ErrorBanner className="mt-2">{DOOR_MESSAGE[door] ?? DOOR_MESSAGE.other}</ErrorBanner>}
      <form action={checkInTicket} className="mt-2 flex items-center gap-2">
        <input type="hidden" name="propertyId" value={pid} />
        <input type="hidden" name="eventId" value={id} />
        <input name="code" required autoComplete="off" autoCapitalize="characters" placeholder="Ticket code" aria-label="Ticket code" className={inputClass} />
        <PendingButton className={buttonPrimary} pendingLabel="Checking…">Check in</PendingButton>
      </form>

      {mayManage && (
        <>
          <SectionTitle>Status</SectionTitle>
          <div className="mt-2 flex flex-wrap gap-2">
            {(["draft", "on_sale", "closed", "cancelled"] as const).filter((s) => s !== ev.status).map((s) => (
              <form key={s} action={setEventStatus}>
                <input type="hidden" name="eventId" value={id} />
                <input type="hidden" name="status" value={s} />
                <PendingButton className={s === "cancelled" ? buttonDanger : buttonQuiet} pendingLabel="Saving…">
                  {s === "on_sale" ? "Put on sale" : s === "closed" ? "Close sales" : s === "draft" ? "Back to draft" : "Cancel the event"}
                </PendingButton>
              </form>
            ))}
          </div>
          {ev.status === "cancelled" && <p className="mt-2 text-sm text-muted">Orders that were paid need a refund. Cancel each order below and record the refund.</p>}
        </>
      )}

      <SectionTitle>Ticket types</SectionTitle>
      <ul className="mt-2 space-y-3">
        {types.map((t) => (
          <li key={t.id} className={cardClass}>
            <p className="text-sm text-muted">{soldBy.get(t.id) ?? 0} sold of {t.quantity_total} · {money(t.price_minor)}</p>
            {mayManage && <TypeForm eventId={id} item={t} />}
            {mayManage && (
              <form action={deleteTicketType} className="mt-2">
                <input type="hidden" name="eventId" value={id} />
                <input type="hidden" name="typeId" value={t.id} />
                <PendingButton className={buttonQuiet} pendingLabel="Removing…">Remove type</PendingButton>
              </form>
            )}
          </li>
        ))}
      </ul>
      {mayManage && (
        <div className="mt-3 rounded border border-dashed border-line bg-white p-3">
          <h3 className="text-sm font-medium">Add a ticket type</h3>
          <TypeForm eventId={id} item={null} />
        </div>
      )}

      {mayManage && types.some((t) => t.is_active) && ev.status !== "cancelled" && (
        <>
          <SectionTitle>Sell at the desk</SectionTitle>
          <form action={sellTickets} className="mt-2 grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="propertyId" value={pid} />
            <input type="hidden" name="eventId" value={id} />
            <input type="hidden" name="key" value={crypto.randomUUID()} />
            {types.filter((t) => t.is_active).map((t) => (
              <label key={t.id} className="block text-sm">{t.name} ({money(t.price_minor)})
                <input name={`qty_${t.id}`} inputMode="numeric" defaultValue="0" className={`${inputClass} mt-1`} />
              </label>
            ))}
            <label className="block text-sm">Buyer name<input name="name" required maxLength={80} className={`${inputClass} mt-1`} /></label>
            <label className="block text-sm">Email<input name="email" type="email" className={`${inputClass} mt-1`} /></label>
            <label className="block text-sm">Phone<input name="phone" className={`${inputClass} mt-1`} /></label>
            <label className="block text-sm">Paid by
              <select name="method" className={`${inputClass} mt-1`}>{PAYMENT_METHODS.map((m) => (<option key={m[0]} value={m[0]}>{m[1]}</option>))}</select>
            </label>
            <label className="block text-sm sm:col-span-2">Reference (optional)<input name="reference" maxLength={80} className={`${inputClass} mt-1`} /></label>
            <div className="sm:col-span-2"><PendingButton className={buttonPrimary} pendingLabel="Selling…">Take payment and issue tickets</PendingButton></div>
          </form>
        </>
      )}

      <SectionTitle>Orders</SectionTitle>
      {orders.length === 0 ? <p className="mt-2 text-sm text-muted">No orders yet.</p> : (
        <ul className="mt-2 space-y-3">
          {orders.map((o) => {
            const mine = tickets.filter((t) => t.order_id === o.id);
            const paid = paidBy.get(o.id) ?? 0;
            const note = o.attention_reason ? (ATTENTION_LABEL[o.attention_reason] ?? o.attention_reason) : null;
            return (
              <li key={o.id} className={cardClass}>
                <p className="text-sm"><strong>{o.reference}</strong> · {o.buyer_name} · {o.status} · {money(o.total_minor)} · received {money(paid)}</p>
                <p className="text-xs text-muted">{o.buyer_email ?? o.buyer_phone ?? ""} · {formatLocal(o.created_at)} · {o.source}</p>
                {note && <ErrorBanner className="mt-2">{note}</ErrorBanner>}
                {mine.length > 0 && <p className="mt-1 text-xs">{mine.map((t) => `${t.code} (${typeName.get(t.ticket_type_id) ?? "ticket"}${t.status !== "valid" ? `, ${t.status}` : ""})`).join(" · ")}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {mayManage && (o.status === "paid" || o.status === "pending") && (
                    <form action={cancelTicketOrder} className="flex items-center gap-2">
                      <input type="hidden" name="orderId" value={o.id} />
                      <input type="hidden" name="eventId" value={id} />
                      <input name="reason" required maxLength={200} placeholder="Reason" aria-label="Reason" className={inputClass} />
                      <PendingButton className={buttonDanger} pendingLabel="Cancelling…">Cancel order</PendingButton>
                    </form>
                  )}
                  {mayRefund && paid > 0 && (
                    <form action={recordEventRefund} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="orderId" value={o.id} />
                      <input type="hidden" name="returnTo" value={here} />
                      <input type="hidden" name="key" value={crypto.randomUUID()} />
                      <input name="amount" required inputMode="decimal" defaultValue={String(paid / 100)} aria-label="Refund in naira" className={inputClass} />
                      <select name="method" aria-label="Method" className={inputClass}>{PAYMENT_METHODS.map((m) => (<option key={m[0]} value={m[0]}>{m[1]}</option>))}</select>
                      <input name="reference" maxLength={80} placeholder="Reference" aria-label="Reference" className={inputClass} />
                      <PendingButton className={buttonQuiet} pendingLabel="Saving…">Record refund</PendingButton>
                    </form>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {mayManage && (
        <>
          <SectionTitle>Event details</SectionTitle>
          <EventForm propertyId={pid} venues={venues} item={ev} />
          {orders.length === 0 && (
            <form action={deleteEvent} className="mt-4">
              <input type="hidden" name="eventId" value={id} />
              <PendingButton className={buttonDanger} pendingLabel="Deleting…">Delete event</PendingButton>
            </form>
          )}
        </>
      )}
    </main>
  );
}

function TypeForm({ eventId, item }: { eventId: string; item: TType | null }) {
  return (
    <form action={saveTicketType} className="mt-2 grid gap-2 sm:grid-cols-5">
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="typeId" value={item?.id ?? ""} />
      <input name="name" required maxLength={40} defaultValue={item?.name ?? ""} placeholder="Name" aria-label="Name" className={inputClass} />
      <input name="price" inputMode="decimal" defaultValue={item ? String(item.price_minor / 100) : ""} placeholder="Price (naira)" aria-label="Price in naira" className={inputClass} />
      <input name="quantity" required inputMode="numeric" defaultValue={item ? String(item.quantity_total) : ""} placeholder="On sale" aria-label="Number on sale" className={inputClass} />
      <label className="flex items-center gap-1 text-sm"><input type="checkbox" name="active" defaultChecked={item ? item.is_active : true} className="accent-primary" />On sale</label>
      <PendingButton className={buttonQuiet} pendingLabel="Saving…">{item ? "Save" : "Add"}</PendingButton>
    </form>
  );
}
