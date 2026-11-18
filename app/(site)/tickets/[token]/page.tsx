import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { eventNotice } from "@/lib/guest-site/events";
import { formatMoney } from "@/lib/guest-site/format";
import { eventTokenId, ticketOrderView } from "@/lib/guest-site/server";
import { formatLocal } from "@/lib/staff/events";
import { PendingButton } from "@/components/ui/pending-button";
import { payTicketsAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your tickets", robots: { index: false } };

type Props = { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function TicketsPage({ params, searchParams }: Props) {
  const { token } = await params;
  const raw = await searchParams;
  const id = eventTokenId(token, "t");
  if (!id) notFound();
  const result = await ticketOrderView(id);
  if (!result.ok) notFound();
  const o = result.data;
  const money = (n: number) => formatMoney(n, o.currency);
  const notice = typeof raw.error === "string" ? eventNotice(raw.error) : null;
  const confirming = raw.paid === "1" && o.status === "pending";

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="font-display text-3xl">{o.status === "paid" ? "Your tickets" : "Your order"}</h1>
      <p className="mt-1 text-sm text-muted">
        {o.hotel} · order {o.reference}
      </p>
      {notice ? (
        <p role="alert" className="mt-4 rounded border border-critical/40 bg-white p-3 text-critical">
          {notice}
        </p>
      ) : null}
      {confirming ? (
        <p role="status" className="mt-4 rounded border border-primary/40 bg-white p-3 text-sm">
          Thank you. We are waiting for the payment to be confirmed by the bank. Reload this page in a minute.
        </p>
      ) : null}

      <section className="mt-6 rounded border border-line bg-white p-4">
        <h2 className="font-display text-xl">{o.event}</h2>
        <p className="mt-1 text-sm text-muted">
          {formatLocal(o.starts_at)} to {formatLocal(o.ends_at)}
          {o.venue ? ` · ${o.venue}` : ""}
        </p>
        {o.event_status === "cancelled" ? (
          <p className="mt-2 text-sm font-medium text-critical">
            This event has been cancelled. The hotel will contact you about a refund.
          </p>
        ) : null}
        <ul className="mt-3 space-y-1 text-sm">
          {o.items.map((i, n) => (
            <li key={n}>
              {i.quantity} × {i.name}: {money(i.quantity * i.unit_price_minor)}
            </li>
          ))}
        </ul>
        <p className="mt-2 font-medium">Total {money(o.total_minor)}</p>
      </section>

      {o.status === "paid" && o.tickets.length > 0 ? (
        <section className="mt-6 rounded border border-line bg-white p-4">
          <h2 className="font-display text-xl">Show these codes at the door</h2>
          <ul className="mt-2 space-y-2">
            {o.tickets.map((t) => (
              <li key={t.code} className="flex items-center justify-between rounded border border-line p-3">
                <span className="font-mono text-lg tracking-wider">{t.code}</span>
                <span className="text-sm text-muted">
                  {t.type}
                  {t.status === "used" ? " · used" : t.status === "void" ? " · void" : ""}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">Keep this page&rsquo;s link. It is how you come back to your tickets.</p>
        </section>
      ) : null}

      {o.status === "pending" && o.due_minor > 0 ? (
        <form action={payTicketsAction} className="mt-6">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="key" value={crypto.randomUUID()} />
          {o.hold_expires_at ? <p className="mb-2 text-sm">Your tickets are held until {formatLocal(o.hold_expires_at)}.</p> : null}
          <PendingButton className="rounded-full bg-primary px-6 py-3 text-white" pendingLabel="Opening payment…">
            Pay {money(o.due_minor)}
          </PendingButton>
        </form>
      ) : null}
      {o.status === "expired" ? (
        <p className="mt-6 text-sm">The hold ran out and the tickets were released. Please order again from the events page.</p>
      ) : null}
      {o.status === "cancelled" ? <p className="mt-6 text-sm">This order was cancelled.</p> : null}
    </main>
  );
}
