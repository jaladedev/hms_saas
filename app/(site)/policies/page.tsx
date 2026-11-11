import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatMoney } from "@/lib/guest-site/format";
import { timesLine } from "@/lib/guest-site/hotel";
import { guestHotel, guestPolicy, requestHost } from "@/lib/guest-site/server";
import { guestCancellationLines, guestPaymentLines, readConfig } from "@/lib/staff/policies";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Hotel policies" };

/** What a guest agrees to by booking: check-in and check-out, how to pay, and what cancelling costs. All of it is the hotel's own settings. */
export default async function PoliciesPage() {
  const host = await requestHost();
  const [hotelResult, policyResult] = await Promise.all([guestHotel(host), guestPolicy(host)]);
  if (!hotelResult.ok || !policyResult.ok) notFound();
  const hotel = hotelResult.data;
  const cfg = readConfig(policyResult.data);
  const money = (minor: number) => formatMoney(minor, policyResult.data.currency);

  const sections: { id: string; title: string; lines: string[] }[] = [
    { id: "check-in", title: "Check-in and check-out", lines: [timesLine(hotel)] },
    { id: "payment", title: "Payment", lines: guestPaymentLines(cfg) },
    { id: "cancellation", title: "Cancellation", lines: guestCancellationLines(cfg, money) },
  ];

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="font-display text-4xl">Hotel policies</h1>
      <p className="mt-3 text-muted">The terms that apply to a booking at {hotel.name}. They are shown again before you pay.</p>
      <div className="mt-8 space-y-4">
        {sections.map((s) => (
          <section key={s.id} aria-labelledby={`${s.id}-title`} className="rounded-2xl border border-line bg-white p-5">
            <h2 id={`${s.id}-title`} className="font-display text-xl">
              {s.title}
            </h2>
            <ul className="mt-3 space-y-2">
              {s.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="mt-6 text-sm text-muted">
        Questions? See the{" "}
        <Link href="/contact" className="text-primary underline">
          contact page
        </Link>
        .
      </p>
    </main>
  );
}
