"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Names for the parts of a staff address. Anything not listed is shown with its words capitalised. */
const LABEL: Record<string, string> = {
  app: "Overview",
  "front-desk": "Front Desk",
  calendar: "Calendar",
  reservations: "Reservations",
  new: "New",
  documents: "Documents",
  settlement: "Settlement",
  requests: "Guest requests",
  rooms: "Room Management",
  guests: "Guests",
  housekeeping: "Housekeeping",
  maintenance: "Maintenance",
  payments: "Payments to verify",
  all: "All payments",
  invoices: "Invoices",
  refunds: "Refunds",
  reconciliation: "Reconcile payments",
  emails: "Guest emails",
  reports: "Reports",
  channels: "Channels",
  occupancy: "Occupancy",
  staff: "Staff & Permissions",
  roles: "Roles",
  settings: "Settings",
  billing: "Billing",
  discounts: "Discounts",
  history: "Setup history",
  hotel: "Hotel details",
  offers: "Offers",
  policies: "Policies",
  rates: "Rates",
  reviews: "Reviews",
  tax: "Tax rules",
  setup: "Guided setup",
  profile: "Profile",
  notifications: "Notifications",
};

/** Whole-address names where the same word means something else in another place (Rooms under Settings is the room setup). */
const PATH_LABEL: Record<string, string> = {
  "/app/settings/rooms": "Room types and rooms",
  "/app/settings/policies": "Policies",
};

/** A page that takes an id after these words is named for what the id is. */
const ID_LABEL: Record<string, string> = {
  rooms: "Room details",
  guests: "Guest",
  reservations: "Reservation",
  maintenance: "Repair",
  payments: "Payment",
  "folio-invoice": "Invoice",
};

/** Addresses that have no page of their own, so they are shown as plain words, not links. */
const NO_PAGE = new Set(["/app/reservations/ID/folio-invoice"]);

export type Crumb = { label: string; href: string };

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, " ");

/** The trail for a staff address: Overview, then one entry per part. Empty on the overview itself. */
export function crumbsFor(pathname: string): Crumb[] {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "app" || parts.length < 2) return [];
  const out: Crumb[] = [];
  for (let i = 0; i < parts.length; i++) {
    const href = "/" + parts.slice(0, i + 1).join("/");
    const part = parts[i] as string;
    const parent = parts[i - 1];
    const known = PATH_LABEL[href] ?? LABEL[part];
    const label = known ?? (parent && ID_LABEL[parent] ? ID_LABEL[parent] : title(part));
    out.push({ label, href });
  }
  return out;
}

function hasPage(href: string): boolean {
  const generic = href
    .split("/")
    .map((p, i, all) => (i > 0 && ID_LABEL[all[i - 1] as string] && !LABEL[p] ? "ID" : p))
    .join("/");
  return !NO_PAGE.has(generic);
}

/** The trail across the top of a staff page. The last entry is the page you are on; the others link back up. */
export function Breadcrumbs() {
  const crumbs = crumbsFor(usePathname() ?? "");
  if (crumbs.length < 2) return null;
  return (
    <nav aria-label="Breadcrumb" className="mb-4 text-sm print:hidden">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={c.href} className="flex items-center gap-1.5">
              {i > 0 ? (
                <span aria-hidden="true" className="text-line">
                  /
                </span>
              ) : null}
              {last ? (
                <span aria-current="page" className="font-medium text-ink">
                  {c.label}
                </span>
              ) : hasPage(c.href) ? (
                <Link
                  href={c.href}
                  className="underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-primary"
                >
                  {c.label}
                </Link>
              ) : (
                <span>{c.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
