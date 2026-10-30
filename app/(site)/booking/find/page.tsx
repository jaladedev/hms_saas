import type { Metadata } from "next";
import { messageForCode } from "@/lib/guest-site/errors";
import { requestLinkAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Find my booking", robots: { index: false, follow: false } };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function FindBooking({ searchParams }: Props) {
  const raw = await searchParams;
  const notice = typeof raw.error === "string" ? messageForCode(raw.error) : null;
  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <h1 className="font-display text-3xl">Find my booking</h1>
      <p className="mt-2 text-sm text-muted">Enter your booking reference and the email you booked with. We will email you a new link.</p>
      {notice ? <p role="alert" className="mt-4 rounded border border-critical/40 bg-white p-3 text-critical">{notice}</p> : null}
      {raw.sent === "1" ? (
        <p role="status" className="mt-4 rounded border border-primary/40 bg-white p-3 text-primary-strong">
          If a booking matches, we have emailed a new link to that address. It may take a minute to arrive.
        </p>
      ) : null}
      <form action={requestLinkAction} className="mt-6 space-y-4 rounded border border-line bg-white p-4">
        <label className="block text-sm">Booking reference
          <input name="reference" required minLength={4} maxLength={40} autoComplete="off" placeholder="BK-XXXXXXXX" className="mt-1 w-full rounded border border-line p-2" />
        </label>
        <label className="block text-sm">Email
          <input type="email" name="email" required maxLength={254} autoComplete="email" className="mt-1 w-full rounded border border-line p-2" />
        </label>
        <button type="submit" className="w-full rounded bg-primary px-4 py-2 font-medium text-white hover:bg-primary-strong">Email me a new link</button>
      </form>
    </main>
  );
}
