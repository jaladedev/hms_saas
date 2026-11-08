import Link from "next/link";
import { redirect } from "next/navigation";
import { NavMenu } from "@/components/staff/nav-menu";
import { signOut } from "@/lib/staff/auth-actions";
import { PropertySwitcher } from "@/components/staff/property-switcher";
import { rememberedProperty } from "@/lib/staff/active-property";
import { pickProperty } from "@/lib/staff/property-choice";
import { badgeText } from "@/lib/staff/notifications";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Items without an href are placeholders until their phase lands.
const NAV: { label: string; href?: string }[] = [
  { label: "Overview", href: "/app" },
  { label: "Notifications", href: "/app/notifications" },
  { label: "Front Desk", href: "/app/front-desk" },
  { label: "Reservations", href: "/app/reservations" },
  { label: "Guest requests", href: "/app/requests" },
  { label: "Room Management", href: "/app/rooms" },
  { label: "Guests", href: "/app/guests" },
  { label: "Housekeeping", href: "/app/housekeeping" },
  { label: "Maintenance", href: "/app/maintenance" },
  { label: "Payments & Billing" },
  { label: "Payments to verify", href: "/app/payments" },
  { label: "Refunds", href: "/app/refunds" },
  { label: "Reconcile payments", href: "/app/reconciliation" },
  { label: "Guest emails", href: "/app/emails" },
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

  // The header switcher appears only for people who can see more than one open property.
  const propsQ = await supabase.from("properties").select("id, name").eq("status", "active").order("name");
  const switchable = (propsQ.data ?? []) as { id: string; name: string }[];
  const current = pickProperty(switchable, undefined, await rememberedProperty());

  return (
    <div className="flex min-h-screen flex-col md:flex-row print:block print:min-h-0">
      <aside className="shrink-0 bg-navy-900 p-4 text-sm text-white md:w-60 print:hidden">
        <NavMenu brand={<div className="font-display text-xl">HMS</div>}>
          <nav className="mt-6 space-y-0 text-white/80 md:space-y-2">
            {NAV.map((item) =>
              item.href ? (
                <Link key={item.label} href={item.href} className="block py-3 text-white focus-visible:outline-2 focus-visible:outline-white md:py-0">
                  {item.label}
                  {item.href === "/app/notifications" && unread > 0 && (
                    <>
                      <span aria-hidden="true" className="ml-2 rounded-full bg-white/20 px-2 py-0.5 text-xs tabular-nums">{badgeText(unread)}</span>
                      <span className="sr-only">, {unread} unread</span>
                    </>
                  )}
                  {item.href === "/app/maintenance" && myRepairs > 0 && (
                    <>
                      <span aria-hidden="true" className="ml-2 rounded-full bg-white/20 px-2 py-0.5 text-xs tabular-nums">{myRepairs}</span>
                      <span className="sr-only">, {myRepairs} assigned to you</span>
                    </>
                  )}
                </Link>
              ) : (
                <div key={item.label} className="py-3 md:py-0">{item.label}</div>
              ),
            )}
          </nav>
          {switchable.length > 1 && current && <PropertySwitcher properties={switchable} currentId={current.id} />}
          <div className="mt-10 border-t border-white/15 pt-4">
            <p className="truncate text-white/70" title={data.user.email ?? undefined}>{data.user.email}</p>
            <form action={signOut} className="mt-2">
              <button type="submit" className="text-white underline underline-offset-2 hover:text-white/80 focus-visible:outline-2 focus-visible:outline-white">Sign out</button>
            </form>
          </div>
        </NavMenu>
      </aside>
      <div className="min-w-0 flex-1 p-4 md:p-6 print:p-0">{children}</div>
    </div>
  );
}
