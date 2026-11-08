import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { answerText, describeRequest, notAllowedChangeText } from "@/lib/guest-site/change";
import { messageForCode } from "@/lib/guest-site/errors";
import { formatDate } from "@/lib/guest-site/format";
import { bookingStatus, changeOptions, verifiedBookingId } from "@/lib/guest-site/server";
import { requestChangeAction, updateContactAction, withdrawChangeAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Change your booking", robots: { index: false, follow: false }, referrer: "no-referrer" };

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const DONE: Record<string, string> = {
  contact: "Your phone number is saved.",
  request: "Your request is with the hotel. They will deal with it and the answer shows on this page. Nothing about your booking has changed yet.",
  withdrawn: "Your request is withdrawn.",
};

const field = "mt-1 w-full rounded border border-line bg-white px-3 py-2";

export default async function ChangePage({ params, searchParams }: Props) {
  const { token } = await params;
  const raw = await searchParams;
  const reservationId = await verifiedBookingId(token);
  if (!reservationId) notFound();
  const [status, options] = await Promise.all([bookingStatus(reservationId), changeOptions(reservationId)]);
  if (!status.ok || !options.ok) notFound();
  const b = status.data;
  const o = options.data;
  const notice = typeof raw.error === "string" ? messageForCode(raw.error) : null;
  const done = typeof raw.done === "string" ? DONE[raw.done] ?? null : null;
  const key = crypto.randomUUID();
  const back = `/booking/${token}`;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <p className="text-sm"><a href={back} className="text-primary-strong underline underline-offset-2">Back to your booking</a></p>
      <p className="mt-4 text-sm text-muted">Booking reference</p>
      <h1 className="font-display text-3xl">{b.booking_reference}</h1>
      <p className="mt-1 text-muted">{b.property_name}, {formatDate(b.arrival_date)} to {formatDate(b.departure_date)}</p>
      {notice ? <p role="alert" className="mt-4 rounded border border-critical/40 bg-white p-3 text-critical">{notice}</p> : null}
      {done ? <p role="status" className="mt-4 rounded border border-primary/40 bg-white p-3 text-primary-strong">{done}</p> : null}

      {!o.allowed ? (
        <p className="mt-6 rounded border border-line bg-white p-4">{notAllowedChangeText(o.why_not, b.status)}</p>
      ) : (
        <>
          <section className="mt-6 rounded border border-line bg-white p-4">
            <h2 className="text-lg font-medium">Your phone number</h2>
            <form action={updateContactAction} className="mt-3 grid gap-2">
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="key" value={key} />
              <label htmlFor="phone" className="block text-sm text-muted">The hotel uses this to reach you about your stay</label>
              <input id="phone" name="phone" type="tel" required maxLength={30} defaultValue={o.phone ?? ""} className={field} />
              <div><button type="submit" className="rounded bg-primary px-4 py-2 font-medium text-white hover:bg-primary-strong">Save phone number</button></div>
            </form>
          </section>

          <section className="mt-6 rounded border border-line bg-white p-4">
            <h2 className="text-lg font-medium">Ask the hotel for a change</h2>
            {o.open_request ? (
              <div className="mt-3 text-sm">
                <p>You have a request waiting. {describeRequest(o.open_request, formatDate)}</p>
                {o.open_request.message ? <p className="mt-1 text-muted">&ldquo;{o.open_request.message}&rdquo;</p> : null}
                <form action={withdrawChangeAction} className="mt-3">
                  <input type="hidden" name="token" value={token} />
                  <input type="hidden" name="key" value={key} />
                  <button type="submit" className="text-sm underline underline-offset-2">Withdraw this request</button>
                </form>
              </div>
            ) : (
              <>
                <p className="mt-2 text-sm text-muted">
                  A request changes nothing by itself. The hotel checks availability and the price, makes the change if they can, and answers here.
                  {o.dates_open ? "" : ` New dates and room changes close ${o.window_hours} hours before arrival; you can still send a message.`}
                </p>
                <form action={requestChangeAction} className="mt-3 grid gap-3">
                  <input type="hidden" name="token" value={token} />
                  <input type="hidden" name="key" value={key} />
                  <div>
                    <label htmlFor="kind" className="block text-sm text-muted">What do you need?</label>
                    <select id="kind" name="kind" defaultValue={o.dates_open ? "dates" : "other"} className={field}>
                      {o.dates_open ? <option value="dates">Different dates</option> : null}
                      {o.dates_open ? <option value="room">A different room</option> : null}
                      <option value="other">Something else</option>
                    </select>
                  </div>
                  {o.dates_open ? (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label htmlFor="arrival" className="block text-sm text-muted">New arrival (for different dates)</label>
                        <input id="arrival" name="arrival" type="date" defaultValue={b.arrival_date} className={field} />
                      </div>
                      <div>
                        <label htmlFor="departure" className="block text-sm text-muted">New departure</label>
                        <input id="departure" name="departure" type="date" defaultValue={b.departure_date} className={field} />
                      </div>
                    </div>
                  ) : null}
                  <div>
                    <label htmlFor="message" className="block text-sm text-muted">Message (needed for a room or other request)</label>
                    <textarea id="message" name="message" rows={3} maxLength={500} className={field} />
                  </div>
                  <div><button type="submit" className="rounded bg-primary px-4 py-2 font-medium text-white hover:bg-primary-strong">Send request</button></div>
                </form>
              </>
            )}
            {o.last_answer && !o.open_request ? <p className="mt-4 rounded border border-line p-3 text-sm">{answerText(o.last_answer)}</p> : null}
          </section>
        </>
      )}
    </main>
  );
}
