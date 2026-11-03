import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { verifyBookingToken } from "@/lib/booking-token";
import { serverEnv } from "@/lib/env";
import { cancelSummary, notAllowedText } from "@/lib/guest-site/cancel";
import { messageForCode } from "@/lib/guest-site/errors";
import { formatDate, formatMoney } from "@/lib/guest-site/format";
import { bookingStatus, cancelPreview } from "@/lib/guest-site/server";
import { cancelAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cancel your booking", robots: { index: false, follow: false }, referrer: "no-referrer" };

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function CancelPage({ params, searchParams }: Props) {
  const { token } = await params;
  const raw = await searchParams;
  const reservationId = verifyBookingToken(token, serverEnv().BOOKING_TOKEN_SECRET);
  if (!reservationId) notFound();
  const [status, preview] = await Promise.all([bookingStatus(reservationId), cancelPreview(reservationId)]);
  if (!status.ok || !preview.ok) notFound();
  const b = status.data;
  const p = preview.data;
  const notice = typeof raw.error === "string" ? messageForCode(raw.error) : null;
  const summary = p.allowed ? cancelSummary(p, formatMoney) : null;
  const key = crypto.randomUUID();
  const back = `/booking/${token}`;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <p className="text-sm"><a href={back} className="text-primary-strong underline underline-offset-2">Back to your booking</a></p>
      <p className="mt-4 text-sm text-muted">Booking reference</p>
      <h1 className="font-display text-3xl">{b.booking_reference}</h1>
      <p className="mt-1 text-muted">{b.property_name}, {formatDate(b.arrival_date)} to {formatDate(b.departure_date)}</p>
      {notice ? <p role="alert" className="mt-4 rounded border border-critical/40 bg-white p-3 text-critical">{notice}</p> : null}

      {summary ? (
        <section className="mt-6 rounded border border-line bg-white p-4">
          <h2 className="text-lg font-medium">{summary.headline}</h2>
          {summary.lines.map((line, i) => <p key={i} className="mt-2 text-sm">{line}</p>)}
          <form action={cancelAction} className="mt-5 flex flex-wrap items-center gap-4">
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="key" value={key} />
            <input type="hidden" name="charge" value={String(p.charge_minor)} />
            <button type="submit" className="rounded bg-critical px-4 py-2 font-medium text-white">Cancel this booking</button>
            <a href={back} className="text-sm underline underline-offset-2">Keep my booking</a>
          </form>
        </section>
      ) : (
        <p className="mt-6 rounded border border-line bg-white p-4">{notAllowedText(p.why_not)}</p>
      )}
    </main>
  );
}
