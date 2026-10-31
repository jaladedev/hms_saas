import Link from "next/link";
import { PayoutButton } from "@/components/staff/payout-button";
import { buttonDanger, buttonPrimary, inputClass, Notice, StatusChip } from "@/components/staff/ui";
import { formatMoney } from "@/lib/guest-site/format";
import { decideRefund, recordManualPayout } from "@/lib/staff/refund-actions";
import { formatAge, formatDateTime } from "@/lib/staff/format";
import { availableAction, groupQueue, minutesSince, type RefundRow } from "@/lib/staff/refunds";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUMNS =
  "id, reservation_id, payment_id, internal_reference, amount_minor, currency, refund_status, reason, requested_by, decided_by, decided_at, decision_note, payout_reference, failure_reason, attention_note, provider_call_started_at, created_at, completed_at";

type ResInfo = { id: string; property_id: string; booking_reference: string; primary_guest_id: string };
type PayInfo = { id: string; payment_provider: string; payment_method: string };
type PropInfo = { id: string; name: string; timezone: string };

const METHOD: Record<string, string> = { cash: "Cash", bank_transfer: "Bank transfer", pos: "POS", other: "Other", card: "Card", bank: "Bank", ussd: "USSD", qr: "QR", mobile_money: "Mobile money", eft: "EFT" };

