import { redirect } from "next/navigation";
import { formatDate, formatMoney, formatTime } from "@/lib/guest-site/format";
import { messageForCode } from "@/lib/guest-site/errors";
import { parseStayParams, stayQuery, uuidSchema } from "@/lib/guest-site/params";
import { requestHost, searchAvailability } from "@/lib/guest-site/server";
import { reserveAction } from "./actions";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function Reserve({ searchParams }: Props) {
  const raw = await searchParams;
  const stay = parseStayParams(raw);
  const type = typeof raw.type === "string" && uuidSchema.safeParse(raw.type).success ? raw.type : null;
  if (!stay || !type) redirect("/");

  const result = await searchAvailability(await requestHost(), stay);
  if (!result.ok) redirect(`/?${stayQuery(stay)}`);
  const quote = result.data.room_types.find((t) => t.room_type_id === type);
  if (!quote) redirect(`/?${stayQuery(stay)}&error=unavailable`);

  const notice = typeof raw.error === "string" ? messageForCode(raw.error) : null;
  const maxQty = Math.min(quote.rooms_available, 5);
  const key = crypto.randomUUID();

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <a href={`/?${stayQuery(stay)}`} className="text-sm text-primary underline">Back to rooms</a>
      <h1 className="mt-3 font-display text-3xl">Your reservation</h1>
      {notice ? <p role="alert" className="mt-4 rounded border border-critical/40 bg-white p-3 text-critical">{notice}</p> : null}

      <section className="mt-6 rounded border border-line bg-white p-4">
        <h2 className="font-display text-xl">{quote.name}</h2>
        <p className="mt-1 text-sm text-muted">{result.data.property_name}</p>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <dt className="text-muted">Check in</dt><dd>{formatDate(stay.arrival)}, from {formatTime(result.data.check_in_time)}</dd>
          <dt className="text-muted">Check out</dt><dd>{formatDate(stay.departure)}, by {formatTime(result.data.check_out_time)}</dd>
          <dt className="text-muted">Guests per room</dt><dd>{stay.adults} {stay.adults === 1 ? "adult" : "adults"}{stay.children ? `, ${stay.children} ${stay.children === 1 ? "child" : "children"}` : ""}</dd>
          <dt className="text-muted">Price per room</dt><dd>{formatMoney(quote.total_minor, result.data.currency)} for {result.data.nights} {result.data.nights === 1 ? "night" : "nights"}, taxes included</dd>
        </dl>
      </section>

      <form action={reserveAction} className="mt-6 space-y-4 rounded border border-line bg-white p-4">
        <input type="hidden" name="arrival" value={stay.arrival} />
        <input type="hidden" name="departure" value={stay.departure} />
        <input type="hidden" name="adults" value={stay.adults} />
        <input type="hidden" name="children" value={stay.children} />
        <input type="hidden" name="type" value={type} />
        <input type="hidden" name="key" value={key} />
        {maxQty > 1 ? (
          <label className="block text-sm">Number of rooms
            <select name="quantity" defaultValue="1" className="mt-1 w-full rounded border border-line p-2">
              {Array.from({ length: maxQty }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
            </select>
          </label>
        ) : <input type="hidden" name="quantity" value="1" />}
        <label className="block text-sm">Full name
          <input name="full_name" autoComplete="name" required minLength={2} maxLength={120} className="mt-1 w-full rounded border border-line p-2" />
        </label>
        <label className="block text-sm">Email (your booking link is shown next and can be sent here)
          <input type="email" name="email" autoComplete="email" required maxLength={254} className="mt-1 w-full rounded border border-line p-2" />
        </label>
        <label className="block text-sm">Phone (optional)
          <input type="tel" name="phone" autoComplete="tel" maxLength={32} className="mt-1 w-full rounded border border-line p-2" />
        </label>
        <p className="text-sm text-muted">We hold your room for a short time while you pay. Nothing is charged until you choose to pay on the next page.</p>
        <button type="submit" className="w-full rounded bg-primary px-4 py-2 font-medium text-white hover:bg-primary-strong">Hold my room</button>
      </form>
    </main>
  );
}
