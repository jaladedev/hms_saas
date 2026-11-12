import { PageSkeleton } from "@/components/ui/skeleton";

/**
 * The loading screen for one list page. It is used as `loading.tsx` next to a page that has no detail pages beneath it, and that
 * never calls notFound() or redirect() itself.
 *
 * Why it is not one `loading.tsx` at the top of an area: a route with a loading file streams. The status line is sent with the first
 * piece, before the page has run, so a page that then calls notFound() has already answered 200 and the visitor gets the
 * not-found text with the wrong status (a tampered booking link, a payment or guest id that does not exist). A loading file covers
 * its own folder and every folder under it, and a deeper one cannot opt out, so loading files go only where nothing below can be
 * not-found. The layouts above a page (sign-in check, hotel switch) run before the stream starts, so a signed-out visitor still gets
 * their 307 to sign in.
 */
export default function PageLoading() {
  return <PageSkeleton label="Loading this page" />;
}
