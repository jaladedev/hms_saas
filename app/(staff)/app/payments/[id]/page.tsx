import Link from "next/link";
import { notFound } from "next/navigation";
import {
  buttonPrimary,
  buttonQuiet,
  ErrorBanner,
  linkClass,
  Notice,
  PageTitle,
  ReservationChip,
  SectionTitle,
} from "@/components/staff/ui";
import { PendingButton } from "@/components/ui/pending-button";
import { formatMoney } from "@/lib/guest-site/format";
import { formatDateTime } from "@/lib/staff/format";
import { invoiceStatusLabel, paymentMethodLabel, paymentSourceLabel, paymentStatusLabel, verificationLabel } from "@/lib/staff/money-lists";
import { addPaymentReceipt, removePaymentReceipt } from "@/lib/staff/payment-receipt-actions";
import { MAX_RECEIPTS, RECEIPT_ACCEPT, RECEIPT_BUCKET, RECEIPT_LINK_SECONDS, receiptLabel } from "@/lib/staff/payment-receipts";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Payment = {
  id: string;
  property_id: string;
  reservation_id: string;
  payment_provider: string;
  payment_method: string;
  provider_reference: string | null;
  internal_reference: string;
  amount_minor: number;
  currency: string;
  payment_status: string;
  note: string | null;
  received_at: string;
  recorded_by: string | null;
  verification_status: string;
  verified_at: string | null;
  verified_by: string | null;
  verification_note: string | null;
};