export default async function RefundsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const search = await searchParams;
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  const viewerId = auth.user?.id ?? null;

  const [open, closed] = await Promise.all([
    supabase.from("refunds").select(COLUMNS).in("refund_status", ["requested", "approved", "processing"]).order("created_at").limit(200),
    supabase.from("refunds").select(COLUMNS).in("refund_status", ["succeeded", "rejected", "failed"]).order("updated_at", { ascending: false }).limit(20),
  ]);
  const loadError = open.error ?? closed.error;
  const rows = [...(open.data ?? []), ...(closed.data ?? [])] as RefundRow[];

  const resIds = [...new Set(rows.map((r) => r.reservation_id))];
  const payIds = [...new Set(rows.map((r) => r.payment_id))];
  const [resQ, payQ] = await Promise.all([
    resIds.length ? supabase.from("reservations").select("id, property_id, booking_reference, primary_guest_id").in("id", resIds) : { data: [] },
    payIds.length ? supabase.from("payments").select("id, payment_provider, payment_method").in("id", payIds) : { data: [] },
  ]);
  const reservations = new Map(((resQ.data ?? []) as ResInfo[]).map((r) => [r.id, r]));
  const payments = new Map(((payQ.data ?? []) as PayInfo[]).map((p) => [p.id, p]));

  const guestIds = [...new Set([...reservations.values()].map((r) => r.primary_guest_id))];
  const propIds = [...new Set([...reservations.values()].map((r) => r.property_id))];
  const [guestQ, propQ] = await Promise.all([
    guestIds.length ? supabase.from("guests").select("id, full_name").in("id", guestIds) : { data: [] },
    propIds.length ? supabase.from("properties").select("id, name, timezone").in("id", propIds) : { data: [] },
  ]);
  // Guest names need guest.view; when RLS hides them the row simply shows the booking reference.
  const guests = new Map(((guestQ.data ?? []) as { id: string; full_name: string }[]).map((g) => [g.id, g.full_name]));
  const properties = new Map(((propQ.data ?? []) as PropInfo[]).map((p) => [p.id, p]));
  const showProperty = properties.size > 1;

  const now = new Date();
  const groups = groupQueue(rows, now);
  const anyOpen = groups.attention.length + groups.awaitingApproval.length + groups.readyToPay.length + groups.processing.length > 0;
  const currency = rows[0]?.currency ?? "NGN";

  function Row({ r }: { r: RefundRow }) {
    const res = reservations.get(r.reservation_id);
    const pay = payments.get(r.payment_id);
    const prop = res ? properties.get(res.property_id) : undefined;
    const tz = prop?.timezone ?? "UTC";
    const action = availableAction(r, pay?.payment_provider ?? null, viewerId);
    const attention = groups.attention.includes(r);
    const money = formatMoney(r.amount_minor, r.currency);
    const guest = res ? guests.get(res.primary_guest_id) : undefined;
    const via = pay ? (pay.payment_provider === "manual" ? METHOD[pay.payment_method] ?? pay.payment_method : `Paystack ${METHOD[pay.payment_method]?.toLowerCase() ?? ""}`.trim()) : "";

    return (
      <li className="grid gap-x-8 gap-y-3 border-b border-line py-5 md:grid-cols-[minmax(0,1fr)_9rem_minmax(0,18rem)]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">{r.internal_reference}</span>
            <StatusChip status={attention ? "attention" : r.refund_status} />
          </div>
          <p className="mt-1 text-sm text-muted">
            {res ? (
              <>
                <Link href={`/app/reservations/${res.id}/settlement`} className="font-medium text-primary-strong underline underline-offset-2">{res.booking_reference}</Link>
                {guest ? `, ${guest}` : ""}
                {showProperty && prop ? `, ${prop.name}` : ""}
              </>
            ) : "Reservation not visible to you"}
          </p>
          <p className="mt-2 max-w-prose text-sm">{r.reason}</p>
          <p className="mt-1 text-xs text-muted">
            Requested {formatDateTime(r.created_at, tz)}{via ? `, refunding a ${via.toLowerCase()} payment` : ""}
          </p>
          {r.decision_note && <p className="mt-1 text-xs text-muted">Decision note: {r.decision_note}</p>}
          {r.payout_reference && <p className="mt-1 text-xs text-muted">Payout reference: {r.payout_reference}</p>}
          {r.failure_reason && <p className="mt-1 text-sm text-critical">Failed: {r.failure_reason}</p>}
          {r.refund_status === "processing" && (
            <p className="mt-1 text-xs text-muted">Started {formatAge(minutesSince(r.provider_call_started_at, now))} ago</p>
          )}
          {attention && (
            <div className="mt-3 max-w-prose border-l-4 border-critical bg-critical/5 px-3 py-2 text-sm">
              {r.attention_note && <p className="text-critical">{r.attention_note}</p>}
              <p className="mt-1 text-ink">
                Open this refund on the Paystack dashboard. When Paystack reports a result, the webhook closes it here by itself; do not start a second payout.
              </p>
            </div>
          )}
        </div>

        <p className="text-lg font-semibold tabular-nums md:text-right">{money}</p>

        <div className="space-y-2 md:justify-self-end">
          {action.kind === "decide" && (
            <>
              <form action={decideRefund}>
                <input type="hidden" name="refundId" value={r.id} />
                <input type="hidden" name="decision" value="approve" />
                <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
                <button type="submit" className={buttonPrimary}>Approve {money}</button>
              </form>
              <details className="group">
                <summary className={`${buttonDanger} inline-block cursor-pointer list-none`}>Reject</summary>
                <form action={decideRefund} className="mt-2 space-y-2">
                  <input type="hidden" name="refundId" value={r.id} />
                  <input type="hidden" name="decision" value="reject" />
                  <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
                  <label className="block text-sm" htmlFor={`note-${r.id}`}>Why is it being rejected?</label>
                  <textarea id={`note-${r.id}`} name="note" required maxLength={500} rows={2} className={inputClass} />
                  <button type="submit" className={buttonDanger}>Reject refund</button>
                </form>
              </details>
            </>
          )}
          {action.kind === "own_request" && <p className="max-w-xs text-sm text-muted">You requested this, so a second person with approval rights has to decide it.</p>}
          {action.kind === "manual_payout" && (
            <form action={recordManualPayout} className="space-y-2">
              <input type="hidden" name="refundId" value={r.id} />
              <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
              <p className="text-sm text-muted">Pay the guest back by hand, then record it.</p>
              <label className="block text-sm" htmlFor={`ref-${r.id}`}>Transfer or receipt number (optional)</label>
              <input id={`ref-${r.id}`} name="payoutReference" maxLength={200} className={inputClass} />
              <button type="submit" className={buttonPrimary}>I have paid out {money}</button>
            </form>
          )}
          {action.kind === "provider_payout" && <PayoutButton refundId={r.id} amountLabel={money} />}
          {action.kind === "wait" && !attention && <p className="max-w-xs text-sm text-muted">With Paystack. This page updates when Paystack confirms.</p>}
        </div>
      </li>
    );
  }

  function Section({ title, hint, items }: { title: string; hint?: string; items: RefundRow[] }) {
    if (items.length === 0) return null;
    return (
      <section className="mt-10 first:mt-0">
        <h2 className="font-display text-xl">{title} <span className="text-base text-muted">({items.length})</span></h2>
        {hint && <p className="mt-1 max-w-prose text-sm text-muted">{hint}</p>}
        <ul className="mt-2 border-t border-line">{items.map((r) => <Row key={r.id} r={r} />)}</ul>
      </section>
    );
  }

  return (
    <main className="max-w-5xl">
      <h1 className="font-display text-3xl">Refunds</h1>
      <p className="mt-2 max-w-prose text-muted">
        Money going back to guests takes two people: one asks, another approves. Card refunds are then paid out through Paystack; cash and transfers are paid by hand and recorded here.
      </p>

      <div className="mt-6">
        <Notice search={search} currency={currency} />
        {loadError && <p role="alert" className="mb-5 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">The refund list could not be loaded. Reload the page.</p>}
      </div>

      {!loadError && !anyOpen && <p className="rounded border border-line bg-white px-4 py-6 text-muted">Nothing is waiting on anyone.</p>}

      <Section title="Needs a person" hint="A payout was sent and its result is unknown or overdue. Check Paystack before doing anything else." items={groups.attention} />
      <Section title="Awaiting approval" items={groups.awaitingApproval} />
      <Section title="Ready to pay out" items={groups.readyToPay} />
      <Section title="Paying out" items={groups.processing} />
      <Section title="Recently closed" items={groups.closed} />
    </main>
  );
}
