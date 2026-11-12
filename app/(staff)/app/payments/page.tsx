import Link from "next/link";
import { buttonPrimary, EmptyState, ErrorBanner, linkClass, Notice, PageIntro, PageTitle } from "@/components/staff/ui";
import { formatMoney } from "@/lib/guest-site/format";
import { formatDateTime } from "@/lib/staff/format";
import { verifyPayment } from "@/lib/staff/payment-verification-actions";
import { daysWaiting, methodLabel, parseQueue, parseVerificationView, waitingText } from "@/lib/staff/payment-verification";
import { createClient } from "@/lib/supabase/server";
import { PendingButton } from "@/components/ui/pending-button";

export const dynamic = "force-dynamic";

export default async function PaymentsToVerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const view = parseVerificationView(search.view);
  const supabase = await createClient();

  const [queueQ, propQ] = await Promise.all([
    supabase.rpc("payments_to_verify", { p_status: view, p_limit: 100 }),
    supabase.from("properties").select("id, timezone"),
  ]);
  const queue = parseQueue(queueQ.data);
  const zones = new Map(((propQ.data ?? []) as { id: string; timezone: string }[]).map((p) => [p.id, p.timezone]));
  const showProperty = new Set(queue.items.map((i) => i.property_id)).size > 1;
  const now = new Date();
  const tab = (active: boolean) =>
    `rounded px-3 py-1.5 text-sm ${active ? "bg-navy-900 text-white" : "bg-ink/5 text-ink hover:bg-ink/10"} focus-visible:outline-2 focus-visible:outline-primary`;

  return (
    <main className="max-w-4xl">
      <PageTitle>Payments to verify</PageTitle>
      <PageIntro>
        Bank transfers and other payments the desk recorded by hand. They already count toward the guest&apos;s balance, but nobody has yet
        checked them against the bank statement. Verify each one once you have seen the money, or reverse it from the booking if it never
        arrived. Cash and card-terminal payments are counted as verified when they are recorded.
      </PageIntro>

      <div className="mt-6">
        <Notice search={search} currency="NGN" />
        {queueQ.error && (
          <ErrorBanner className="mb-5">
            The payments could not be loaded. You may not have permission to verify payments. Reload the page to try again.
          </ErrorBanner>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2" role="navigation" aria-label="Which payments">
        <Link href="/app/payments" className={tab(view === "unverified")} aria-current={view === "unverified" ? "page" : undefined}>
          To verify{queue.unverified > 0 && <span className="ml-1 tabular-nums">({queue.unverified})</span>}
        </Link>
        <Link
          href="/app/payments?view=verified"
          className={tab(view === "verified")}
          aria-current={view === "verified" ? "page" : undefined}
        >
          Recently verified
        </Link>
        <Link href="/app/payments/all" className={tab(false)}>
          All payments
        </Link>
      </div>

      {queue.items.length === 0 && !queueQ.error && (
        <EmptyState className="mt-8">
          {view === "unverified" ? "Nothing waiting. Every manual payment has been checked." : "No payments have been verified yet."}
        </EmptyState>
      )}

      <ul className="mt-6 border-t border-line">
        {queue.items.map((p) => {
          const tz = zones.get(p.property_id) ?? "UTC";
          return (
            <li key={p.id} className="grid gap-x-8 gap-y-3 border-b border-line py-5 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="text-lg font-semibold tabular-nums">{formatMoney(p.amount_minor, p.currency)}</span>
                  <span className="font-medium">{methodLabel(p.method)}</span>
                  {view === "unverified" && <span className="text-sm text-muted">{waitingText(daysWaiting(p.received_at, now))}</span>}
                </div>
                <p className="mt-1 text-sm">
                  <Link href={`/app/reservations/${p.reservation_id}/settlement`} className={linkClass}>
                    {p.booking_reference}
                  </Link>
                  {p.guest_name ? `, ${p.guest_name}` : ""}
                  {showProperty ? `, ${p.property_name}` : ""}
                </p>
                <p className="mt-1 text-xs text-muted">
                  Recorded {formatDateTime(p.received_at, tz)}
                  {p.recorded_by_name ? ` by ${p.recorded_by_name}` : ""}
                  {p.reference ? `, reference ${p.reference}` : ", no reference given"}
                </p>
                {p.note && <p className="mt-1 max-w-prose break-words text-sm">{p.note}</p>}
                {view === "verified" && (
                  <p className="mt-1 text-xs text-muted">
                    Verified {formatDateTime(p.verified_at, tz)}
                    {p.verified_by_name ? ` by ${p.verified_by_name}` : ""}
                    {p.verification_note ? `: ${p.verification_note}` : ""}
                  </p>
                )}
              </div>
              {view === "unverified" && (
                <form action={verifyPayment} className="space-y-2 md:justify-self-end">
                  <input type="hidden" name="paymentId" value={p.id} />
                  <label className="block text-sm">
                    <span className="text-muted">Note (optional)</span>
                    <input
                      name="note"
                      maxLength={500}
                      placeholder="e.g. seen on the 14 Nov statement"
                      className="mt-1 block w-full rounded border border-line px-2 py-1.5"
                    />
                  </label>
                  <PendingButton className={buttonPrimary} pendingLabel="Saving…">
                    Mark verified
                  </PendingButton>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
