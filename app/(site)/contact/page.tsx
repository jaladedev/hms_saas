import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { placeLine, timesLine } from "@/lib/guest-site/hotel";
import { messageForCode } from "@/lib/guest-site/errors";
import { MESSAGE_MAX } from "@/lib/guest-site/contact";
import { guestHotel, requestHost } from "@/lib/guest-site/server";
import { sendContactAction } from "./actions";
import { telHref } from "@/lib/staff/hotel-profile";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Contact" };

export default async function ContactPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const notice = typeof raw.error === "string" ? messageForCode(raw.error) : null;
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

      <section aria-labelledby="message-title" className="mt-8 rounded-2xl border border-line bg-white p-6">
        <h2 id="message-title" className="font-display text-2xl">
          Send a message
        </h2>
        <p className="mt-1 text-sm text-muted">The hotel reads messages in its inbox and answers by email or phone.</p>
        {raw.sent === "1" ? (
          <p role="status" className="mt-4 rounded-lg border border-line bg-paper p-3">
            Thank you. Your message was sent and the hotel will get back to you.
          </p>
        ) : null}
        {notice ? (
          <p role="alert" className="mt-4 rounded-lg border border-critical/40 bg-white p-3 text-critical">
            {notice}
          </p>
        ) : null}
        <form action={sendContactAction} className="mt-5 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              Your name
              <input
                name="name"
                required
                minLength={2}
                maxLength={80}
                autoComplete="name"
                className="mt-1 block w-full rounded-lg border border-line px-3 py-2"
              />
            </label>
            <label className="block text-sm">
              Email
              <input
                name="email"
                type="email"
                required
                maxLength={254}
                autoComplete="email"
                className="mt-1 block w-full rounded-lg border border-line px-3 py-2"
              />
            </label>
          </div>
          <label className="block text-sm">
            Message
            <textarea
              name="message"
              required
              minLength={5}
              maxLength={MESSAGE_MAX}
              rows={5}
              className="mt-1 block w-full rounded-lg border border-line px-3 py-2"
            />
          </label>
          <button type="submit" className="rounded-full bg-primary px-6 py-2.5 text-sm font-medium text-white hover:bg-primary-strong">
            Send message
          </button>
        </form>
      </section>
    </main>
  );
}
