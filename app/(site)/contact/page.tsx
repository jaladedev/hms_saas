import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { placeLine, timesLine } from "@/lib/guest-site/hotel";
import { guestHotel, requestHost } from "@/lib/guest-site/server";
import { telHref } from "@/lib/staff/hotel-profile";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Contact" };

export default async function ContactPage() {
  const hotelResult = await guestHotel(await requestHost());
  if (!hotelResult.ok) notFound();
  const hotel = hotelResult.data;
  const place = placeLine(hotel);
  const rows: { label: string; value: React.ReactNode }[] = [];
  if (place) rows.push({ label: "Address", value: place });
  if (hotel.phone)
    rows.push({
      label: "Phone",
      value: telHref(hotel.phone) ? (
        <a href={telHref(hotel.phone) as string} className="text-primary underline">
          {hotel.phone}
        </a>
      ) : (
        hotel.phone
      ),
    });
  if (hotel.email)
    rows.push({
      label: "Email",
      value: (
        <a href={`mailto:${hotel.email}`} className="break-all text-primary underline">
          {hotel.email}
        </a>
      ),
    });
  rows.push({ label: "Check-in and check-out", value: timesLine(hotel) });

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="font-display text-4xl">Contact</h1>
      <p className="mt-3 text-muted">Get in touch with {hotel.name}.</p>
      {!hotel.phone && !hotel.email ? (
        <p className="mt-6 rounded-2xl border border-line bg-white p-5">
          The hotel has not added a phone number or email address yet. If you have a booking, you can{" "}
          <Link href="/booking/find" className="text-primary underline">
            find it here
          </Link>
          .
        </p>
      ) : null}
      <dl className="mt-8 divide-y divide-line rounded-2xl border border-line bg-white">
        {rows.map((r) => (
          <div key={r.label} className="grid gap-1 p-5 sm:grid-cols-[12rem_1fr]">
            <dt className="text-sm font-medium text-muted">{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
