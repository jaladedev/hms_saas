/**
 * The staff sidebar's links, grouped, and the pure rules around them (which group holds the page being shown, what a typed query
 * matches, how a collapsed group sums its badges). The sidebar component keeps only the open or closed state; everything that can be
 * wrong lives here so it can be tested. Every link is still shown to everyone who is signed in: pages and the database check rights
 * themselves, as before.
 */

export type NavItem = { label: string; href: string; exact?: boolean };
export type NavGroup = { id: string; label: string; items: NavItem[] };

/** Overview is on its own at the top: it is the home page, and `exact` stops it lighting up on every screen. */
export const NAV_HOME: NavItem = { label: "Overview", href: "/app", exact: true };

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "front",
    label: "Front desk",
    items: [
      { label: "Notifications", href: "/app/notifications" },
      { label: "Front Desk", href: "/app/front-desk" },
      { label: "Reservations", href: "/app/reservations" },
      { label: "Groups", href: "/app/groups" },
      { label: "Guest requests", href: "/app/requests" },
      { label: "Waiting list", href: "/app/waitlist" },
      { label: "Guest messages", href: "/app/messages" },
    ],
  },
  {
    id: "rooms",
    label: "Rooms & guests",
    items: [
      { label: "Room Management", href: "/app/rooms" },
      { label: "Guests", href: "/app/guests" },
      { label: "Housekeeping", href: "/app/housekeeping" },
      { label: "Maintenance", href: "/app/maintenance" },
    ],
  },
  {
    id: "services",
    label: "Services",
    items: [
      { label: "Experiences", href: "/app/experiences" },
      { label: "Restaurant & bar", href: "/app/pos" },
      { label: "Stock", href: "/app/inventory" },
      { label: "Spa, gym & laundry", href: "/app/services" },
      { label: "Events", href: "/app/events" },
    ],
  },
  {
    id: "money",
    label: "Money & reports",
    items: [
      { label: "Payments to verify", href: "/app/payments", exact: true },
      { label: "All payments", href: "/app/payments/all" },
      { label: "Invoices", href: "/app/invoices" },
      { label: "Refunds", href: "/app/refunds" },
      { label: "Reconcile payments", href: "/app/reconciliation" },
      { label: "Guest emails", href: "/app/emails" },
      { label: "Night audit", href: "/app/night-audit" },
      { label: "Reports", href: "/app/reports" },
    ],
  },
  {
    id: "team",
    label: "Team & setup",
    items: [
      { label: "Shifts & leave", href: "/app/hr" },
      { label: "Channels", href: "/app/channels" },
      { label: "Staff & Permissions", href: "/app/staff" },
      { label: "Settings", href: "/app/settings" },
    ],
  },
];

/** Same rule as NavLink: the exact page, or (unless `exact`) anything beneath it. */
export function navMatches(pathname: string, item: NavItem): boolean {
  if (pathname === item.href) return true;
  return !item.exact && pathname.startsWith(`${item.href}/`);
}

/** The most specific link for a page: /app/payments/all lights "All payments", not "Payments to verify" (which is `exact`). */
export function activeNavItem(pathname: string, groups: NavGroup[] = NAV_GROUPS): NavItem | null {
  const all = [NAV_HOME, ...groups.flatMap((g) => g.items)];
  let best: NavItem | null = null;
  for (const item of all) {
    if (navMatches(pathname, item) && (!best || item.href.length > best.href.length)) best = item;
  }
  return best;
}

/** The group that holds the page being shown, so the sidebar opens it. Null on Overview or a page with no link. */
export function groupIdForPath(pathname: string, groups: NavGroup[] = NAV_GROUPS): string | null {
  const active = activeNavItem(pathname, groups);
  if (!active) return null;
  return groups.find((g) => g.items.some((i) => i.href === active.href))?.id ?? null;
}

export type NavHit = NavItem & { group: string | null };

/** Links whose name contains every word typed (any order, any case); the group name counts too, so "money" lists them all. */
export function matchNav(query: string, groups: NavGroup[] = NAV_GROUPS): NavHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const all: NavHit[] = [{ ...NAV_HOME, group: null }, ...groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label })))];
  return all.filter((h) => {
    const hay = `${h.label} ${h.group ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The sum of the badges inside a group, shown on its heading while it is collapsed. */
export function groupBadgeTotal(group: NavGroup, badges: Record<string, number>): number {
  return group.items.reduce((sum, i) => sum + (badges[i.href] ?? 0), 0);
}
