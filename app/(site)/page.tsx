import { formatMoney } from "@/lib/guest-site/format";
import { telHref } from "@/lib/staff/hotel-profile";
import { photoUrl } from "@/lib/staff/room-photos";
import { messageForCode } from "@/lib/guest-site/errors";
import { parseStayParams, stayQuery } from "@/lib/guest-site/params";
import { checkGuestLimits } from "@/lib/guest-site/limits";
import { photoCountLabel, placeLine, timesLine } from "@/lib/guest-site/hotel";
import { amenityHighlights, capacityLabel, freeCancellationBadge, fromPriceLabel, onlyChosenType } from "@/lib/guest-site/home";
import { guestHotel, guestPolicy, guestRoomTypes, requestHost, searchAvailability } from "@/lib/guest-site/server";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const field = "mt-1 w-full rounded-lg border border-line bg-white p-2.5";
const label = "text-xs font-medium uppercase tracking-wider text-muted";

export default async function GuestHome({ searchParams }: Props) {
  const raw = await searchParams;
  const stay = parseStayParams(raw);
  const limited = stay ? !(await checkGuestLimits({ ip: ["search"] })).allowed : false;
  const host = await requestHost();
  const [result, hotelResult, typesResult, policyResult] = await Promise.all([
    stay && !limited ? searchAvailability(host, stay) : null,
    guestHotel(host),
    guestRoomTypes(host),
    guestPolicy(host),
  ]);
  const hotel = hotelResult.ok ? hotelResult.data : null;
  const types = typesResult.ok ? typesResult.data.room_types : [];
  const currency = typesResult.ok ? typesResult.data.currency : "NGN";
  const place = hotel ? placeLine(hotel) : "";
  const today = new Date().toISOString().slice(0, 10);
  const notice = typeof raw.error === "string" ? messageForCode(raw.error) : null;
  const chosen = typeof raw.type === "string" ? raw.type : undefined;
  const supa = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const highlights = amenityHighlights(types, 6);
  const cancelBadge = policyResult.ok ? freeCancellationBadge(policyResult.data) : null;
  const searching = Boolean(stay && result?.ok);
  const anyPhoto = types.some((t) => t.photos.length > 0); // no empty grey blocks when the hotel has not added pictures yet

  return (
    <main>
      <section className="mx-auto grid max-w-6xl gap-10 px-4 py-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:py-16">
        <div>
          {place ? (
            <p className="inline-flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1 text-xs uppercase tracking-wider text-muted">
              <span aria-hidden="true" className="h-2 w-2 rounded-full bg-primary" />
              {place}
            </p>
          ) : null}
          <h1 className="mt-5 font-display text-4xl leading-tight sm:text-5xl lg:text-6xl">{hotel ? hotel.name : "Book your stay"}</h1>
          {hotel?.intro ? <p className="mt-5 max-w-prose text-lg text-muted">{hotel.intro}</p> : null}
          {hotel && (hotel.phone || hotel.email) ? (
            <p className="mt-2 text-sm text-muted">
              {hotel.phone ? (
                telHref(hotel.phone) ? (
                  <a href={telHref(hotel.phone) as string} className="text-primary underline">
                    {hotel.phone}
                  </a>
                ) : (
                  hotel.phone
                )
              ) : null}
              {hotel.phone && hotel.email ? " · " : null}
              {hotel.email ? (
                <a href={`mailto:${hotel.email}`} className="text-primary underline">
                  {hotel.email}
                </a>
              ) : null}
            </p>
          ) : null}
          {highlights.length > 0 ? (
            <ul aria-label="Amenities" className="mt-6 flex flex-wrap gap-2">
              {highlights.map((a) => (
                <li key={a} className="rounded-full border border-line bg-white px-3 py-1 text-xs">
                  {a}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {hotel ? (
          <form
            id="search"
            action="/"
            method="get"
            className="grid grid-cols-2 gap-4 rounded-2xl border border-line bg-white p-5 shadow-lg sm:p-6"
          >
            <h2 className="col-span-2 font-display text-xl">Find a room</h2>
            <label className={`${label} col-span-1`}>
              Check in
              <input
                type="date"
                name="arrival"
                min={today}
                defaultValue={stay?.arrival}
                required
                className={`${field} text-base normal-case tracking-normal text-ink`}
              />
            </label>
            <label className={`${label} col-span-1`}>
              Check out
              <input
                type="date"
                name="departure"
                min={today}
                defaultValue={stay?.departure}
                required
                className={`${field} text-base normal-case tracking-normal text-ink`}
              />
            </label>
            <label className={label}>
              Adults
              <input
                type="number"
                name="adults"
                min={1}
                max={20}
                defaultValue={stay?.adults ?? 2}
                required
                className={`${field} text-base normal-case tracking-normal text-ink`}
              />
            </label>
            <label className={label}>
              Children
              <input
                type="number"
                name="children"
                min={0}
                max={20}
                defaultValue={stay?.children ?? 0}
                className={`${field} text-base normal-case tracking-normal text-ink`}
              />
            </label>
            {types.length > 1 ? (
              <label className={`${label} col-span-2`}>
                Room
                <select name="type" defaultValue={chosen ?? ""} className={`${field} text-base normal-case tracking-normal text-ink`}>
                  <option value="">Any type</option>
                  {types.map((t) => (
                    <option key={t.room_type_id} value={t.room_type_id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <button
              type="submit"
              className="col-span-2 rounded-full bg-primary px-4 py-3 font-medium text-white hover:bg-primary-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Check availability
            </button>
            <p className="col-span-2 text-center text-xs text-muted">Prices in {currency}. Taxes are shown before you pay.</p>
          </form>
        ) : null}
      </section>

      <div className="mx-auto max-w-6xl px-4">
        {!hotel && !hotelResult.ok ? (
          <p role="alert" className="rounded-lg border border-line bg-white p-4 text-critical">
            {hotelResult.error.message}
          </p>
        ) : null}
        {notice ? (
          <p role="alert" className="mt-4 rounded-lg border border-critical/40 bg-white p-3 text-critical">
            {notice}
          </p>
        ) : null}
        {limited ? (
          <p role="alert" className="mt-6 text-critical">
            {messageForCode("rate_limited")}
          </p>
        ) : null}
        {raw.arrival && !stay ? <p className="mt-6 text-critical">Please check your dates and guest numbers.</p> : null}
        {result && !result.ok ? (
          <p role="alert" className="mt-6 text-critical">
            {result.error.message}
          </p>
        ) : null}

        {stay && result?.ok ? (
          <section className="mx-auto max-w-3xl" aria-live="polite">
            <h2 className="text-lg font-medium">
              {result.data.property_name}: {result.data.nights} {result.data.nights === 1 ? "night" : "nights"}
            </h2>
            {onlyChosenType(result.data.room_types, chosen).length === 0 ? (
              <p className="mt-3 text-muted">No rooms are available for those dates and guests. Try different dates.</p>
            ) : (
              <ul className="mt-4 space-y-4">
                {onlyChosenType(result.data.room_types, chosen).map((t) => (
                  <li key={t.room_type_id} className="rounded-xl border border-line bg-white p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="font-display text-xl">{t.name}</h3>
                        {t.description ? <p className="mt-1 text-sm text-muted">{t.description}</p> : null}
                        {t.photos && t.photos.length > 0 ? (
                          <>
                            <ul aria-label="Photos" className="mt-2 flex gap-2 overflow-x-auto">
                              {t.photos.map((ph) => (
                                <li key={ph.path} className="shrink-0">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={photoUrl(supa, ph.path)}
                                    alt={ph.caption ?? `${t.name} photo`}
                                    loading="lazy"
                                    className="h-28 w-40 rounded border border-line object-cover"
                                  />
                                </li>
                              ))}
                            </ul>
                            <p className="mt-1 text-xs text-muted">{photoCountLabel(t.photos.length)}</p>
                          </>
                        ) : null}
                        {t.amenities && t.amenities.length > 0 ? (
                          <ul aria-label="Amenities" className="mt-2 flex flex-wrap gap-1.5">
                            {t.amenities.map((a) => (
                              <li key={a} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted">
                                {a}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        <p className="mt-2 text-sm text-muted">
                          Up to {t.max_occupancy} guests{t.rooms_available <= 3 ? ` · only ${t.rooms_available} left` : ""}
                        </p>
                      </div>
                      <div className="ml-auto text-right">
                        <p className="text-xl font-medium">{formatMoney(t.total_minor, result.data.currency)}</p>
                        <p className="text-xs text-muted">total, taxes included</p>
                        <a
                          href={`/reserve?${stayQuery(stay)}&type=${t.room_type_id}`}
                          className="mt-3 inline-block rounded-full bg-primary px-5 py-2 text-sm font-medium text-white hover:bg-primary-strong"
                        >
                          Reserve
                        </a>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {!searching && types.length > 0 ? (
          <section id="rooms" aria-labelledby="rooms-title" className="scroll-mt-6 pt-6">
            <h2 id="rooms-title" className="font-display text-3xl">
              Rooms
            </h2>
            <ul className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {types.map((t) => {
                const price = fromPriceLabel(t.from_rate_minor, currency);
                const photo = t.photos[0];
                return (
                  <li key={t.room_type_id} className="flex flex-col overflow-hidden rounded-2xl border border-line bg-white">
                    {photo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={photoUrl(supa, photo.path)}
                        alt={photo.caption ?? `${t.name}`}
                        loading="lazy"
                        className="aspect-[4/3] w-full object-cover"
                      />
                    ) : anyPhoto ? (
                      <div aria-hidden="true" className="aspect-[4/3] w-full bg-line/40" />
                    ) : null}
                    <div className="flex flex-1 flex-col p-5">
                      <h3 className="font-display text-2xl">{t.name}</h3>
                      {price ? <p className="mt-1 font-medium text-primary-strong">{price}</p> : null}
                      {t.description ? <p className="mt-2 line-clamp-3 text-sm text-muted">{t.description}</p> : null}
                      {t.amenities.length > 0 ? (
                        <ul aria-label={`${t.name} amenities`} className="mt-3 flex flex-wrap gap-1.5">
                          {t.amenities.slice(0, 4).map((a) => (
                            <li key={a} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted">
                              {a}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <p className="mt-3 text-sm text-muted">{capacityLabel(t.max_occupancy)}</p>
                      <a
                        href="#search"
                        className="mt-5 inline-flex min-h-11 items-center justify-center self-start rounded-full border border-ink px-5 text-sm hover:bg-ink hover:text-paper"
                      >
                        Check dates
                      </a>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {hotel ? (
          <ul aria-label="Good to know" className="mt-10 flex flex-wrap gap-2 text-sm">
            <li className="rounded-full border border-line bg-white px-4 py-2">{timesLine(hotel)}</li>
            {cancelBadge ? <li className="rounded-full border border-line bg-white px-4 py-2">{cancelBadge}</li> : null}
          </ul>
        ) : null}
      </div>
    </main>
  );
}
