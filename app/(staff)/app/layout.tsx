import Link from "next/link";
import { redirect } from "next/navigation";
import { Breadcrumbs } from "@/components/staff/breadcrumbs";
import { NavMenu } from "@/components/staff/nav-menu";
import { NavLink } from "@/components/ui/nav-link";
import { RouteProgress } from "@/components/ui/route-progress";
import { signOut } from "@/lib/staff/auth-actions";
import { PropertySwitcher } from "@/components/staff/property-switcher";
import { rememberedProperty } from "@/lib/staff/active-property";
import { pickProperty } from "@/lib/staff/property-choice";
import { badgeText } from "@/lib/staff/notifications";
import { parseDensity } from "@/lib/staff/profile";
import { lookStyle, THEME_WRAPPER_CLASS } from "@/lib/theme";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Items without an href are group headings. `sub` indents an item under its heading; `exact` stops a link lighting up
// for the pages beneath it (Overview would otherwise be lit on every screen).
const NAV: { label: string; href?: string; exact?: boolean; sub?: boolean }[] = [
  { label: "Overview", href: "/app", exact: true },
  { label: "Notifications", href: "/app/notifications" },
  { label: "Front Desk", href: "/app/front-desk" },
  { label: "Reservations", href: "/app/reservations" },
  { label: "Guest requests", href: "/app/requests" },
  { label: "Room Management", href: "/app/rooms" },
  { label: "Guests", href: "/app/guests" },
  { label: "Housekeeping", href: "/app/housekeeping" },
  { label: "Maintenance", href: "/app/maintenance" },
  { label: "Payments & Billing" },
  { label: "Payments to verify", href: "/app/payments", exact: true, sub: true },
  { label: "All payments", href: "/app/payments/all", sub: true },
  { label: "Invoices", href: "/app/invoices", sub: true },
  { label: "Refunds", href: "/app/refunds", sub: true },
  { label: "Reconcile payments", href: "/app/reconciliation", sub: true },
  { label: "Guest emails", href: "/app/emails", sub: true },
  { label: "Reports", href: "/app/reports" },
  { label: "Staff & Permissions", href: "/app/staff" },
  { label: "Settings", href: "/app/settings" },
];

// Every /app route requires a signed-in user. Permission checks happen again in the
// database (RLS and has_permission); this redirect is only the first layer.
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");

  // How many live repairs are assigned to this person. Row level security limits the read to people who may see
  // maintenance, and a failed read shows no badge rather than a wrong number.
  const mineQ = await supabase
    .from("maintenance_requests")
    .select("id", { count: "exact", head: true })
    .in("status", ["open", "in_progress"])
    .eq("assigned_to", data.user.id);
  const myRepairs = mineQ.error ? 0 : (mineQ.count ?? 0);

  // Unread notices for this person. A failed read shows no badge rather than a wrong number.
  const unreadQ = await supabase.rpc("notification_unread_count");
  const unread = unreadQ.error || typeof unreadQ.data !== "number" ? 0 : unreadQ.data;

  // The person's own spacing preference. A failed read, or a person with no profile row yet, gets the standard spacing.
  const profileQ = await supabase.from("user_profiles").select("density").maybeSingle();
  const density = parseDensity((profileQ.data as { density?: string } | null)?.density);

  // The header switcher appears only for people who can see more than one open property. The hotel being worked in also
  // decides the look (its chosen theme, or the standard look when it has not chosen one or the read fails).
  const propsQ = await supabase
    .from("properties")
    .select("id, name, theme, theme_primary, theme_font_display, theme_font_body, theme_radius")
    .eq("status", "active")
    .order("name");
  const switchable = (propsQ.data ?? []) as {
    id: string;
    name: string;
    theme: string | null;
    theme_primary: string | null;
    theme_font_display: string | null;
    theme_font_body: string | null;
    theme_radius: string | null;
  }[];
  const current = pickProperty(switchable, undefined, await rememberedProperty());

  return (
    <div
      className={`flex min-h-screen flex-col md:flex-row print:block print:min-h-0 print:bg-white ${THEME_WRAPPER_CLASS}`}
      style={lookStyle({
        theme: current?.theme,
        primary: current?.theme_primary,
        fontDisplay: current?.theme_font_display,
        fontBody: current?.theme_font_body,
        radius: current?.theme_radius,
      })}
    >
      <RouteProgress />
      <aside className="z-30 shrink-0 bg-navy-900 p-4 text-sm text-white max-md:sticky max-md:top-0 md:sticky md:top-0 md:h-screen md:w-60 print:hidden">
        <NavMenu
          footer={
            <>
              <Link
                href="/app/profile"
                className="block truncate text-white/70 underline-offset-2 hover:text-white hover:underline focus-visible:outline-2 focus-visible:outline-white"
                title={data.user.email ?? undefined}
              >
                {data.user.email}
                <span className="sr-only">, your profile</span>
              </Link>
              <form action={signOut} className="mt-2">
                <button
                  type="submit"
                  className="text-white underline underline-offset-2 hover:text-white/80 focus-visible:outline-2 focus-visible:outline-white"
                >
                  Sign out
                </button>
              </form>
            </>
          }
          brand={<div className="font-display text-xl">HMS</div>}
        >
          <nav aria-label="Main" className="mt-4 text-white/80 md:mt-6">
            {NAV.map((item) =>
              item.href ? (
                <NavLink
                  key={item.label}
                  href={item.href}
                  exact={item.exact}
                  className={`block rounded px-2 py-3 text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white md:py-1.5 ${item.sub ? "md:pl-5" : ""}`}
                  activeClassName="bg-white/15 font-medium"
                >
                  {item.label}
                  {item.href === "/app/notifications" && unread > 0 && (
                    <>
                      <span aria-hidden="true" className="ml-2 rounded-full bg-white/20 px-2 py-0.5 text-xs tabular-nums">
                        {badgeText(unread)}
                      </span>
                      <span className="sr-only">, {unread} unread</span>
                    </>
                  )}
                  {item.href === "/app/maintenance" && myRepairs > 0 && (
                    <>
                      <span aria-hidden="true" className="ml-2 rounded-full bg-white/20 px-2 py-0.5 text-xs tabular-nums">
                        {myRepairs}
                      </span>
                      <span className="sr-only">, {myRepairs} assigned to you</span>
                    </>
                  )}
                </NavLink>
              ) : (
                <div key={item.label} className="px-2 pb-1 pt-4 text-xs uppercase tracking-wide text-white/50 md:pt-3">
                  {item.label}
                </div>
              ),
            )}
          </nav>
          {switchable.length > 1 && current && <PropertySwitcher properties={switchable} currentId={current.id} />}
        </NavMenu>
      </aside>
      <div data-density={density} className="min-w-0 flex-1 p-4 md:p-6 print:p-0">
        <Breadcrumbs />
        {children}
      </div>
    </div>
  );
}
