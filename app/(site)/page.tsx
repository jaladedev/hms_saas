import Link from "next/link";
import { formatMoney } from "@/lib/guest-site/format";
import { telHref } from "@/lib/staff/hotel-profile";
import { photoUrl } from "@/lib/staff/room-photos";
import { PhotoFrame } from "@/components/ui/photo-frame";
import { messageForCode } from "@/lib/guest-site/errors";
import { averageLabel, ratingText, reviewMonth } from "@/lib/guest-site/reviews";
import { parseStayParams, stayQuery } from "@/lib/guest-site/params";
import { checkGuestLimits } from "@/lib/guest-site/limits";
import { amenityOptions, nightlyBreakdown, parseResultsView, SORT_LABELS, soldOutTypes, viewQuotes } from "@/lib/guest-site/results";
import { facilityList, photoCountLabel, placeLine, socialLinks, timesLine } from "@/lib/guest-site/hotel";
import {
  amenityHighlights,
  capacityLabel,
  freeCancellationBadge,
  fromPriceLabel,
  offerUntilLabel,
  onlyChosenType,
} from "@/lib/guest-site/home";
import {
  guestHotel,
  guestOffers,
  guestPolicy,
  guestReviews,
  guestRoomTypes,
  requestHost,
  searchAvailability,
} from "@/lib/guest-site/server";
import { PendingButton } from "@/components/ui/pending-button";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const field = "mt-1 w-full rounded-lg border border-line bg-white p-2.5";
const label = "text-xs font-medium uppercase tracking-wider text-muted";

