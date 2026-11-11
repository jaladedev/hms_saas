import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { messageForCode } from "@/lib/guest-site/errors";
import { formatDate } from "@/lib/guest-site/format";
import { MAX_REVIEW_COMMENT, ratingText } from "@/lib/guest-site/reviews";
import { bookingStatus, reviewState, verifiedBookingId } from "@/lib/guest-site/server";
import { reviewAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Review your stay", robots: { index: false, follow: false }, referrer: "no-referrer" };

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ReviewPage({ params, searchParams }: Props) {
  const { token } = await params;
  const raw = await searchParams;
  const reservationId = await verifiedBookingId(token);
  if (!reservationId) notFound();
  const [status, state] = await Promise.all([bookingStatus(reservationId), reviewState(reservationId)]);
  if (!status.ok || !state.ok) notFound();
  const b = status.data;
  const s = state.data;
  const notice = typeof raw.error === "string" ? messageForCode(raw.error) : null;
  const back = `/booking/${token}`;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <p className="text-sm">
        <a href={back} className="text-primary-strong underline underline-offset-2">
          Back to your booking
        </a>
      </p>
      <h1 className="mt-4 font-display text-3xl">Review your stay</h1>
      <p className="mt-1 text-muted">
        {b.property_name}, {formatDate(b.arrival_date)} to {formatDate(b.departure_date)}
      </p>
      {notice ? (
        <p role="alert" className="mt-4 rounded border border-critical/40 bg-white p-3 text-critical">
          {notice}
        </p>
      ) : null}

      {s.review ? (
        <section className="mt-6 rounded border border-line bg-white p-4">
          <h2 className="text-lg font-medium">Thank you for your review</h2>
          <p className="mt-2 text-sm">Your rating: {ratingText(s.review.rating)}</p>
          {s.review.comment ? <p className="mt-2 whitespace-pre-line text-sm">{s.review.comment}</p> : null}
          <p className="mt-3 text-xs text-muted">
            {s.review.status === "approved"
              ? "It is shown on the hotel's website."
              : s.review.status === "rejected"
                ? "The hotel has chosen not to show it on its website."
                : "The hotel will look at it before it is shown on the website."}
          </p>
        </section>
      ) : s.can_review ? (
        <form action={reviewAction} className="mt-6 rounded border border-line bg-white p-4">
          <input type="hidden" name="token" value={token} />
          <fieldset>
            <legend className="text-sm font-medium">How was your stay?</legend>
            <div className="mt-2 flex flex-wrap gap-4">
              {[5, 4, 3, 2, 1].map((n) => (
                <label key={n} htmlFor={`rating-${n}`} className="flex items-center gap-1.5 text-sm">
                  <input id={`rating-${n}`} type="radio" name="rating" value={n} required className="accent-primary" />
                  {n} {n === 1 ? "star" : "stars"}
                </label>
              ))}
            </div>
          </fieldset>
          <label htmlFor="comment" className="mt-4 block text-sm font-medium">
            Your comments (optional)
          </label>
          <textarea
            id="comment"
            name="comment"
            rows={5}
            maxLength={MAX_REVIEW_COMMENT}
            className="mt-1 w-full rounded border border-line bg-white p-2 text-sm"
          />
          <p className="mt-2 text-xs text-muted">
            The hotel checks reviews before they appear on its website. Only your first name and the first letter of your last name are
            shown.
          </p>
          <button type="submit" className="mt-4 rounded bg-primary px-4 py-2 font-medium text-white hover:bg-primary-strong">
            Send review
          </button>
        </form>
      ) : (
        <p className="mt-6 text-sm text-muted">You can write a review after your stay, once you have checked out.</p>
      )}
    </main>
  );
}
