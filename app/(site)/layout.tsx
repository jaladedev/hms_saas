import type { Metadata } from "next";
import Link from "next/link";
import { headerName } from "@/lib/guest-site/hotel";
import { photoUrl } from "@/lib/staff/room-photos";
import { guestHotel, requestHost } from "@/lib/guest-site/server";
import { parseTheme, THEME_WRAPPER_CLASS, themeStyle } from "@/lib/theme";

export const dynamic = "force-dynamic";

/** The hotel behind this host, or null when the host is unknown or the lookup fails (the pages then say so themselves). */
async function loadHotel() {
  const result = await guestHotel(await requestHost());
  return result.ok ? result.data : null;
}

export async function generateMetadata(): Promise<Metadata> {
  const hotel = await loadHotel();
  if (!hotel) return {};
  const name = headerName(hotel);
  return { title: { default: `${name}: book your stay`, template: `%s · ${name}` } };
}

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const hotel = await loadHotel();
  return (
    <div className={`min-h-screen ${THEME_WRAPPER_CLASS}`} style={themeStyle(parseTheme(hotel?.theme))}>
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-4">
          <Link href="/" className="font-display text-xl max-md:inline-flex max-md:min-h-11 max-md:items-center">
            {hotel?.logo ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photoUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", hotel.logo)}
                  alt={headerName(hotel)}
                  className="h-10 max-w-48 object-contain"
                />
              </>
            ) : (
              headerName(hotel)
            )}
          </Link>
          <Link
            href="/booking/find"
            className="shrink-0 text-sm text-primary underline max-md:inline-flex max-md:min-h-11 max-md:items-center"
          >
            Find my booking
          </Link>
        </div>
      </header>
      {children}
    </div>
  );
}
