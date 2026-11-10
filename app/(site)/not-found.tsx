import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Page not found", robots: { index: false, follow: false } };

/**
 * Shown when a booking link is expired, mistyped or never existed (the booking page calls notFound()).
 * It does not say which of those it was, so it cannot be used to probe for valid booking links.
 */
export default function SiteNotFound() {
  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <h1 className="font-display text-3xl">We could not find that page</h1>
      <p className="mt-3 text-muted">
        The link may have expired or been copied incompletely. If you have booked with us, we can email you a new link to your booking.
      </p>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Link href="/booking/find" className="rounded bg-primary px-4 py-2 text-center font-medium text-white hover:bg-primary-strong">
          Find my booking
        </Link>
        <Link href="/" className="rounded border border-line bg-white px-4 py-2 text-center font-medium hover:bg-line/30">
          Start a new search
        </Link>
      </div>
    </main>
  );
}
