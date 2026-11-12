import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PhotoFrame } from "@/components/ui/photo-frame";
import { capacityLabel, freeCancellationBadge, fromPriceLabel, nightDayLabel, nightPriceLabel } from "@/lib/guest-site/home";
import { timesLine } from "@/lib/guest-site/hotel";
import { uuidSchema } from "@/lib/guest-site/params";
import { guestHotel, guestPolicy, guestRoomType, requestHost } from "@/lib/guest-site/server";
import { photoUrl } from "@/lib/staff/room-photos";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Room details" };

type Props = { params: Promise<{ roomTypeId: string }> };

const field = "mt-1 w-full rounded-lg border border-line bg-white p-2.5 text-base";
const label = "text-xs font-medium uppercase tracking-wider text-muted";

/** One room type in full: every picture, what is in the room, who it sleeps, what a night costs over the next two weeks, and a way to book it. */
export default async function RoomDetails({ params }: Props) {
  const { roomTypeId } = await params;
  if (!uuidSchema.safeParse(roomTypeId).success) notFound();
  const host = await requestHost();
  const [roomResult, hotelResult, policyResult] = await Promise.all([guestRoomType(host, roomTypeId), guestHotel(host), guestPolicy(host)]);
  if (!roomResult.ok) notFound();
  const { currency, room_type: room, nights } = roomResult.data;
  const hotel = hotelResult.ok ? hotelResult.data : null;
  const supa = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const price = fromPriceLabel(room.from_rate_minor, currency);
  const cancel = policyResult.ok ? freeCancellationBadge(policyResult.data) : null;
  const today = nights[0]?.date;
  const [hero, ...rest] = room.photos;
  const guests = `${room.max_adults} ${room.max_adults === 1 ? "adult" : "adults"}${room.max_children > 0 ? `, ${room.max_children} ${room.max_children === 1 ? "child" : "children"}` : ""}`;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/#rooms" className="text-primary underline underline-offset-2">
          All rooms
        </Link>
      </nav>

      <div className="mt-5 grid gap-8 lg:grid-cols-[1.1fr_0.9fr]">
        <div>
          {hero ? (
            <PhotoFrame
              src={photoUrl(supa, hero.path)}
              alt={hero.caption ?? `${room.name} photo`}
              className="aspect-[4/3] w-full rounded-2xl border border-line"
              priority
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex aspect-[4/3] w-full items-center justify-center rounded-2xl border border-line bg-line/40 font-display text-2xl text-muted"
            >
              {room.name}
            </div>
          )}
          {rest.length > 0 ? (
            <ul aria-label={`More photos of ${room.name}`} className="mt-3 grid grid-cols-3 gap-3">
              {rest.map((ph) => (
                <li key={ph.path}>
                  <PhotoFrame
                    src={photoUrl(supa, ph.path)}
                    alt={ph.caption ?? `${room.name} photo`}
                    className="aspect-[4/3] w-full rounded-xl border border-line"
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div>
          <h1 className="font-display text-4xl leading-tight">{room.name}</h1>
          {hotel ? <p className="mt-1 text-sm text-muted">{hotel.name}</p> : null}
          {price ? <p className="mt-3 text-lg font-medium text-primary-strong">{price}</p> : null}
          {room.description ? <p className="mt-4 whitespace-pre-line text-muted">{room.description}</p> : null}
          <p className="mt-4 text-sm text-muted">
            {capacityLabel(room.max_occupancy)} · up to {guests}
          </p>
          {room.amenities.length > 0 ? (
            <ul aria-label="Amenities" className="mt-4 flex flex-wrap gap-2">
              {room.amenities.map((a) => (
                <li key={a} className="rounded-full border border-line bg-white px-3 py-1 text-sm">
                  {a}
                </li>
              ))}
            </ul>
          ) : null}

          <section aria-labelledby="calendar-title" className="mt-6 rounded-2xl border border-line bg-white p-5">
            <h2 id="calendar-title" className="font-medium">
              Price calendar
            </h2>
            <p className="mt-1 text-xs text-muted">The nightly rate for the next {nights.length} nights, before tax.</p>
            <ul className="mt-3 grid grid-cols-2 gap-2 text-center text-sm sm:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5">
              {nights.map((n) => (
                <li key={n.date} className="rounded-lg border border-line px-2 py-1.5">
                  <span className="block text-xs text-muted">{nightDayLabel(n.date)}</span>
                  <span className="block font-medium">{nightPriceLabel(n.rate_minor, currency)}</span>
                </li>
              ))}
            </ul>
          </section>

          <form action="/" method="get" className="mt-6 grid grid-cols-2 gap-4 rounded-2xl border border-line bg-white p-5">
            <h2 className="col-span-2 font-display text-xl">Book this room</h2>
            <input type="hidden" name="type" value={room.room_type_id} />
            <label className={label}>
              Check in
              <input type="date" name="arrival" min={today} required className={`${field} normal-case tracking-normal text-ink`} />
            </label>
            <label className={label}>
              Check out
              <input type="date" name="departure" min={today} required className={`${field} normal-case tracking-normal text-ink`} />
            </label>
            <label className={label}>
              Adults
              <input
                type="number"
                name="adults"
                min={1}
                max={Math.min(20, room.max_adults)}
                defaultValue={Math.min(2, room.max_adults)}
                required
                className={`${field} normal-case tracking-normal text-ink`}
              />
            </label>
            <label className={label}>
              Children
              <input
                type="number"
                name="children"
                min={0}
                max={Math.min(20, room.max_children)}
                defaultValue={0}
                className={`${field} normal-case tracking-normal text-ink`}
              />
            </label>
            <button
              type="submit"
              className="col-span-2 rounded-full bg-primary px-4 py-3 font-medium text-white hover:bg-primary-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {price ? `Check availability · ${nightPriceLabel(room.from_rate_minor, currency)} a night` : "Check availability"}
            </button>
          </form>

          {hotel ? (
            <p className="mt-4 text-sm text-muted">
              {timesLine(hotel)}
              {cancel ? ` · ${cancel}` : ""} ·{" "}
              <Link href="/policies" className="underline underline-offset-2">
                Hotel policies
              </Link>
            </p>
          ) : null}
        </div>
      </div>
    </main>
  );
}
