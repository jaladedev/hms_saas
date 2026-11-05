import Link from "next/link";
import { buttonDanger, buttonPrimary, inputClass, linkClass, Notice, SectionTitle } from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import {
  CATEGORY_LABEL, FOLIO_CATEGORIES, FOLIO_LIMITS, folioActions, folioIsOpen, isFolioResult, owingNotice, prefillPayment, splitCharges, splitPayments,
  type ChargeRow, type FolioBalance, type FolioViewer, type PaymentRow,
} from "@/lib/staff/folio";
import { issueFolioInvoice, postFolioCharge, recordFolioPayment, reverseFolioPayment, voidFolioCharge, voidFolioInvoice } from "@/lib/staff/folio-actions";
import { folioInvoicePath, invoiceActions, invoiceNumberOf, splitInvoices, type FolioInvoiceRow, type InvoiceViewer } from "@/lib/staff/folio-invoice";
import { formatDateTime } from "@/lib/staff/format";
import { PAYMENT_METHODS } from "@/lib/staff/reservations";

type Search = Record<string, string | string[] | undefined>;

const METHOD_LABEL: Record<string, string> = Object.fromEntries(PAYMENT_METHODS.map((m) => [m.value, m.label]));

/**
 * The Folio section of the reservation page: the extras charged during the stay, the money taken for them and what is
 * still owed. A statement kept beside the booking's own money, not part of it. Shows only what the viewer may do; the
 * database decides again on every action.
 */
