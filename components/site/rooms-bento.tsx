import Link from "next/link";
import { PhotoFrame } from "@/components/ui/photo-frame";
import { bentoLayout, capacityLabel, fromPriceLabel } from "@/lib/guest-site/home";
import type { HomeRoomType } from "@/lib/guest-site/server";
import { photoUrl } from "@/lib/staff/room-photos";

/**
 * The homepage rooms section: one wide card with the picture, one dark card in the hotel's colour, then a row of compact
 * cards, ending with a card that points at the search. Every room type appears once, in the order the hotel set, and each
 * links to its own page. Server component: it only draws what it is given.
 */
export function RoomsBento({ types, currency, supa }: { types: HomeRoomType[]; currency: string; supa: string }) {
  const { featured, highlight, small } = bentoLayout(types);
  if (!featured) return null;
  const photo = featured.photos[0];
  const featuredPrice = fromPriceLabel(featured.from_rate_minor, currency);
  const highlightPrice = highlight ? fromPriceLabel(highlight.from_rate_minor, currency) : null;

  return (
    <section id="rooms" aria-labelledby="rooms-title" className="scroll-mt-6 pt-6">
      <h2 id="rooms-title" className="font-display text-3xl">
        Rooms
      </h2>

      <div className={`mt-6 grid gap-5 ${highlight ? "lg:grid-cols-[1.6fr_1fr]" : ""}`}>
        <article className="flex flex-col overflow-hidden rounded-2xl border border-line bg-white sm:flex-row">
          {photo ? (
            <PhotoFrame
              src={photoUrl(supa, photo.path)}
              alt={photo.caption ?? featured.name}
              className="aspect-[4/3] w-full sm:aspect-auto sm:min-h-64 sm:w-1/2"
            />
          ) : null}
          <div className="flex flex-1 flex-col justify-center p-6">
            <h3 className="font-display text-2xl">{featured.name}</h3>
            {featuredPrice ? <p className="mt-1 font-medium text-primary-strong">{featuredPrice}</p> : null}
            {featured.description ? <p className="mt-2 line-clamp-3 text-sm text-muted">{featured.description}</p> : null}
            <p className="mt-2 text-sm text-muted">{capacityLabel(featured.max_occupancy)}</p>
            {featured.amenities.length > 0 ? (
              <ul aria-label={`${featured.name} amenities`} className="mt-3 flex flex-wrap gap-1.5">
                {featured.amenities.slice(0, 4).map((a) => (
                  <li key={a} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted">
                    {a}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Link
                href={`/rooms/${featured.room_type_id}`}
                className="inline-flex min-h-11 items-center justify-center rounded-full border border-ink px-5 text-sm hover:bg-ink hover:text-paper"
              >
                View room
              </Link>
              <a href="#search" className="inline-flex min-h-11 items-center px-3 text-sm text-primary underline underline-offset-2">
                Check dates
              </a>
            </div>
          </div>
        </article>

        {highlight ? (
          <article className="flex flex-col justify-between gap-6 rounded-2xl bg-primary p-6 text-white">
            <div>
              <h3 className="font-display text-3xl">{highlight.name}</h3>
              {highlightPrice ? <p className="mt-2 font-medium">{highlightPrice}</p> : null}
              {highlight.description ? <p className="mt-3 line-clamp-4 text-sm text-white/80">{highlight.description}</p> : null}
              <p className="mt-3 text-sm text-white/80">{capacityLabel(highlight.max_occupancy)}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/rooms/${highlight.room_type_id}`}
                className="inline-flex min-h-11 items-center justify-center rounded-full bg-white px-5 text-sm font-medium text-primary-strong hover:bg-paper"
              >
                View room
              </Link>
              <a href="#search" className="inline-flex min-h-11 items-center px-3 text-sm text-white underline underline-offset-2">
                Check dates
              </a>
            </div>
          </article>
        ) : null}
      </div>

      <ul className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {small.map((t) => {
          const price = fromPriceLabel(t.from_rate_minor, currency);
          return (
            <li key={t.room_type_id}>
              <Link
                href={`/rooms/${t.room_type_id}`}
                className="flex h-full flex-col rounded-2xl border border-line bg-white p-5 hover:border-ink"
              >
                <span className="text-sm text-muted">{capacityLabel(t.max_occupancy)}</span>
                <span className="mt-1 font-medium">{t.name}</span>
                {price ? <span className="mt-1 text-sm text-primary-strong">{price}</span> : null}
              </Link>
            </li>
          );
        })}
        <li className={small.length === 0 ? "sm:col-span-2 lg:col-span-3" : undefined}>
          <a href="#search" className="flex h-full flex-col justify-center rounded-2xl bg-primary/10 p-5 hover:bg-primary/15">
            <span className="text-sm text-muted">Not sure which room?</span>
            <span className="mt-1 font-display text-xl text-primary-strong">Pick your dates</span>
          </a>
        </li>
      </ul>
    </section>
  );
}
