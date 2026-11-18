import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { eventNotice } from "@/lib/guest-site/events";
import { formatMoney } from "@/lib/guest-site/format";
import { eventTokenId, venueBookingView } from "@/lib/guest-site/server";
import { EVENT_TYPE_LABEL, formatLocal } from "@/lib/staff/events";
import { PendingButton } from "@/components/ui/pending-button";
import { payBookingAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your venue booking", robots: { index: false } };

type Props = { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const STATUS: Record<string, string> = {
  enquiry: "Enquiry received. The hotel will send you a quote.",
  tentative: "Held for you. Pay the deposit to confirm.",
  confirmed: "Confirmed.",
  completed: "Completed.",
  cancelled: "Cancelled.",
  declined: "The hotel could not take this enquiry.",
  expired: "The hold ran out and the venue was released. You can make a new booking.",
};

export default async function EventBookingPage({ params, searchParams }: Props) {
  const { token } = await params;
  const raw = await searchParams;
  const id = eventTokenId(token, "v");
  if (!id) notFound();
  const result = await venueBookingView(id);
  if (!result.ok) notFound();
  const b = result.data;
  const money = (n: number) => formatMoney(n, b.currency);
  const notice = typeof raw.error === "string" ? eventNotice(raw.error) : null;
  const confirming = raw.paid === "1" && b.due_minor > 0;

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="font-display text-3xl">Your venue booking</h1>
      <p className="mt-1 text-sm text-muted">
        {b.hotel} · reference {b.reference}
      </p>
      {notice ? (
        <p role="alert" className="mt-4 rounded border border-critical/40 bg-white p-3 text-critical">
          {notice}
        </p>
      ) : null}
      {raw.sent === "1" ? (
        <p role="status" className="mt-4 rounded border border-primary/40 bg-white p-3 text-sm">
          Thank you. Your enquiry has been sent. Keep this page&rsquo;s link: it is how you come back to your booking.
        </p>
      ) : null}
      {confirming ? (
        <p role="status" className="mt-4 rounded border border-primary/40 bg-white p-3 text-sm">
          Thank you. We are waiting for the payment to be confirmed by the bank. Reload this page in a minute.
        </p>
      ) : null}

      <section className="mt-6 rounded border border-line bg-white p-4">
        <p className="font-medium">{STATUS[b.status] ?? b.status}</p>
        {b.hold_expires_at ? <p className="mt-1 text-sm">Held until {formatLocal(b.hold_expires_at)}.</p> : null}
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <dt className="text-muted">Venue</dt>
          <dd>{b.venue}</dd>
          <dt className="text-muted">Event</dt>
          <dd>{b.title || EVENT_TYPE_LABEL[b.event_type] || b.event_type}</dd>
          <dt className="text-muted">When</dt>
          <dd>
            {formatLocal(b.starts_at)} to {formatLocal(b.ends_at)}
          </dd>
          <dt className="text-muted">People</dt>
          <dd>{b.attendees}</dd>
        </dl>
      </section>

      {b.lines.length > 0 ? (
        <section className="mt-6 rounded border border-line bg-white p-4">
          <h2 className="font-display text-xl">Quote</h2>
          <table className="mt-2 w-full text-sm">
            <tbody>
              {b.lines.map((l, i) => (
                <tr key={i} className="border-b border-line">
                  <td className="py-1 pr-2">{l.description}</td>
                  <td className="px-2 py-1 text-right">
                    {l.quantity} × {money(l.unit_amount_minor)}
                  </td>
                  <td className="py-1 pl-2 text-right tabular-nums">{money(l.line_total_minor)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={2} className="py-1 text-right text-muted">
                  Subtotal
                </td>
                <td className="py-1 pl-2 text-right tabular-nums">{money(b.subtotal_minor)}</td>
              </tr>
              {b.service_minor > 0 ? (
                <tr>
                  <td colSpan={2} className="py-1 text-right text-muted">
                    Service charge
                  </td>
                  <td className="py-1 pl-2 text-right tabular-nums">{money(b.service_minor)}</td>
                </tr>
              ) : null}
              {b.tax_minor > 0 ? (
                <tr>
                  <td colSpan={2} className="py-1 text-right text-muted">
                    Tax
                  </td>
                  <td className="py-1 pl-2 text-right tabular-nums">{money(b.tax_minor)}</td>
                </tr>
              ) : null}
              <tr className="font-semibold">
                <td colSpan={2} className="py-1 text-right">
                  Total
                </td>
                <td className="py-1 pl-2 text-right tabular-nums">{money(b.total_minor)}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-sm">
            Deposit {money(b.deposit_minor)} · paid {money(b.paid_minor)}
          </p>
        </section>
      ) : null}

      {b.due_minor > 0 ? (
        <form action={payBookingAction} className="mt-6">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="key" value={crypto.randomUUID()} />
          <PendingButton className="rounded-full bg-primary px-6 py-3 text-white" pendingLabel="Opening payment…">
            {b.status === "tentative" ? `Pay the deposit, ${money(b.due_minor)}` : `Pay the balance, ${money(b.due_minor)}`}
          </PendingButton>
        </form>
      ) : null}
    </main>
  );
}
