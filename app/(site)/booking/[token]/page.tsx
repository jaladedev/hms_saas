import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { verifyBookingToken } from "@/lib/booking-token";
import { serverEnv } from "@/lib/env";
import { formatDate, formatMoney, formatTime } from "@/lib/guest-site/format";
import { messageForCode } from "@/lib/guest-site/errors";
import { bookingStatus } from "@/lib/guest-site/server";
import { payAction } from "./actions";

export const dynamic = "force-dynamic";
// A booking link is a credential: keep it out of search engines and out of Referer headers.
export const metadata: Metadata = { title: "Your booking", robots: { index: false, follow: false }, referrer: "no-referrer" };

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function holdMinutesLeft(iso: string | null): number {
  if (!iso) return 0;
  return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 60000));
}

export default async function BookingPage({ params, searchParams }: Props) {
  const { token } = await params;
  const raw = await searchParams;
  const reservationId = verifyBookingToken(token, serverEnv().BOOKING_TOKEN_SECRET);
  if (!reservationId) notFound();

  const result = await bookingStatus(reservationId);
  if (!result.ok) notFound();
  const b = result.data;

  const justPaid = raw.paid === "1";
  const holdLive = b.status === "pending" && b.hold_expires_at !== null && Date.parse(b.hold_expires_at) > Date.now();
  const awaitingConfirmation = justPaid && b.status === "pending";
  const notice = typeof raw.error === "string" ? messageForCode(raw.error) : null;
  const key = crypto.randomUUID();

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      {awaitingConfirmation ? <meta httpEquiv="refresh" content="6" /> : null}
      <p className="text-sm text-muted">Booking reference</p>
      <h1 className="font-display text-3xl">{b.booking_reference}</h1>
      {notice ? <p role="alert" className="mt-4 rounded border border-critical/40 bg-white p-3 text-critical">{notice}</p> : null}

      {b.status === "confirmed" || b.status === "checked_in" ? (
        <p className="mt-4 rounded border border-primary/40 bg-white p-3 text-primary-strong">
          Your booking is confirmed. Check-in is from {formatTime(b.check_in_time)} on {formatDate(b.arrival_date)}.
        </p>
      ) : null}
      {awaitingConfirmation ? (
        <p role="status" className="mt-4 rounded border border-pending/40 bg-white p-3 text-pending">
          We are confirming your payment. This page will update by itself; you do not need to pay again.
        </p>
      ) : null}
      {b.status === "pending" && !awaitingConfirmation && !holdLive ? (
        <p className="mt-4 rounded border border-pending/40 bg-white p-3 text-pending">
          This reservation hold has expired. <a href="/" className="underline">Search again</a> to make a new one.
        </p>
      ) : null}
      {b.status === "expired" ? (
        <p className="mt-4 rounded border border-pending/40 bg-white p-3 text-pending">
          This reservation expired because payment was not completed. <a href="/" className="underline">Search again</a> to book.
        </p>
      ) : null}
      {b.status === "cancelled" ? <p className="mt-4 rounded border border-line bg-white p-3">This booking was cancelled.</p> : null}

      <section className="mt-6 rounded border border-line bg-white p-4">
        <h2 className="font-medium">{b.property_name}</h2>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <dt className="text-muted">Check in</dt><dd>{formatDate(b.arrival_date)}, from {formatTime(b.check_in_time)}</dd>
          <dt className="text-muted">Check out</dt><dd>{formatDate(b.departure_date)}, by {formatTime(b.check_out_time)}</dd>
          <dt className="text-muted">Rooms</dt>
          <dd>{b.rooms.map((r, i) => <span key={i} className="block">{r.room_type}: {r.adults} {r.adults === 1 ? "adult" : "adults"}{r.children ? `, ${r.children} children` : ""}</span>)}</dd>
          <dt className="text-muted">Total</dt><dd>{formatMoney(b.total_minor, b.currency)}</dd>
          <dt className="text-muted">Paid</dt><dd>{formatMoney(b.paid_minor, b.currency)}</dd>
          <dt className="text-muted">Still to pay</dt><dd>{formatMoney(b.outstanding_minor, b.currency)}</dd>
        </dl>
      </section>

      {holdLive && !awaitingConfirmation ? (
        <section className="mt-6 rounded border border-line bg-white p-4">
          <p className="text-sm text-muted">
            Your room is held for about {holdMinutesLeft(b.hold_expires_at)} more {holdMinutesLeft(b.hold_expires_at) === 1 ? "minute" : "minutes"}.
            Keep this page&apos;s link: it is how you come back to your booking.
          </p>
          <form action={payAction} className="mt-4">
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="key" value={key} />
            <button type="submit" className="w-full rounded bg-primary px-4 py-2 font-medium text-white hover:bg-primary-strong">Pay now</button>
          </form>
        </section>
      ) : null}
      {(b.status === "confirmed" && b.outstanding_minor > 0) ? (
        <section className="mt-6 rounded border border-line bg-white p-4">
          <form action={payAction}>
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="key" value={key} />
            <button type="submit" className="w-full rounded bg-primary px-4 py-2 font-medium text-white hover:bg-primary-strong">
              Pay the balance of {formatMoney(b.outstanding_minor, b.currency)}
            </button>
          </form>
        </section>
      ) : null}
    </main>
  );
}
