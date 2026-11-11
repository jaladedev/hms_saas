import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { guestHotel, requestHost } from "@/lib/guest-site/server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Privacy and terms" };

/**
 * What this booking site does with a guest's details, written from how it actually works (see lib/guest-site): the details a booking
 * needs, a payment provider that takes the card, emails about the booking, a private booking link, and request limits that keep only
 * hashes. It makes no promise the system does not keep (no retention period, no named processors). The hotel should have it reviewed
 * (TODO.md: privacy review) and can then ask for hotel-specific wording.
 */
export default async function PrivacyPage() {
  const hotelResult = await guestHotel(await requestHost());
  if (!hotelResult.ok) notFound();
  const hotel = hotelResult.data;
  const contact = hotel.email ?? hotel.phone ?? null;

  const sections: { title: string; body: React.ReactNode }[] = [
    {
      title: "What we collect",
      body: (
        <p>
          To make a booking at {hotel.name} we ask for your name and email address, and a phone number if you choose to give one. We keep
          the details of your stay (dates, room type, number of guests) and whether it has been paid.
        </p>
      ),
    },
    {
      title: "Payments",
      body: (
        <p>
          You pay on the payment provider&apos;s own page. Your card or bank details are entered there and are not stored on this site. We
          keep the payment&apos;s result and reference so the hotel can match it to your booking.
        </p>
      ),
    },
    {
      title: "Emails",
      body: <p>We email the address you give about your booking, for example a confirmation, or a new booking link if you ask for one.</p>,
    },
    {
      title: "Your booking link",
      body: (
        <p>
          Your booking is opened with a private link. Anyone who has the link can see the booking and use it to manage the booking, so keep
          it to yourself. If you lose it, or think someone else has it, ask for a new one from the page where you find your booking; the old
          link then stops working.
        </p>
      ),
    },
    {
      title: "Protecting the site",
      body: (
        <p>
          To stop automated abuse we limit how often one address can search and book. For this we keep only a scrambled (hashed) value, not
          your address itself. This site does not use advertising or tracking cookies.
        </p>
      ),
    },
    {
      title: "Who can see your details",
      body: <p>Staff at {hotel.name} who need them to look after your stay. We do not sell your details.</p>,
    },
    {
      title: "Your choices",
      body: (
        <p>
          To see, correct or ask us to delete your details, contact the hotel
          {contact ? <>: {contact}.</> : <> through the contact page.</>} Some records may have to be kept, for example for accounts.
        </p>
      ),
    },
    {
      title: "Terms of booking",
      body: (
        <p>
          By booking you agree to the hotel&apos;s{" "}
          <Link href="/policies" className="text-primary underline">
            policies
          </Link>{" "}
          on check-in, payment and cancellation. The total shown before you pay includes taxes.
        </p>
      ),
    },
  ];

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="font-display text-4xl">Privacy and terms</h1>
      <p className="mt-3 text-muted">How {hotel.name} uses your details when you book on this site.</p>
      <div className="mt-8 space-y-4">
        {sections.map((s) => (
          <section key={s.title} className="rounded-2xl border border-line bg-white p-5">
            <h2 className="font-display text-xl">{s.title}</h2>
            <div className="mt-2 space-y-2">{s.body}</div>
          </section>
        ))}
      </div>
    </main>
  );
}
