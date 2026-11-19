import Link from "next/link";
import { notFound } from "next/navigation";
import { PosNotice } from "@/components/staff/pos-notice";
import {
  buttonDanger,
  buttonPrimary,
  buttonQuiet,
  cardClass,
  EmptyState,
  ErrorBanner,
  headRow,
  inputClass,
  linkClass,
  PageTitle,
  SectionTitle,
  tdNum,
  thNum,
  thRowHead,
} from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { formatMoney } from "@/lib/guest-site/format";
import {
  KITCHEN_LABEL,
  KITCHEN_NEXT,
  PAY_METHODS,
  PAY_METHOD_LABEL,
  menuByCategory,
  methodLabel,
  parseMenu,
  parseOrder,
} from "@/lib/staff/pos";
import { loadPosContext } from "@/lib/staff/pos-access";
import { createClient } from "@/lib/supabase/server";
import { addPosLine, payPosOrder, postPosOrderToRoom, setPosLineStatus, voidPosOrder } from "@/lib/staff/pos-actions";

export const dynamic = "force-dynamic";

const STATUS_TEXT = { open: "Open", paid: "Paid at the table", posted: "Put on a room bill", void: "Void" } as const;

export default async function PosOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const search = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const detailQ = await (await createClient()).rpc("pos_order_detail", { p_order: id });
  const order = detailQ.error ? null : parseOrder(detailQ.data);
  if (!order) {
    if (detailQ.error && !/NOT_FOUND/.test(detailQ.error.message))
      return (
        <main className="max-w-4xl">
          <PageTitle>Order</PageTitle>
          <ErrorBanner className="mt-4">The order could not be loaded. Reload the page.</ErrorBanner>
        </main>
      );
    notFound();
  }

  const { supabase, can } = await loadPosContext(order.propertyId);
  const money = (m: number) => formatMoney(m, order.currency);
  const open = order.status === "open";
  const liveLines = order.lines.filter((l) => l.kitchenStatus !== "cancelled");

  const [menuQ, stays] = await Promise.all([
    open && can.sell ? supabase.rpc("pos_menu", { p_property: order.propertyId }) : Promise.resolve({ data: null }),
    open && can.sell && can.folio
      ? supabase
          .from("reservations")
          .select("id, booking_reference, departure_date")
          .eq("property_id", order.propertyId)
          .eq("reservation_status", "checked_in")
          .order("booking_reference")
          .limit(200)
      : Promise.resolve({ data: null }),
  ]);
  const groups = menuByCategory(parseMenu(menuQ.data), true);
  const inHouse = (stays.data ?? []) as { id: string; booking_reference: string; departure_date: string }[];

  return (
    <main className="max-w-4xl">
      <p className="text-sm">
        <Link href="/app/pos" className={linkClass}>
          ← Restaurant &amp; bar
        </Link>
      </p>
      <PageTitle>
        {order.placeName}
        {order.guestLabel ? ` · ${order.guestLabel}` : ""}
      </PageTitle>
      <p className="text-sm text-muted">
        {order.orderNo} · {STATUS_TEXT[order.status]}
        {order.status === "paid" && order.paymentMethod ? ` (${methodLabel(order.paymentMethod)})` : ""}
        {order.voidReason ? ` · ${order.voidReason}` : ""}
      </p>
      <div className="mt-5">
        <PosNotice search={search} />
      </div>

      <section aria-label="Lines">
        <SectionTitle>Items</SectionTitle>
        {order.lines.length === 0 ? (
          <EmptyState className="mt-3">Nothing on this order yet.</EmptyState>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className={headRow}>
                  <th scope="col" className={thRowHead}>
                    Item
                  </th>
                  <th scope="col" className={thNum}>
                    Price
                  </th>
                  <th scope="col" className={thNum}>
                    Amount
                  </th>
                  <th scope="col" className={thRowHead}>
                    Kitchen
                  </th>
                </tr>
              </thead>
              <tbody>
                {order.lines.map((l) => {
                  const next = KITCHEN_NEXT[l.kitchenStatus];
                  const cancellable = open && (l.kitchenStatus === "new" || l.kitchenStatus === "preparing");
                  const cancelled = l.kitchenStatus === "cancelled";
                  return (
                    <tr key={l.id} className={`border-b border-line ${cancelled ? "text-muted line-through" : ""}`}>
                      <th scope="row" className="py-2 pr-3 text-left font-normal">
                        {l.quantity} × {l.name}
                        {l.note && <span className="block text-xs text-muted no-underline">{l.note}</span>}
                      </th>
                      <td className={tdNum}>{money(l.unitPriceMinor)}</td>
                      <td className={tdNum}>{money(l.unitPriceMinor * l.quantity)}</td>
                      <td className="py-2">
                        <span className="mr-2">{KITCHEN_LABEL[l.kitchenStatus]}</span>
                        {can.sell && order.status !== "void" && next && (
                          <form action={setPosLineStatus} className="mr-1 inline">
                            <input type="hidden" name="orderId" value={order.id} />
                            <input type="hidden" name="lineId" value={l.id} />
                            <input type="hidden" name="status" value={next.to} />
                            <button type="submit" className={buttonQuiet}>
                              {next.button}
                            </button>
                          </form>
                        )}
                        {can.sell && cancellable && (
                          <form action={setPosLineStatus} className="inline">
                            <input type="hidden" name="orderId" value={order.id} />
                            <input type="hidden" name="lineId" value={l.id} />
                            <input type="hidden" name="status" value="cancelled" />
                            <button type="submit" className={buttonDanger}>
                              Cancel
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={2} className="py-2 pr-3 text-right font-normal">
                    Subtotal
                  </th>
                  <td className={tdNum}>{money(order.subtotalMinor)}</td>
                  <td />
                </tr>
                <tr>
                  <th scope="row" colSpan={2} className="py-1 pr-3 text-right font-normal">
                    Tax{order.estimate ? " (estimate)" : ""}
                  </th>
                  <td className={tdNum}>{money(order.taxMinor)}</td>
                  <td />
                </tr>
                <tr className="font-semibold">
                  <th scope="row" colSpan={2} className="py-2 pr-3 text-right">
                    Total{order.estimate ? " (estimate)" : ""}
                  </th>
                  <td className={tdNum}>{money(order.totalMinor)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {order.estimate && (
          <p className="mt-2 text-xs text-muted">
            The tax is worked out from your tax rules when the bill is settled and is kept as it was then.
          </p>
        )}
      </section>

      {open && can.sell && (
        <section className="mt-8" aria-label="Add items">
          <SectionTitle>Add items</SectionTitle>
          {groups.length === 0 ? (
            <EmptyState className="mt-3">There are no items on the menu yet.</EmptyState>
          ) : (
            groups.map((g) => (
              <div key={g.category.id} className="mt-4">
                <h3 className="font-display text-lg">{g.category.name}</h3>
                <ul className="mt-2 grid gap-2">
                  {g.items.map((i) => (
                    <li key={i.id} className={cardClass}>
                      <form action={addPosLine} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="orderId" value={order.id} />
                        <input type="hidden" name="itemId" value={i.id} />
                        <input type="hidden" name="key" value={crypto.randomUUID()} />
                        <span className="min-w-40 flex-1">
                          <span className="block font-medium">{i.name}</span>
                          <span className="text-sm text-muted tabular-nums">{money(i.priceMinor)}</span>
                        </span>
                        <label className="block text-xs" htmlFor={`q-${i.id}`}>
                          Qty
                          <input
                            id={`q-${i.id}`}
                            name="quantity"
                            type="number"
                            min={1}
                            max={100}
                            defaultValue={1}
                            className={`${inputClass} mt-1 w-20`}
                          />
                        </label>
                        <label className="block text-xs" htmlFor={`n-${i.id}`}>
                          Note
                          <input id={`n-${i.id}`} name="note" maxLength={100} className={`${inputClass} mt-1 w-44`} />
                        </label>
                        <PendingButton className={buttonPrimary} pendingLabel="Adding…">
                          Add
                        </PendingButton>
                      </form>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
      )}

      {open && can.sell && liveLines.length > 0 && (
        <section className="mt-8 grid gap-6 md:grid-cols-2" aria-label="Settle the bill">
          <div className={cardClass}>
            <h3 className="font-display text-lg">Paid at the table</h3>
            <form action={payPosOrder} className="mt-3 grid gap-3">
              <input type="hidden" name="orderId" value={order.id} />
              <input type="hidden" name="key" value={crypto.randomUUID()} />
              <label className="block text-sm" htmlFor="method">
                How paid
                <select id="method" name="method" className={`${inputClass} mt-1`}>
                  {PAY_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {PAY_METHOD_LABEL[m]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm" htmlFor="reference">
                Slip or reference (optional)
                <input id="reference" name="reference" maxLength={100} className={`${inputClass} mt-1`} />
              </label>
              <PendingButton className={buttonPrimary} pendingLabel="Taking payment…">
                Take payment of {money(order.totalMinor)}
              </PendingButton>
            </form>
            <p className="mt-2 text-xs text-muted">Table payments are in the restaurant sales report, not in the daily report.</p>
          </div>

          <div className={cardClass}>
            <h3 className="font-display text-lg">Put on a room bill</h3>
            {!can.folio ? (
              <p className="mt-3 text-sm text-muted">
                Putting a bill on a room needs the permission to post charges to a guest&rsquo;s bill. Ask the front desk.
              </p>
            ) : inHouse.length === 0 ? (
              <p className="mt-3 text-sm text-muted">No guests are checked in right now.</p>
            ) : (
              <form action={postPosOrderToRoom} className="mt-3 grid gap-3">
                <input type="hidden" name="orderId" value={order.id} />
                <input type="hidden" name="key" value={crypto.randomUUID()} />
                <label className="block text-sm" htmlFor="reservation">
                  Checked-in booking
                  <select id="reservation" name="reservationId" required className={`${inputClass} mt-1`}>
                    {inHouse.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.booking_reference} (leaves {r.departure_date})
                      </option>
                    ))}
                  </select>
                </label>
                <PendingButton className={buttonPrimary} pendingLabel="Posting…">
                  Post {money(order.totalMinor)} to the room
                </PendingButton>
              </form>
            )}
            <p className="mt-2 text-xs text-muted">
              It becomes one extra on the guest&rsquo;s bill, with the tax your rules set for extras.
            </p>
          </div>
        </section>
      )}

      {open && can.sell && (
        <section className="mt-8" aria-label="Void the order">
          <form action={voidPosOrder} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="orderId" value={order.id} />
            <label className="block text-sm" htmlFor="reason">
              Reason for voiding
              <input id="reason" name="reason" required maxLength={200} className={`${inputClass} mt-1 w-72`} />
            </label>
            <PendingButton className={buttonDanger} pendingLabel="Voiding…">
              Void order
            </PendingButton>
          </form>
          <p className="mt-2 text-xs text-muted">Once food has been started, only a manager can void an order.</p>
        </section>
      )}

      {order.status === "posted" && order.reservationId && (
        <p className="mt-6 text-sm">
          Posted to a guest&rsquo;s room bill:{" "}
          <Link href={`/app/reservations/${order.reservationId}`} className={linkClass}>
            open the booking
          </Link>
          . To correct it, void the charge on that bill.
        </p>
      )}
    </main>
  );
}