export function FolioSection({
  reservationId, currency, reservationStatus, arrival, today, timeZone, balance, charges, payments, rooms, viewer, invoices, invoiceViewer, search,
}: {
  reservationId: string;
  currency: string;
  reservationStatus: string;
  arrival: string;
  /** Today's date in the hotel's own time zone: the latest day a charge can carry. */
  today: string;
  timeZone: string;
  balance: FolioBalance;
  charges: ChargeRow[];
  payments: PaymentRow[];
  /** The rooms of the booking, offered on the form only when there is more than one. */
  rooms: { id: string; label: string }[];
  viewer: FolioViewer;
  /** Numbered invoices for the extras (migration 048), and what the viewer may do with them. */
  invoices: FolioInvoiceRow[];
  invoiceViewer: InvoiceViewer;
  search: Search;
}) {
  const money = (m: number) => formatMoney(m, currency);
  const act = folioActions(reservationStatus, balance, viewer);
  const { posted, voided } = splitCharges(charges);
  const { received, reversed } = splitPayments(payments);
  const owing = Math.max(balance.balance_minor, 0);
  const warning = owingNotice(reservationStatus, owing, money);
  const roomLabel = new Map(rooms.map((r) => [r.id, r.label]));
  const inv = invoiceActions(folioIsOpen(reservationStatus), charges, invoiceViewer);
  const { live: liveInvoices, voided: voidedInvoices } = splitInvoices(invoices);

  return (
    <section className="mt-10 scroll-mt-6" id="folio" aria-labelledby="folio-title">
      <SectionTitle id="folio-title">Folio</SectionTitle>
      <p className="mt-1 max-w-xl text-sm text-muted">
        Extras charged during the stay, such as the minibar or laundry, and the money taken for them. They are kept apart from the
        booking&rsquo;s price and payments above and are not on its invoice.
      </p>

      <div className="mt-4">{isFolioResult(search) && <Notice search={search} currency={currency} />}</div>
      {warning && <p className="mb-4 border-l-4 border-pending bg-pending/5 px-4 py-3 text-sm">{warning}</p>}

      {posted.length === 0 ? (
        <p className="text-muted">No extras have been charged.</p>
      ) : (
        <ul className="border-t border-line">
          {posted.map((c) => (
            <li key={c.id} className="border-b border-line py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                <span>
                  <span className="font-medium">{CATEGORY_LABEL[c.category] ?? c.category}</span>
                  <span className="ml-2 text-sm">{c.description}</span>
                </span>
                <span className="tabular-nums">{money(c.total_minor)}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {formatDate(c.charge_date)}, {c.quantity} &times; {money(c.unit_amount_minor)}
                {c.tax_minor > 0 ? `, ${money(c.tax_minor)} tax included` : ""}
                {c.reservation_room_id && roomLabel.get(c.reservation_room_id) ? `, ${roomLabel.get(c.reservation_room_id)}` : ""}
                {invoiceNumberOf(c.folio_invoice_id, invoices) ? `, on ${invoiceNumberOf(c.folio_invoice_id, invoices)}` : ""}
              </p>
              {c.folio_invoice_id && viewer.charge && (
                <p className="mt-2 text-xs text-muted">This charge is on an invoice. Void the invoice first if it has to change.</p>
              )}
              {act.voidCharge(c) && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm text-muted">Void this charge</summary>
                  <form action={voidFolioCharge} className="mt-2 grid max-w-md gap-2">
                    <input type="hidden" name="reservationId" value={reservationId} />
                    <input type="hidden" name="chargeId" value={c.id} />
                    <label htmlFor={`void-${c.id}`} className="block text-sm">Why is it being voided?</label>
                    <textarea id={`void-${c.id}`} name="reason" required maxLength={FOLIO_LIMITS.reasonMax} rows={2} className={inputClass} />
                    <p className="text-xs text-muted">A charge cannot be edited. Void it, then add it again with the right details.</p>
                    <div><button type="submit" className={buttonDanger}>Void charge</button></div>
                  </form>
                </details>
              )}
              {act.voidBlockedByPayment(c) && (
                <p className="mt-2 text-xs text-muted">This charge cannot be voided while the money collected is more than the charges left. Reverse a payment first.</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {voided.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-muted">Voided charges ({voided.length})</summary>
          <ul className="mt-2 border-t border-line">
            {voided.map((c) => (
              <li key={c.id} className="border-b border-line py-2 text-sm text-muted">
                <span className="line-through">{CATEGORY_LABEL[c.category] ?? c.category}, {c.description}, {money(c.total_minor)}</span>
                <span className="block text-xs">Voided {formatDateTime(c.voided_at, timeZone)}{c.void_reason ? `: ${c.void_reason}` : ""}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {(posted.length > 0 || received.length > 0) && (
        <dl className="mt-5 max-w-md text-sm">
          {balance.tax_minor > 0 && (
            <>
              <div className="flex items-baseline justify-between gap-6 py-1.5">
                <dt className="text-muted">Extras before tax</dt><dd className="tabular-nums">{money(balance.charges_minor - balance.tax_minor)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-6 py-1.5">
                <dt className="text-muted">Tax</dt><dd className="tabular-nums">{money(balance.tax_minor)}</dd>
              </div>
            </>
          )}
          <div className="flex items-baseline justify-between gap-6 border-t-2 border-ink py-2 font-semibold">
            <dt>Extras total</dt><dd className="tabular-nums">{money(balance.charges_minor)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-6 py-1.5">
            <dt className="text-muted">Paid so far</dt><dd className="tabular-nums">{money(balance.paid_minor)}</dd>
          </div>
          <div className={`flex items-baseline justify-between gap-6 py-1.5 font-semibold ${owing > 0 ? "text-pending" : ""}`}>
            <dt>Still owed for extras</dt><dd className="tabular-nums">{money(owing)}</dd>
          </div>
        </dl>
      )}

      {(liveInvoices.length > 0 || voidedInvoices.length > 0 || inv.issue) && (
        <div className="mt-5" id="folio-invoices">
          <h3 className="text-sm font-medium">Invoices for extras</h3>
          {liveInvoices.length === 0 ? (
            <p className="mt-1 text-sm text-muted">No invoice has been issued for the extras.</p>
          ) : (
            <ul className="mt-2 border-t border-line">
              {liveInvoices.map((i) => (
                <li key={i.id} className="border-b border-line py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <span>
                      <span className="font-medium">{i.invoice_number}</span>
                      <span className="ml-2 text-xs text-muted">{formatDateTime(i.issued_at, timeZone)}</span>
                    </span>
                    <span className="tabular-nums">{money(i.total_minor)}</span>
                  </div>
                  <p className="mt-0.5 text-sm"><Link href={folioInvoicePath(reservationId, i.id)} className={linkClass}>View or print</Link></p>
                  {inv.void(i) && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-sm text-muted">Void this invoice</summary>
                      <form action={voidFolioInvoice} className="mt-2 grid max-w-md gap-2">
                        <input type="hidden" name="reservationId" value={reservationId} />
                        <input type="hidden" name="invoiceId" value={i.id} />
                        <label htmlFor={`void-inv-${i.id}`} className="block text-sm">Why is it being voided?</label>
                        <textarea id={`void-inv-${i.id}`} name="reason" required maxLength={FOLIO_LIMITS.reasonMax} rows={2} className={inputClass} />
                        <p className="text-xs text-muted">An invoice cannot be edited. Void it, and its extras can be invoiced again. No money moves: payments for extras stay on the folio.</p>
                        <div><button type="submit" className={buttonDanger}>Void invoice</button></div>
                      </form>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
          {inv.issue && (
            <form action={issueFolioInvoice} className="mt-3 grid max-w-md gap-2">
              <input type="hidden" name="reservationId" value={reservationId} />
              <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
              <p className="text-xs text-muted">
                Numbers {inv.uninvoicedCount === 1 ? "the extra" : `all ${inv.uninvoicedCount} extras`} not yet on an invoice, {money(inv.uninvoicedTotalMinor)} in all, as one invoice. It cannot be edited afterwards.
              </p>
              <div><button type="submit" className={buttonPrimary}>Issue invoice for extras</button></div>
            </form>
          )}
          {voidedInvoices.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-muted">Voided invoices ({voidedInvoices.length})</summary>
              <ul className="mt-2 border-t border-line">
                {voidedInvoices.map((i) => (
                  <li key={i.id} className="border-b border-line py-2 text-sm text-muted">
                    <span className="line-through">{i.invoice_number}, {money(i.total_minor)}</span>
                    <span className="block text-xs">Voided {formatDateTime(i.voided_at, timeZone)}{i.void_reason ? `: ${i.void_reason}` : ""}. <Link href={folioInvoicePath(reservationId, i.id)} className={linkClass}>View</Link></span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {received.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-medium">Money taken for extras</h3>
          <ul className="mt-2 border-t border-line">
            {received.map((p) => (
              <li key={p.id} className="border-b border-line py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                  <span>
                    <span className="font-medium">{METHOD_LABEL[p.payment_method] ?? p.payment_method}</span>
                    <span className="ml-2 text-xs text-muted">{p.internal_reference}{p.provider_reference ? `, receipt ${p.provider_reference}` : ""}</span>
                  </span>
                  <span className="tabular-nums">{money(p.amount_minor)}</span>
                </div>
                <p className="mt-0.5 text-xs text-muted">{formatDateTime(p.received_at, timeZone)}{p.note ? `, ${p.note}` : ""}</p>
                {act.reversePayment(p) && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm text-muted">Reverse this payment</summary>
                    <form action={reverseFolioPayment} className="mt-2 grid max-w-md gap-2">
                      <input type="hidden" name="reservationId" value={reservationId} />
                      <input type="hidden" name="paymentId" value={p.id} />
                      <label htmlFor={`rev-${p.id}`} className="block text-sm">Why is it being reversed?</label>
                      <textarea id={`rev-${p.id}`} name="reason" required maxLength={FOLIO_LIMITS.reasonMax} rows={2} className={inputClass} />
                      <p className="text-xs text-muted">
                        Use this when a payment was recorded by mistake. The amount becomes owed again. It does not pay anything back to the guest.
                      </p>
                      <div><button type="submit" className={buttonDanger}>Reverse payment</button></div>
                    </form>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {reversed.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-muted">Reversed payments ({reversed.length})</summary>
          <ul className="mt-2 border-t border-line">
            {reversed.map((p) => (
              <li key={p.id} className="border-b border-line py-2 text-sm text-muted">
                <span className="line-through">{METHOD_LABEL[p.payment_method] ?? p.payment_method}, {p.internal_reference}, {money(p.amount_minor)}</span>
                <span className="block text-xs">Reversed {formatDateTime(p.reversed_at, timeZone)}{p.reverse_reason ? `: ${p.reverse_reason}` : ""}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {act.post && (
        <details className="mt-6" open={posted.length === 0}>
          <summary className="cursor-pointer text-sm font-medium text-primary-strong">Add a charge</summary>
          <form action={postFolioCharge} className="mt-3 grid max-w-md gap-3">
            <input type="hidden" name="reservationId" value={reservationId} />
            <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
            <div>
              <label htmlFor="folio-category" className="block text-sm">What was it for?</label>
              <select id="folio-category" name="category" required defaultValue="" className={inputClass}>
                <option value="" disabled>Choose&hellip;</option>
                {FOLIO_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="folio-description" className="block text-sm">Details</label>
              <input id="folio-description" name="description" required maxLength={FOLIO_LIMITS.descriptionMax} placeholder="For example: 2 bottles of water" className={inputClass} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="folio-quantity" className="block text-sm">How many?</label>
                <input id="folio-quantity" name="quantity" type="number" inputMode="numeric" min={1} max={FOLIO_LIMITS.quantityMax} step={1} defaultValue={1} required className={`${inputClass} tabular-nums`} />
              </div>
              <div>
                <label htmlFor="folio-amount" className="block text-sm">Price each ({currency})</label>
                <input id="folio-amount" name="amount" inputMode="decimal" required className={`${inputClass} tabular-nums`} />
              </div>
            </div>
            <div>
              <label htmlFor="folio-date" className="block text-sm">Date</label>
              <input id="folio-date" name="date" type="date" required min={arrival} max={today} defaultValue={today} className={inputClass} />
              <p className="mt-1 text-xs text-muted">Any day from arrival up to today.</p>
            </div>
            {rooms.length > 1 && (
              <div>
                <label htmlFor="folio-room" className="block text-sm">Which room? (optional)</label>
                <select id="folio-room" name="reservationRoomId" defaultValue="" className={inputClass}>
                  <option value="">The whole booking</option>
                  {rooms.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              </div>
            )}
            <p className="text-xs text-muted">Tax, if the hotel charges it on extras, is added when you save. A charge cannot be edited afterwards, only voided.</p>
            <div><button type="submit" className={buttonPrimary}>Add charge</button></div>
          </form>
        </details>
      )}

      {act.recordPayment && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium text-primary-strong">Record money taken for extras</summary>
          <form action={recordFolioPayment} className="mt-3 grid max-w-md gap-3">
            <input type="hidden" name="reservationId" value={reservationId} />
            <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
            <div>
              <label htmlFor="folio-pay-amount" className="block text-sm">Amount ({currency})</label>
              <input id="folio-pay-amount" name="amount" inputMode="decimal" required defaultValue={prefillPayment(act.payableCeilingMinor)} className={`${inputClass} tabular-nums`} />
              <p className="mt-1 text-xs text-muted">Up to {money(act.payableCeilingMinor)}, which is what is still owed for extras.</p>
            </div>
            <div>
              <label htmlFor="folio-pay-method" className="block text-sm">Received by</label>
              <select id="folio-pay-method" name="method" required defaultValue="" className={inputClass}>
                <option value="" disabled>Choose&hellip;</option>
                {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="folio-pay-ref" className="block text-sm">Receipt or transfer number (optional)</label>
              <input id="folio-pay-ref" name="reference" maxLength={FOLIO_LIMITS.referenceMax} className={inputClass} />
            </div>
            <div>
              <label htmlFor="folio-pay-note" className="block text-sm">Note (optional)</label>
              <input id="folio-pay-note" name="note" maxLength={FOLIO_LIMITS.noteMax} className={inputClass} />
            </div>
            <div><button type="submit" className={buttonPrimary}>Record payment</button></div>
          </form>
        </details>
      )}

      {!viewer.charge && <p className="mt-4 text-xs text-muted">You can see this folio but not add or void charges.</p>}
    </section>
  );
}
