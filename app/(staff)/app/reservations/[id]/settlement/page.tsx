import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { buttonPrimary, inputClass, Notice, StatusChip } from "@/components/staff/ui";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { formatDateTime } from "@/lib/staff/format";
import { minorToInput } from "@/lib/staff/money-input";
import { requestRefund } from "@/lib/staff/refund-actions";
import { refundableMinor, type RefundRow } from "@/lib/staff/refunds";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Reservation = {
  id: string; property_id: string; booking_reference: string; reservation_status: string; payment_status: string;
  arrival_date: string; departure_date: string; currency: string; total_minor: number;
  cancellation_charge_minor: number; cancel_reason: string | null; cancelled_at: string | null;
  attention_reason: string | null; primary_guest_id: string;
};
type Payment = {
  id: string; payment_provider: string; payment_method: string; provider_reference: string | null; internal_reference: string;
  amount_minor: number; payment_status: string; received_at: string;
};
type Invoice = { id: string; invoice_number: string; invoice_status: string; total_minor: number };
type Settlement = {
  applicable: boolean; charge_minor: number; held_minor: number; refunds_in_flight_minor: number; refunded_minor: number;
  refund_still_to_request_minor: number; charge_due_minor: number; settled: boolean;
};

const METHOD: Record<string, string> = { cash: "Cash", bank_transfer: "Bank transfer", pos: "POS", other: "Other", card: "Card", bank: "Bank", ussd: "USSD", qr: "QR", mobile_money: "Mobile money", eft: "EFT" };

const ATTENTION: Record<string, string> = {
  cancellation_charge_unpaid: "The cancellation charge has not been fully collected yet. Record a payment for the difference, or decide how to handle it.",
  paid_after_cancel: "The guest paid after this reservation was cancelled. That money should go back to them: request a refund below.",
  paid_inventory_lost: "The guest paid, but the rooms were no longer available. The money needs refunding or the booking re-made by hand.",
};
function attentionText(code: string): string {
  return ATTENTION[code] ?? (code.startsWith("payment_") ? "A payment on this reservation needs review." : `Flagged for attention (${code}).`);
}

