import type { GuestHotel } from "@/lib/guest-site/hotel";
import { monogram } from "@/lib/guest-site/home";

/** What the sign-in page shows of the hotel behind this address: its name, and its logo if it has one. */
export type LoginBrand = { name: string; mark: string; logo: string | null };

/**
 * The hotel to show on the sign-in page, from the same public answer the guest site uses for this host (`guest_hotel`), or null
 * when the address is not a hotel's (the platform's own address, an unknown host, a failed lookup): the page then keeps the plain
 * "HMS" heading it had before. Only the name and the logo's storage path are taken; the look (colours, fonts, corners) is read
 * from the same answer by the page with `lookStyle`. A blank name counts as no hotel, so a half-set-up hotel never shows an empty
 * heading.
 */
export function loginBrand(hotel: Pick<GuestHotel, "name" | "logo"> | null | undefined): LoginBrand | null {
  const name = typeof hotel?.name === "string" ? hotel.name.trim() : "";
  if (!name) return null;
  const logo = typeof hotel?.logo === "string" && hotel.logo.trim() ? hotel.logo.trim() : null;
  return { name, mark: monogram(name), logo };
}