export default async function GuestHome({ searchParams }: Props) {
  const raw = await searchParams;
  const stay = parseStayParams(raw);
  const limited = stay ? !(await checkGuestLimits({ ip: ["search"] })).allowed : false;
  const host = await requestHost();
  const [result, hotelResult, typesResult, policyResult, offersResult, reviewsResult] = await Promise.all([
    stay && !limited ? searchAvailability(host, stay) : null,
    guestHotel(host),
    guestRoomTypes(host),
    guestPolicy(host),
    guestOffers(host),
    guestReviews(host),
  ]);
  const hotel = hotelResult.ok ? hotelResult.data : null;
  const types = typesResult.ok ? typesResult.data.room_types : [];
  const currency = typesResult.ok ? typesResult.data.currency : "NGN";
  const place = hotel ? placeLine(hotel) : "";
  const today = new Date().toISOString().slice(0, 10);
  const notice = typeof raw.error === "string" ? messageForCode(raw.error) : null;
  const chosen = typeof raw.type === "string" ? raw.type : undefined;
  const view = parseResultsView(raw);
  const inChosen = stay && result?.ok ? onlyChosenType(result.data.room_types, chosen) : [];
  const shown = viewQuotes(inChosen, view);
  const amenityChoices = amenityOptions(inChosen);
  const soldOut =
    stay && result?.ok
      ? soldOutTypes(chosen ? onlyChosenType(types, chosen) : types, result.data.room_types, stay.adults, stay.children)
      : [];
  const supa = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const highlights = amenityHighlights(types, 6);
  const cancelBadge = policyResult.ok ? freeCancellationBadge(policyResult.data) : null;
  const offers = offersResult.ok ? offersResult.data.offers : [];
  const reviews = reviewsResult.ok ? reviewsResult.data : null;
  const summary = reviews ? averageLabel(reviews.average, reviews.count) : null;
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
          {hotel && socialLinks(hotel).length > 0 ? (
            <p className="mt-2 flex flex-wrap gap-x-4 text-sm">
              {socialLinks(hotel).map((l) => (
                <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                  {l.label}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ))}
            </p>
          ) : null}
          {hotel && facilityList(hotel).length > 0 ? (
            <div className="mt-6">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted">At the hotel</h2>
              <ul className="mt-2 flex flex-wrap gap-2">
                {facilityList(hotel).map((f) => (
                  <li key={f} className="rounded-full border border-line bg-white px-3 py-1 text-xs">
                    {f}
                  </li>
                ))}
              </ul>
            </div>
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
            <PendingButton
              className="col-span-2 rounded-full bg-primary px-4 py-3 font-medium text-white hover:bg-primary-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              pendingLabel="Checking…"
            >
              Check availability
            </PendingButton>
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
            {inChosen.length > 1 || view.minGuests > 0 || view.amenity ? (
              <form action="/" method="get" className="mt-3 flex flex-wrap items-end gap-3 text-sm">
                <input type="hidden" name="arrival" value={stay.arrival} />
                <input type="hidden" name="departure" value={stay.departure} />
                <input type="hidden" name="adults" value={stay.adults} />
                <input type="hidden" name="children" value={stay.children} />
                {chosen ? <input type="hidden" name="type" value={chosen} /> : null}
                <label className="block">
                  <span className="block text-xs text-muted">Sort</span>
                  <select name="sort" defaultValue={view.sort} className="mt-1 rounded-lg border border-line bg-white p-2">
                    {Object.entries(SORT_LABELS).map(([value, text]) => (
                      <option key={value} value={value}>
                        {text}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="block text-xs text-muted">Sleeps at least</span>
                  <select name="guests" defaultValue={view.minGuests || ""} className="mt-1 rounded-lg border border-line bg-white p-2">
                    <option value="">Any</option>
                    {[2, 3, 4, 5, 6].map((n) => (
                      <option key={n} value={n}>
                        {n} guests
                      </option>
                    ))}
                  </select>
                </label>
                {amenityChoices.length > 0 ? (
                  <label className="block">
                    <span className="block text-xs text-muted">Amenity</span>
                    <select name="amenity" defaultValue={view.amenity ?? ""} className="mt-1 rounded-lg border border-line bg-white p-2">
                      <option value="">Any</option>
                      {amenityChoices.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <PendingButton
                  className="min-h-11 rounded-full border border-ink px-5 hover:bg-ink hover:text-paper"
                  pendingLabel="Applying…"
                >
                  Apply
                </PendingButton>
              </form>
            ) : null}
            {shown.length === 0 ? (
              <p className="mt-3 text-muted">
                {inChosen.length === 0
                  ? "No rooms are available for those dates and guests. Try different dates."
                  : "No rooms match those filters. Try fewer filters."}
              </p>
            ) : (
              <ul className="mt-4 space-y-4">
                {shown.map((t) => (
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
                                  <PhotoFrame
                                    src={photoUrl(supa, ph.path)}
                                    alt={ph.caption ?? `${t.name} photo`}
                                    className="h-28 w-40 rounded border border-line"
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
                        <p className="mt-1 text-xs text-muted">{nightlyBreakdown(t, result.data.currency)}</p>
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
            {soldOut.length > 0 ? (
              <ul aria-label="Not available for these dates" className="mt-4 space-y-3">
                {soldOut.map((t) => (
                  <li
                    key={t.room_type_id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-white/60 p-4 text-muted"
                  >
                    <div>
                      <h3 className="font-display text-xl text-ink">{t.name}</h3>
                      <p className="mt-1 text-sm">Not available for these dates</p>
                    </div>
                    <Link href={`/rooms/${t.room_type_id}`} className="text-sm text-primary underline underline-offset-2">
                      View room
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {!searching && offers.length > 0 ? (
          <section aria-labelledby="offers-title" className="pt-6">
            <h2 id="offers-title" className="font-display text-3xl">
              Offers
            </h2>
            <ul className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {offers.map((o, i) => {
                const until = offerUntilLabel(o.valid_to);
                return (
                  <li key={i} className="flex flex-col gap-2 rounded-2xl border border-line bg-white p-5">
                    {o.badge ? (
                      <span className="w-fit rounded-full bg-primary px-3 py-0.5 text-xs font-medium text-white">{o.badge}</span>
                    ) : null}
                    <h3 className="font-display text-xl">{o.title}</h3>
                    {o.body ? <p className="text-sm text-muted">{o.body}</p> : null}
                    {until ? <p className="mt-auto pt-2 text-xs text-muted">{until}</p> : null}
                  </li>
                );
              })}
            </ul>
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
                      <PhotoFrame src={photoUrl(supa, photo.path)} alt={photo.caption ?? `${t.name}`} className="aspect-[4/3] w-full" />
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
                      <div className="mt-5 flex flex-wrap gap-2">
                        <Link
                          href={`/rooms/${t.room_type_id}`}
                          className="inline-flex min-h-11 items-center justify-center rounded-full border border-ink px-5 text-sm hover:bg-ink hover:text-paper"
                        >
                          View room
                        </Link>
                        <a
                          href="#search"
                          className="inline-flex min-h-11 items-center justify-center rounded-full px-3 text-sm text-primary underline underline-offset-2"
                        >
                          Check dates
                        </a>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {!searching && reviews && reviews.reviews.length > 0 ? (
          <section aria-labelledby="reviews-title" className="pt-6">
            <h2 id="reviews-title" className="font-display text-3xl">
              Guest reviews
            </h2>
            {summary ? <p className="mt-1 text-sm text-muted">{summary}</p> : null}
            <ul className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {reviews.reviews.map((r, i) => (
                <li key={i} className="flex flex-col gap-2 rounded-2xl border border-line bg-white p-5">
                  <p aria-label={ratingText(r.rating)} className="text-lg tracking-wide text-primary">
                    <span aria-hidden="true">
                      {"★".repeat(r.rating)}
                      {"☆".repeat(5 - r.rating)}
                    </span>
                  </p>
                  {r.comment ? <p className="whitespace-pre-line text-sm">{r.comment}</p> : null}
                  <p className="mt-auto pt-2 text-xs text-muted">
                    {r.author}
                    {reviewMonth(r.month) ? `, ${reviewMonth(r.month)}` : ""}
                  </p>
                </li>
              ))}
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
