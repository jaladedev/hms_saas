import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RoomBooking } from "@/components/site/room-booking";
import { RoomGallery } from "@/components/site/room-gallery";
import { SiteBreadcrumbs } from "@/components/site/site-breadcrumbs";
import { capacityLabel, freeCancellationBadge, fromPriceLabel, nightPriceLabel } from "@/lib/guest-site/home";
import { timesLine } from "@/lib/guest-site/hotel";
import { uuidSchema } from "@/lib/guest-site/params";
import { guestHotel, guestPolicy, guestRoomType, guestRoomTypeAvailability, requestHost } from "@/lib/guest-site/server";
import { photoUrl } from "@/lib/staff/room-photos";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Room details" };

type Props = { params: Promise<{ roomTypeId: string }> };

/** One room type in full: every picture, what is in the room, who it sleeps, what a night costs over the next two weeks, and a way to book it. */
export default async function RoomDetails({ params }: Props) {
  const { roomTypeId } = await params;
  if (!uuidSchema.safeParse(roomTypeId).success) notFound();
  const host = await requestHost();
  const [roomResult, hotelResult, policyResult, availResult] = await Promise.all([
    guestRoomType(host, roomTypeId),
    guestHotel(host),
    guestPolicy(host),
    guestRoomTypeAvailability(host, roomTypeId),
  ]);
  if (!roomResult.ok) notFound();
  const { currency, room_type: room } = roomResult.data;
  // Rates and availability are asked for separately. If availability cannot be had, every night stays pickable and the search checks it.
  const free = new Map((availResult.ok ? availResult.data.nights : []).map((n) => [n.date, n.available]));
  const nights = roomResult.data.nights.map((n) => ({ ...n, available: free.get(n.date) }));
  const hotel = hotelResult.ok ? hotelResult.data : null;
  const supa = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const price = fromPriceLabel(room.from_rate_minor, currency);
  const cancel = policyResult.ok ? freeCancellationBadge(policyResult.data) : null;
  const photos = room.photos.map((p) => ({ url: photoUrl(supa, p.path), caption: p.caption }));
  const guests = `${room.max_adults} ${room.max_adults === 1 ? "adult" : "adults"}${room.max_children > 0 ? `, ${room.max_children} ${room.max_children === 1 ? "child" : "children"}` : ""}`;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <SiteBreadcrumbs items={[{ label: "Home", href: "/" }, { label: "Rooms", href: "/#rooms" }, { label: room.name }]} />

      <div className="mt-5 grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <RoomGallery name={room.name} photos={photos} />

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

          <RoomBooking
            typeId={room.room_type_id}
            currency={currency}
            nights={nights}
            maxAdults={room.max_adults}
            maxChildren={room.max_children}
            fromLabel={price ? nightPriceLabel(room.from_rate_minor, currency) : null}
          />

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