export default async function SettlementPage({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  if (!z.guid().safeParse(id).success) notFound();
  const search = await searchParams;
  const supabase = await createClient();

  const { data: resRow } = await supabase
    .from("reservations")
    .select("id, property_id, booking_reference, reservation_status, payment_status, arrival_date, departure_date, currency, total_minor, cancellation_charge_minor, cancel_reason, cancelled_at, attention_reason, primary_guest_id")
    .eq("id", id).maybeSingle();
  if (!resRow) notFound();
  const res = resRow as Reservation;

  const [settleQ, payQ, refundQ, invQ, propQ, guestQ, canRequestQ] = await Promise.all([
    supabase.rpc("reservation_settlement", { p_reservation_id: id }),
    supabase.from("payments").select("id, payment_provider, payment_method, provider_reference, internal_reference, amount_minor, payment_status, received_at").eq("reservation_id", id).order("received_at"),
    supabase.from("refunds").select("id, reservation_id, payment_id, internal_reference, amount_minor, currency, refund_status, reason, requested_by, decided_by, decided_at, decision_note, payout_reference, failure_reason, attention_note, provider_call_started_at, created_at, completed_at").eq("reservation_id", id).order("created_at"),
    supabase.from("invoices").select("id, invoice_number, invoice_status, total_minor").eq("reservation_id", id).order("created_at"),
    supabase.from("properties").select("name, timezone").eq("id", res.property_id).maybeSingle(),
    supabase.from("guests").select("full_name").eq("id", res.primary_guest_id).maybeSingle(),
    supabase.rpc("has_permission", { p_property: res.property_id, p_permission: "refund.request" }),
  ]);

  // Money screens need money visibility; without it the payment, refund and settlement reads come back empty or refused.
  const canSeeMoney = !settleQ.error;
  const settlement = (settleQ.data ?? null) as Settlement | null;
  const payments = (payQ.data ?? []) as Payment[];
  const refunds = (refundQ.data ?? []) as RefundRow[];
  const invoices = (invQ.data ?? []) as Invoice[];
  const tz = (propQ.data as { timezone?: string } | null)?.timezone ?? "UTC";
  const guestName = (guestQ.data as { full_name?: string } | null)?.full_name;
  const canRequest = canRequestQ.data === true;
  const money = (m: number) => formatMoney(m, res.currency);
  const cancelled = res.reservation_status === "cancelled";

  // Prefill each refund form with what the settlement still says is owed, newest payment first.
  let toRequest = settlement?.refund_still_to_request_minor ?? 0;
  const prefill = new Map<string, number>();
  for (const p of [...payments].reverse()) {
    if (p.payment_status !== "succeeded" || toRequest <= 0) continue;
    const take = Math.min(refundableMinor(p.amount_minor, refunds.filter((r) => r.payment_id === p.id)), toRequest);
    if (take > 0) { prefill.set(p.id, take); toRequest -= take; }
  }

  return (
    <main className="max-w-4xl">
      <p className="text-sm"><Link href="/app/refunds" className="text-primary-strong underline underline-offset-2">Refunds</Link></p>
      <h1 className="mt-2 font-display text-3xl">{res.booking_reference}</h1>
      <p className="mt-1 text-muted">
        {guestName ? `${guestName}, ` : ""}{formatDate(res.arrival_date)} to {formatDate(res.departure_date)}
      </p>
      <p className="mt-2 flex flex-wrap gap-2 text-sm">
        <span className="rounded bg-ink/10 px-2 py-0.5 font-medium">{res.reservation_status.replace("_", " ")}</span>
        <span className="rounded bg-ink/10 px-2 py-0.5 font-medium">payment {res.payment_status.replace("_", " ")}</span>
      </p>

      <div className="mt-6"><Notice search={search} currency={res.currency} /></div>

      {res.attention_reason && (
        <p className="mb-6 border-l-4 border-pending bg-pending/5 px-4 py-3 text-sm">{attentionText(res.attention_reason)}</p>
      )}

      {!canSeeMoney ? (
        <p className="rounded border border-line bg-white px-4 py-6 text-muted">You do not have access to this reservation's payments.</p>
      ) : (
        <>
          <section aria-labelledby="statement">
            <h2 id="statement" className="font-display text-xl">Settlement</h2>
            {settlement && !settlement.applicable ? (
              <p className="mt-2 max-w-prose text-muted">
                This reservation is not cancelled, so there is nothing to settle. Money held now is {money(settlement.held_minor)} of {money(res.total_minor)}.
                If it is cancelled, the stay invoice is voided, any cancellation charge is invoiced, and refund requests are made for the rest.
              </p>
            ) : settlement && (
              <>
                {res.cancel_reason && <p className="mt-1 text-sm text-muted">Cancelled{res.cancelled_at ? ` ${formatDateTime(res.cancelled_at, tz)}` : ""}: {res.cancel_reason}</p>}
                <dl className="mt-4 max-w-md text-sm">
                  {[
                    ["Held now (paid in, less refunded)", money(settlement.held_minor), ""],
                    ["Cancellation charge", `− ${money(settlement.charge_minor)}`, ""],
                    ["Refunds already requested or paying out", `− ${money(settlement.refunds_in_flight_minor)}`, ""],
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-baseline justify-between gap-6 py-1.5">
                      <dt className="text-muted">{label}</dt>
                      <dd className="tabular-nums">{value}</dd>
                    </div>
                  ))}
                  <div className="flex items-baseline justify-between gap-6 border-t-2 border-ink py-2 font-semibold">
                    <dt>Still to refund</dt>
                    <dd className="tabular-nums">{money(settlement.refund_still_to_request_minor)}</dd>
                  </div>
                  {settlement.charge_due_minor > 0 && (
                    <div className="flex items-baseline justify-between gap-6 py-1.5 font-semibold text-pending">
                      <dt>Charge still to collect</dt>
                      <dd className="tabular-nums">{money(settlement.charge_due_minor)}</dd>
                    </div>
                  )}
                  <div className="flex items-baseline justify-between gap-6 py-1.5 text-muted">
                    <dt>Already refunded to the guest</dt>
                    <dd className="tabular-nums">{money(settlement.refunded_minor)}</dd>
                  </div>
                </dl>
                <p className="mt-3 text-sm">
                  {settlement.settled
                    ? <span className="font-medium text-primary-strong">Settled: nothing more is owed in either direction.</span>
                    : settlement.refund_still_to_request_minor > 0
                      ? "A refund for the amount above has not been requested yet. Request it from the payment below."
                      : settlement.charge_due_minor > 0
                        ? "Waiting on the guest to cover the cancellation charge."
                        : "Refunds are in progress. They finish on the refund queue."}
                </p>
              </>
            )}
          </section>

          <section className="mt-10" aria-labelledby="payments">
            <h2 id="payments" className="font-display text-xl">Payments</h2>
            {payments.length === 0 ? <p className="mt-2 text-muted">No payments recorded.</p> : (
              <ul className="mt-2 border-t border-line">
                {payments.map((p) => {
                  const mine = refunds.filter((r) => r.payment_id === p.id);
                  const left = p.payment_status === "succeeded" ? refundableMinor(p.amount_minor, mine) : 0;
                  const refunded = mine.filter((r) => r.refund_status === "succeeded").reduce((s, r) => s + r.amount_minor, 0);
                  const via = p.payment_provider === "manual" ? METHOD[p.payment_method] ?? p.payment_method : `Paystack ${(METHOD[p.payment_method] ?? "").toLowerCase()}`.trim();
                  return (
                    <li key={p.id} className="border-b border-line py-4">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                        <div>
                          <span className="font-medium">{via}</span>
                          {p.payment_status === "reversed" && <span className="ml-2 text-sm text-critical">reversed</span>}
                          <p className="text-xs text-muted">
                            {formatDateTime(p.received_at, tz)}, {p.internal_reference}{p.provider_reference ? `, ref ${p.provider_reference}` : ""}
                          </p>
                        </div>
                        <p className="text-right tabular-nums">
                          <span className="font-semibold">{money(p.amount_minor)}</span>
                          <span className="block text-xs text-muted">
                            {refunded > 0 ? `${money(refunded)} refunded, ` : ""}{p.payment_status === "succeeded" ? `${money(left)} left to refund` : ""}
                          </span>
                        </p>
                      </div>
                      {canRequest && left > 0 && (
                        <details className="mt-3" open={prefill.has(p.id)}>
                          <summary className="cursor-pointer text-sm font-medium text-primary-strong">Request a refund from this payment</summary>
                          <form action={requestRefund} className="mt-3 grid max-w-md gap-3">
                            <input type="hidden" name="reservationId" value={res.id} />
                            <input type="hidden" name="paymentId" value={p.id} />
                            <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
                            <div>
                              <label htmlFor={`amt-${p.id}`} className="block text-sm">Amount ({res.currency})</label>
                              <input id={`amt-${p.id}`} name="amount" inputMode="decimal" required defaultValue={minorToInput(prefill.get(p.id) ?? left)} className={`${inputClass} tabular-nums`} />
                              <p className="mt-1 text-xs text-muted">Up to {money(left)}.</p>
                            </div>
                            <div>
                              <label htmlFor={`why-${p.id}`} className="block text-sm">Reason</label>
                              <textarea id={`why-${p.id}`} name="reason" required maxLength={500} rows={2} className={inputClass} />
                            </div>
                            <div><button type="submit" className={buttonPrimary}>Request refund</button></div>
                            <p className="text-xs text-muted">Someone else with approval rights must approve it before any money moves.</p>
                          </form>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="mt-10" aria-labelledby="refunds">
            <h2 id="refunds" className="font-display text-xl">Refunds on this reservation</h2>
            {refunds.length === 0 ? <p className="mt-2 text-muted">None yet.</p> : (
              <ul className="mt-2 border-t border-line">
                {refunds.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line py-3">
                    <div>
                      <span className="font-medium">{r.internal_reference}</span> <StatusChip status={r.refund_status} />
                      <p className="mt-1 max-w-prose text-sm text-muted">{r.reason}</p>
                      {r.failure_reason && <p className="text-sm text-critical">Failed: {r.failure_reason}</p>}
                    </div>
                    <span className="tabular-nums">{formatMoney(r.amount_minor, r.currency)}</span>
                  </li>
                ))}
              </ul>
            )}
            {refunds.some((r) => r.refund_status !== "succeeded" && r.refund_status !== "rejected" && r.refund_status !== "failed") && (
              <p className="mt-3 text-sm"><Link href="/app/refunds" className="text-primary-strong underline underline-offset-2">Approve or pay out on the refund queue</Link></p>
            )}
          </section>

          {invoices.length > 0 && (
            <section className="mt-10" aria-labelledby="invoices">
              <h2 id="invoices" className="font-display text-xl">Invoices</h2>
              <ul className="mt-2 border-t border-line">
                {invoices.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-baseline justify-between gap-x-6 border-b border-line py-3">
                    <span><span className="font-medium">{i.invoice_number}</span> <span className="text-sm text-muted">{i.invoice_status.replace("_", " ")}</span></span>
                    <span className="tabular-nums">{money(i.total_minor)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}
