import type { Metadata } from "next";
import Link from "next/link";
import { SiteNav } from "@/components/site/site-nav";
import { RouteProgress } from "@/components/ui/route-progress";
import { headerName, placeLine, timesLine } from "@/lib/guest-site/hotel";
import { monogram } from "@/lib/guest-site/home";
import { telHref } from "@/lib/staff/hotel-profile";
import { photoUrl } from "@/lib/staff/room-photos";
import { guestHotel, requestHost } from "@/lib/guest-site/server";
import { lookStyle, THEME_WRAPPER_CLASS } from "@/lib/theme";

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

const linkTap = "max-md:inline-flex max-md:min-h-11 max-md:items-center";

export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const hotel = await loadHotel();
  const name = headerName(hotel);
  const place = hotel ? placeLine(hotel) : "";
  const year = new Date().getFullYear();
  return (
    <div
      className={`flex min-h-screen flex-col ${THEME_WRAPPER_CLASS}`}
      style={lookStyle({
        theme: hotel?.theme,
        primary: hotel?.theme_primary,
        fontDisplay: hotel?.font_display,
        fontBody: hotel?.font_body,
      })}
    >
      <RouteProgress />
      <header className="relative border-b border-line bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-4 sm:gap-4">
          <Link href="/" className={`flex min-w-0 items-center gap-3 font-display text-xl ${linkTap}`}>
            {hotel?.logo ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photoUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", hotel.logo)}
                  alt={name}
                  className="h-10 max-w-48 object-contain"
                />
              </>
            ) : (
              <>
                {hotel ? (
                  <span
                    aria-hidden="true"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary font-sans text-base font-semibold text-white"
                  >
                    {monogram(hotel.name)}
                  </span>
                ) : null}
                <span>{name}</span>
              </>
            )}
          </Link>
          {hotel ? <SiteNav /> : null}
          <Link
            href="/booking/find"
            className={`shrink-0 rounded-full border border-ink px-3 py-2 text-sm sm:px-4 hover:bg-ink hover:text-paper focus-visible:outline-2 focus-visible:outline-primary ${linkTap}`}
          >
            Manage booking
          </Link>
        </div>
      </header>
      <div className="flex-1">{children}</div>
      {hotel ? (
        <footer className="mt-16 border-t border-line bg-white text-sm text-muted">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-3">
            <div>
              <p className="font-display text-lg text-ink">{name}</p>
              {place ? <p className="mt-2">{place}</p> : null}
              <p className="mt-2">{timesLine(hotel)}</p>
            </div>
            <div>
              <p className="font-medium text-ink">Contact</p>
              {hotel.phone ? (
                <p className="mt-2">
                  {telHref(hotel.phone) ? (
                    <a href={telHref(hotel.phone) as string} className={`underline ${linkTap}`}>
                      {hotel.phone}
                    </a>
                  ) : (
                    hotel.phone
                  )}
                </p>
              ) : null}
              {hotel.email ? (
                <p className="mt-2 break-all">
                  <a href={`mailto:${hotel.email}`} className={`underline ${linkTap}`}>
                    {hotel.email}
                  </a>
                </p>
              ) : null}
              {!hotel.phone && !hotel.email ? <p className="mt-2">See the contact page.</p> : null}
            </div>
            <nav aria-label="Footer">
              <p className="font-medium text-ink">Guest information</p>
              <ul className="mt-2 space-y-1">
                {[
                  ["/policies", "Hotel policies"],
                  ["/contact", "Contact"],
                  ["/privacy", "Privacy and terms"],
                  ["/booking/find", "Manage my booking"],
                ].map(([href, label]) => (
                  <li key={href}>
                    <Link href={href as string} className={`underline ${linkTap}`}>
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
          <p className="border-t border-line px-4 py-4 text-center text-xs">
            © {year} {name}
          </p>
        </footer>
      ) : null}
    </div>
  );
}