export default async function PaymentDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const search = await searchParams;
  if (!UUID.test(id)) notFound();
  const supabase = await createClient();

  // Row level security hides the payment from anyone who may not see money, so "not found" covers both cases.
  const payQ = await supabase
    .from("payments")
    .select(
      "id, property_id, reservation_id, payment_provider, payment_method, provider_reference, internal_reference, amount_minor, currency, payment_status, note, received_at, recorded_by, verification_status, verified_at, verified_by, verification_note",
    )
    .eq("id", id)
    .maybeSingle();
  if (payQ.error) {
    return (
      <main className="max-w-3xl">
        <PageTitle>Payment</PageTitle>
        <ErrorBanner className="mt-6">This payment could not be loaded. Reload the page.</ErrorBanner>
      </main>
    );
  }
  const p = payQ.data as Payment | null;
  if (!p) notFound();

  const [propQ, resQ, allocQ] = await Promise.all([
    supabase.from("properties").select("name, timezone").eq("id", p.property_id).maybeSingle(),
    supabase
      .from("reservations")
      .select("id, booking_reference, primary_guest_id, reservation_status")
      .eq("id", p.reservation_id)
      .maybeSingle(),
    supabase.from("payment_allocations").select("invoice_id, amount_minor").eq("payment_id", p.id),
  ]);
  const tz = (propQ.data as { timezone: string } | null)?.timezone ?? "UTC";
  const res = resQ.data as { id: string; booking_reference: string; primary_guest_id: string; reservation_status: string } | null;
  const allocs = (allocQ.data ?? []) as { invoice_id: string; amount_minor: number }[];

  const invIds = [...new Set(allocs.map((a) => a.invoice_id))];
  const [guestQ, invQ] = await Promise.all([
    res ? supabase.from("guests").select("full_name").eq("id", res.primary_guest_id).maybeSingle() : { data: null },
    invIds.length ? supabase.from("invoices").select("id, invoice_number, invoice_status").in("id", invIds) : { data: [] },
  ]);
  const guestName = (guestQ.data as { full_name: string } | null)?.full_name ?? null;
  const invoices = new Map(((invQ.data ?? []) as { id: string; invoice_number: string; invoice_status: string }[]).map((i) => [i.id, i]));

  // Names come from the audit lookup, which only people who may see the audit trail can use; others see "a member of staff".
  const staffIds = [p.recorded_by, p.verified_by].filter((x): x is string => !!x);
  const namesQ = staffIds.length ? await supabase.rpc("audit_actor_names", { p_user_ids: staffIds }) : { data: [] };
  const staffNames = new Map(((namesQ.data ?? []) as { user_id: string; name: string }[]).map((n) => [n.user_id, n.name]));
  const who = (uid: string | null) => (uid ? (staffNames.get(uid) ?? "a member of staff") : null);

  // Receipts: the rows come through row-level security (people who may see money), and each file is shown by a short-lived signed
  // link made here, so the row's access rule is the file's access rule. The bucket is private; nobody reaches a file by address.
  const [receiptQ, canRecordQ] = await Promise.all([
    supabase
      .from("payment_receipts")
      .select("id, storage_path, content_type, size_bytes, created_at")
      .eq("payment_id", p.id)
      .order("created_at"),
    supabase.rpc("has_permission", { p_property: p.property_id, p_permission: "payment.record" }),
  ]);
  const receipts = (receiptQ.data ?? []) as {
    id: string;
    storage_path: string;
    content_type: string;
    size_bytes: number;
    created_at: string;
  }[];
  const canRecord = canRecordQ.data === true;
  const receiptLinks = new Map<string, string>();
  if (receipts.length > 0) {
    try {
      const { data: signed } = await createServiceClient()
        .storage.from(RECEIPT_BUCKET)
        .createSignedUrls(
          receipts.map((r) => r.storage_path),
          RECEIPT_LINK_SECONDS,
        );
      for (const s of signed ?? []) if (s.path && s.signedUrl && !s.error) receiptLinks.set(s.path, s.signedUrl);
    } catch {
      // Storage is unavailable: the list still shows, with "File unavailable" beside each receipt.
    }
  }

  const reversed = p.payment_status === "reversed";
  const online = p.payment_provider !== "manual";
  const allocated = allocs.reduce((n, a) => n + a.amount_minor, 0);
  const row = "grid gap-1 border-b border-line py-3 md:grid-cols-[12rem_minmax(0,1fr)]";

  return (
    <main className="max-w-3xl">
      <p className="text-sm">
        <Link href="/app/payments/all" className={linkClass}>
          All payments
        </Link>
      </p>
      <div className="mt-4">
        <Notice search={search} currency={p.currency} />
      </div>
      <PageTitle className="mt-2">
        <span className={`tabular-nums ${reversed ? "text-muted line-through" : ""}`}>{formatMoney(p.amount_minor, p.currency)}</span>{" "}
        <span className="text-base font-normal text-muted">{paymentMethodLabel(p.payment_method)}</span>
      </PageTitle>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${reversed ? "bg-critical/10 text-critical" : "bg-primary/10 text-primary-strong"}`}
        >
          {paymentStatusLabel(p.payment_status)}
        </span>
        {!reversed && (
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${p.verification_status === "unverified" ? "bg-pending/10 text-pending" : "bg-ink/10 text-muted"}`}
          >
            {verificationLabel(p.verification_status)}
          </span>
        )}
      </div>

      <dl className="mt-6 border-t border-line text-sm">
        <div className={row}>
          <dt className="text-muted">Booking</dt>
          <dd>
            {res ? (
              <>
                <Link href={`/app/reservations/${res.id}/settlement`} className={linkClass}>
                  {res.booking_reference}
                </Link>{" "}
                <ReservationChip status={res.reservation_status} />
                <span className="block text-muted">{guestName ?? "Guest not visible to you"}</span>
              </>
            ) : (
              <span className="text-muted">Not visible to you</span>
            )}
          </dd>
        </div>
        <div className={row}>
          <dt className="text-muted">Taken</dt>
          <dd>{online ? paymentSourceLabel(p.payment_provider) + " (online)" : paymentSourceLabel(p.payment_provider)}</dd>
        </div>
        <div className={row}>
          <dt className="text-muted">Received</dt>
          <dd>
            {formatDateTime(p.received_at, tz)}
            {who(p.recorded_by) ? `, recorded by ${who(p.recorded_by)}` : ""}
          </dd>
        </div>
        <div className={row}>
          <dt className="text-muted">Reference</dt>
          <dd className="break-words">
            {p.provider_reference ?? <span className="text-muted">None given</span>}
            <span className="block text-xs text-muted">Our reference {p.internal_reference}</span>
          </dd>
        </div>
        {(propQ.data as { name: string } | null)?.name && (
          <div className={row}>
            <dt className="text-muted">Hotel</dt>
            <dd>{(propQ.data as { name: string }).name}</dd>
          </div>
        )}
        {p.note && (
          <div className={row}>
            <dt className="text-muted">Note</dt>
            <dd className="max-w-prose break-words">{p.note}</dd>
          </div>
        )}
      </dl>

      <div className="mt-8">
        <SectionTitle>Verification</SectionTitle>
      </div>
      {online ? (
        <p className="mt-2 text-sm">Paid online. The payment provider confirmed it, so there is nothing to verify by hand.</p>
      ) : p.verification_status === "verified" ? (
        <p className="mt-2 text-sm">
          {p.verified_at ? `Verified ${formatDateTime(p.verified_at, tz)}` : "Verified when it was recorded"}
          {who(p.verified_by) ? ` by ${who(p.verified_by)}` : ""}
          {p.verification_note ? `: ${p.verification_note}` : "."}
        </p>
      ) : reversed ? (
        <p className="mt-2 text-sm text-muted">This payment was reversed before it was checked.</p>
      ) : (
        <p className="mt-2 text-sm">
          Recorded but not checked against the bank statement yet. It already counts toward the booking&apos;s balance.{" "}
          <Link href="/app/payments" className={linkClass}>
            Open the verification queue
          </Link>
          .
        </p>
      )}

      <div className="mt-8">
        <SectionTitle>Applied to</SectionTitle>
      </div>
      {allocs.length === 0 ? (
        <p className="mt-2 text-sm text-muted">
          {reversed ? "A reversed payment is no longer applied to an invoice." : "This payment is not applied to a booking invoice."}
        </p>
      ) : (
        <>
          <ul className="mt-2 border-t border-line text-sm">
            {allocs.map((a) => {
              const inv = invoices.get(a.invoice_id);
              return (
                <li key={a.invoice_id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-3">
                  <span>
                    {res && inv ? (
                      <Link href={`/app/reservations/${res.id}/documents`} className={linkClass}>
                        Invoice {inv.invoice_number}
                      </Link>
                    ) : (
                      "An invoice you cannot see"
                    )}
                    {inv && <span className="ml-2 text-xs text-muted">{invoiceStatusLabel(inv.invoice_status)}</span>}
                  </span>
                  <span className="tabular-nums">{formatMoney(a.amount_minor, p.currency)}</span>
                </li>
              );
            })}
          </ul>
          {allocs.length > 1 && <p className="mt-2 text-xs text-muted">Applied in total: {formatMoney(allocated, p.currency)}</p>}
        </>
      )}

      <div className="mt-8">
        <SectionTitle>Receipts</SectionTitle>
      </div>
      {receipts.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No receipt attached.</p>
      ) : (
        <ul className="mt-2 border-t border-line text-sm">
          {receipts.map((r, i) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-3">
              <span>
                {receiptLabel(i + 1, r.content_type, r.size_bytes)}
                <span className="ml-2 text-xs text-muted">added {formatDateTime(r.created_at, tz)}</span>
              </span>
              <span className="flex items-center gap-3">
                {receiptLinks.get(r.storage_path) ? (
                  <a href={receiptLinks.get(r.storage_path)} target="_blank" rel="noopener noreferrer" className={linkClass}>
                    View
                  </a>
                ) : (
                  <span className="text-muted">File unavailable</span>
                )}
                {canRecord && (
                  <form action={removePaymentReceipt}>
                    <input type="hidden" name="receiptId" value={r.id} />
                    <PendingButton className={buttonQuiet} pendingLabel="Removing…">
                      Remove
                    </PendingButton>
                  </form>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canRecord && receipts.length < MAX_RECEIPTS && (
        <form action={addPaymentReceipt} className="mt-3 flex flex-wrap items-end gap-3">
          <input type="hidden" name="paymentId" value={p.id} />
          <div>
            <label htmlFor="receipt-file" className="block text-sm">
              Add a receipt
            </label>
            <input id="receipt-file" name="receipt" type="file" required accept={RECEIPT_ACCEPT} className="mt-1 block text-sm" />
          </div>
          <PendingButton className={buttonPrimary} pendingLabel="Uploading…">
            Add receipt
          </PendingButton>
        </form>
      )}
      <p className="mt-2 max-w-prose text-xs text-muted">
        A bank slip, POS slip or cash receipt, as a picture or PDF up to 5 MB, three at most. Only people who handle payments can see them,
        and a link opens for five minutes. A receipt is a document beside the payment: it changes no amount or status.
      </p>

      <p className="mt-8 text-sm text-muted">
        To reverse a payment that never arrived, or refund one, open the booking&apos;s{" "}
        {res ? (
          <Link href={`/app/reservations/${res.id}/settlement`} className={linkClass}>
            settlement page
          </Link>
        ) : (
          "settlement page"
        )}
        .
      </p>
    </main>
  );
}
