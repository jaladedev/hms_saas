import { formatMoney } from "@/lib/guest-site/format";
import { messageForCode } from "@/lib/guest-site/errors";
import { parseStayParams, stayQuery } from "@/lib/guest-site/params";
import { requestHost, searchAvailability } from "@/lib/guest-site/server";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function GuestHome({ searchParams }: Props) {
  const raw = await searchParams;
  const stay = parseStayParams(raw);
  const result = stay ? await searchAvailability(await requestHost(), stay) : null;
  const today = new Date().toISOString().slice(0, 10);
  const notice = typeof raw.error === "string" ? messageForCode(raw.error) : null;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="font-display text-3xl">Find a room</h1>
      {notice ? <p role="alert" className="mt-4 rounded border border-critical/40 bg-white p-3 text-critical">{notice}</p> : null}

      <form action="/" method="get" className="mt-6 grid grid-cols-2 gap-4 rounded border border-line bg-white p-4 sm:grid-cols-4">
        <label className="text-sm">Check in
          <input type="date" name="arrival" min={today} defaultValue={stay?.arrival} required className="mt-1 w-full rounded border border-line p-2" />
        </label>
        <label className="text-sm">Check out
          <input type="date" name="departure" min={today} defaultValue={stay?.departure} required className="mt-1 w-full rounded border border-line p-2" />
        </label>
        <label className="text-sm">Adults
          <input type="number" name="adults" min={1} max={20} defaultValue={stay?.adults ?? 2} required className="mt-1 w-full rounded border border-line p-2" />
        </label>
        <label className="text-sm">Children
          <input type="number" name="children" min={0} max={20} defaultValue={stay?.children ?? 0} className="mt-1 w-full rounded border border-line p-2" />
        </label>
        <button type="submit" className="col-span-2 rounded bg-primary px-4 py-2 font-medium text-white hover:bg-primary-strong sm:col-span-4">Search</button>
      </form>

      {raw.arrival && !stay ? <p className="mt-6 text-critical">Please check your dates and guest numbers.</p> : null}
      {result && !result.ok ? <p role="alert" className="mt-6 text-critical">{result.error.message}</p> : null}

      {stay && result?.ok ? (
        <section className="mt-8" aria-live="polite">
          <h2 className="text-lg font-medium">{result.data.property_name}: {result.data.nights} {result.data.nights === 1 ? "night" : "nights"}</h2>
          {result.data.room_types.length === 0 ? (
            <p className="mt-3 text-muted">No rooms are available for those dates and guests. Try different dates.</p>
          ) : (
            <ul className="mt-4 space-y-4">
              {result.data.room_types.map((t) => (
                <li key={t.room_type_id} className="rounded border border-line bg-white p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-display text-xl">{t.name}</h3>
                      {t.description ? <p className="mt-1 text-sm text-muted">{t.description}</p> : null}
                      <p className="mt-2 text-sm text-muted">Up to {t.max_occupancy} guests{t.rooms_available <= 3 ? ` · only ${t.rooms_available} left` : ""}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xl font-medium">{formatMoney(t.total_minor, result.data.currency)}</p>
                      <p className="text-xs text-muted">total, taxes included</p>
                      <a href={`/reserve?${stayQuery(stay)}&type=${t.room_type_id}`}
                         className="mt-3 inline-block rounded bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-strong">Reserve</a>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </main>
  );
}
